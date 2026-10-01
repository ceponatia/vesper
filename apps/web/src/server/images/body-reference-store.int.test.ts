import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { emptyCharacterProfile, referenceViewBodySetKey, VISUAL_IMAGE_AGE_ATTRIBUTE_ID, type ReferenceView } from "@/contracts";
import { characterBodyReferences, characters, db, images, jobs } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser, testPngBuffer, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { createImageAsset, saveImageBuffer } from "./asset-storage";
import {
  currentSendableBodyReferences,
  getBodyReferenceSet,
} from "./body-reference-store";
import { installBodyReference, removeBodyReference, retagBodyReference } from "./body-reference-writes";
import { referenceViewSweepPass } from "./reference-view-maintenance";
import {
  claimReferenceViewLeases,
  finalizeReferenceView,
  getReferenceViewSummary,
  installUploadedReferenceView,
  readAcceptedPortraitSource,
  REFERENCE_VIEW_RETENTION_MS,
  reserveReferenceView,
  restoreReferenceView,
  reviewReferenceView,
} from "./reference-view-store";

/**
 * Body reference images (#671) against a migrated database: the claims that
 * depend on the character lock, the stored rows and the projection reading them.
 *
 * 1. **Writes name the image the owner saw.** A replace, re-tag or remove that
 *    crossed another write is refused, a replaced image's row is retired rather
 *    than rewritten, and an undressed tag is refused below the adult gate.
 * 2. **The staleness rule, in the store.** A rendered view goes stale the moment
 *    the character's body-image set moves — without a job, without a charge —
 *    a reservation from the old set renders nothing, and neither approval nor
 *    restoration can bring back an attempt rendered against another set. An
 *    uploaded view is never stale by it.
 * 3. **Retention.** A retired image's asset and row are collected after the
 *    window; the image in use is never touched.
 */

const ready = await probeIntegrationDb("body reference store.int.test", "character_body_references");
const ROOT: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
let ownerId = "";
let temp: TempDataRoot | undefined;

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-body-reference-int");
  ownerId = (await seedTestUser("body-reference")).id;
});
afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await temp?.cleanup();
  await endTestPool();
});

function profileWithAge(band: string) {
  return { ...emptyCharacterProfile(), attributes: [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: band, source: "creation" as const }] };
}

async function asset(characterId: string, kind: "avatar" | "reference_view" | "body_reference") {
  const row = await createImageAsset({ ownerId, kind, entityKind: "character", entityId: characterId });
  const saved = await saveImageBuffer(row.id, await testPngBuffer());
  if (!saved || saved.status !== "ready") throw new Error("fixture image failed to save");
  return saved;
}

/** An adult character with an accepted portrait, and a way to render its root view at any body-image set. */
async function fixture(band = "eighteen") {
  const [character] = await db().insert(characters).values({ ownerId, name: "Body reference fixture", profile: profileWithAge(band) }).returning();
  if (!character) throw new Error("fixture character insert failed");
  const portrait = await asset(character.id, "avatar");
  await db().update(characters).set({ acceptedAvatarImageId: portrait.id, acceptedAt: new Date() }).where(eq(characters.id, character.id));
  const source = await readAcceptedPortraitSource(character.id, ownerId);
  if (!source.ok) throw new Error("fixture portrait unreadable");
  const characterId = character.id;
  const claim = async (view: ReferenceView = ROOT) => {
    const [job] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status: "running", payload: { characterId, targets: [], leases: [] },
    }).returning({ id: jobs.id });
    if (!job) throw new Error("fixture job insert failed");
    const leases = await claimReferenceViewLeases({ characterId, ownerId, jobId: job.id, targets: [view] });
    if (leases.claimed.length !== 1) throw new Error("fixture lease claim failed");
    return job.id;
  };
  const reserve = (jobId: string, bodyReferenceSet: string | null, view: ReferenceView = ROOT, upstreamViewId: string | null = null) =>
    reserveReferenceView({
      jobId, characterId, ownerId, view, sourceImageId: source.imageId, sourceContentHash: source.contentHash, bodyReferenceSet, upstreamViewId,
    });
  /** A rendered, approved view recording `bodyReferenceSet`, built from `upstreamViewId`. */
  const render = async (view: ReferenceView, bodyReferenceSet: string | null, upstreamViewId: string | null = null) => {
    const jobId = await claim(view);
    const id = await reserve(jobId, bodyReferenceSet, view, upstreamViewId);
    if (id === null) throw new Error("fixture reservation refused");
    const image = await asset(characterId, "reference_view");
    await finalizeReferenceView({ jobId, viewId: id, characterId, ownerId, imageId: image.id, method: "rendered", upstreamViewId });
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, jobId));
    const approval = await reviewReferenceView({ characterId, ownerId, view, attemptId: id, expectedRevision: 0, verdict: "approve" });
    if (approval.status !== "reviewed") throw new Error(`fixture approval refused: ${approval.status}`);
    return id;
  };
  const renderRoot = (bodyReferenceSet: string | null) => render(ROOT, bodyReferenceSet);
  /** The key a view in `wardrobe` would record over the character's images now. */
  const currentKey = async (wardrobe: "clothed" | "bare") =>
    referenceViewBodySetKey(wardrobe, await currentSendableBodyReferences(characterId, profileWithAge(band)));
  const addBody = async (slot: 1 | 2, tag: "clothed" | "unclothed", expectedImageId: string | null = null) => {
    const image = await asset(characterId, "body_reference");
    const result = await installBodyReference({ characterId, ownerId, slot, imageId: image.id, tag, expectedImageId });
    return { image, result };
  };
  return { characterId, source, claim, reserve, render, renderRoot, currentKey, addBody };
}

async function bodyRows(characterId: string) {
  return db().select().from(characterBodyReferences).where(eq(characterBodyReferences.characterId, characterId));
}

describe.skipIf(!ready)("body reference writes", () => {
  it("fills a slot, replaces only the image the owner saw, and retires what it replaced", async () => {
    const state = await fixture();
    const first = await state.addBody(1, "clothed");
    expect(first.result.status).toBe("written");

    // A second "add" into the same slot crossed the first: refused, nothing written.
    const crossed = await state.addBody(1, "clothed", null);
    expect(crossed.result.status).toBe("changed");

    const replacement = await state.addBody(1, "unclothed", first.image.id);
    expect(replacement.result).toMatchObject({ status: "written", set: { images: [{ slot: 1, imageId: replacement.image.id, tag: "unclothed" }] } });
    const rows = await bodyRows(state.characterId);
    expect(rows.filter((row) => row.current).map((row) => row.imageId)).toEqual([replacement.image.id]);
    expect(rows.find((row) => row.imageId === first.image.id)?.current).toBe(false);
  });

  it("re-tags and removes only the image the owner saw", async () => {
    const state = await fixture();
    const { image } = await state.addBody(2, "unclothed");

    expect((await retagBodyReference({ characterId: state.characterId, ownerId, slot: 2, tag: "clothed", expectedImageId: "img-elsewhere" })).status).toBe("changed");
    expect(await retagBodyReference({ characterId: state.characterId, ownerId, slot: 2, tag: "clothed", expectedImageId: image.id }))
      .toMatchObject({ status: "written", set: { images: [{ slot: 2, tag: "clothed" }] } });

    expect((await removeBodyReference({ characterId: state.characterId, ownerId, slot: 1, expectedImageId: image.id })).status).toBe("changed");
    expect(await removeBodyReference({ characterId: state.characterId, ownerId, slot: 2, expectedImageId: image.id }))
      .toMatchObject({ status: "written", set: { images: [] } });
    expect((await bodyRows(state.characterId)).every((row) => !row.current)).toBe(true);
  });

  it("refuses an undressed image below the adult gate, and withholds a stored one when the age moves", async () => {
    const minor = await fixture("teen");
    expect((await minor.addBody(1, "unclothed")).result.status).toBe("ineligible");
    const dressed = await minor.addBody(1, "clothed");
    expect((await retagBodyReference({ characterId: minor.characterId, ownerId, slot: 1, tag: "unclothed", expectedImageId: dressed.image.id })).status)
      .toBe("ineligible");

    const adult = await fixture();
    await adult.addBody(1, "unclothed");
    await db().update(characters).set({ profile: profileWithAge("teen") }).where(eq(characters.id, adult.characterId));
    const set = await getBodyReferenceSet(adult.characterId, ownerId);
    expect(set).toMatchObject({ unclothedAllowed: false, images: [{ slot: 1, tag: "unclothed", withheld: true }] });
  });

  /**
   * A body-image write during a live build would strand its renders — the ones
   * not yet reserved are charged and render nothing, the ones rendering land
   * stale — so every write waits, exactly as the view upload does.
   */
  it.each(["queued", "running"] as const)("refuses every write while a %s reference-view build holds a lease", async (status) => {
    const state = await fixture();
    const first = await state.addBody(1, "clothed");
    const [job] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status, payload: {
        characterId: state.characterId, targets: [`${ROOT.angle}:${ROOT.wardrobe}`], leases: [{ ...ROOT, attemptId: null }],
      },
    }).returning({ id: jobs.id });
    if (!job) throw new Error("fixture job insert failed");
    try {
      expect((await state.addBody(2, "clothed")).result.status).toBe("busy");
      expect((await state.addBody(1, "clothed", first.image.id)).result.status).toBe("busy");
      expect((await retagBodyReference({ characterId: state.characterId, ownerId, slot: 1, tag: "unclothed", expectedImageId: first.image.id })).status)
        .toBe("busy");
      expect((await removeBodyReference({ characterId: state.characterId, ownerId, slot: 1, expectedImageId: first.image.id })).status)
        .toBe("busy");
      expect((await bodyRows(state.characterId)).filter((row) => row.current).map((row) => [row.imageId, row.tag]))
        .toEqual([[first.image.id, "clothed"]]);
    } finally {
      await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, job.id));
    }
    // Settled, the same write goes through.
    expect((await state.addBody(2, "clothed")).result.status).toBe("written");
  });

  it("answers a foreign owner as a character with no images", async () => {
    const state = await fixture();
    await state.addBody(1, "clothed");
    const stranger = (await seedTestUser("body-reference-stranger")).id;
    try {
      expect((await getBodyReferenceSet(state.characterId, stranger)).images).toEqual([]);
      expect((await removeBodyReference({ characterId: state.characterId, ownerId: stranger, slot: 1, expectedImageId: "x" })).status).toBe("not_found");
    } finally {
      await purgeOwnerRows([stranger]);
    }
  });
});

describe.skipIf(!ready)("the body-image staleness rule in the store", () => {
  it("makes a rendered view stale on a body-image change, without a job or a charge, and refuses the old set's reservation", async () => {
    const state = await fixture();
    const rootId = await state.renderRoot(null);
    expect(await getReferenceViewSummary(state.characterId, ownerId, ROOT)).toMatchObject({ state: "approved", consumable: true });
    const jobsBefore = await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, ownerId));

    await state.addBody(1, "clothed");

    expect(await getReferenceViewSummary(state.characterId, ownerId, ROOT)).toMatchObject({ attemptId: rootId, state: "stale", consumable: false });
    expect(await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, ownerId))).toHaveLength(jobsBefore.length);

    const current = await state.currentKey("clothed");
    expect(current).not.toBeNull();
    // A worker that read the empty set before the change renders nothing.
    const staleJob = await state.claim();
    expect(await state.reserve(staleJob, null)).toBeNull();
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, staleJob));
    // A view rendered against the set now is current again.
    await state.renderRoot(current);
    expect((await getReferenceViewSummary(state.characterId, ownerId, ROOT)).state).toBe("approved");
  });

  it("refuses to restore an attempt rendered against another body-image set", async () => {
    const state = await fixture();
    const before = await state.renderRoot(null);
    await state.addBody(1, "clothed");
    const current = await state.currentKey("clothed");
    const after = await state.renderRoot(current);

    const result = await restoreReferenceView({
      characterId: state.characterId, ownerId, view: ROOT, attemptId: before, expectedCurrentAttemptId: after, expectedCurrentRevision: 1,
    });
    expect(result.status).toBe("incompatible");
  });

  /**
   * The per-view key: an undressed view is keyed by the unclothed images alone,
   * so a Clothed image's change leaves it standing. Built from an UPLOADED
   * dressed view, which no body image stales, so the build-order chain cannot
   * cover for a whole-set key here.
   */
  it("stales an undressed view on an unclothed image's change only, even beside an uploaded dressed view", async () => {
    const state = await fixture();
    const frontBare: ReferenceView = { angle: "front_full", wardrobe: "bare" };
    const image = await asset(state.characterId, "reference_view");
    const uploaded = await installUploadedReferenceView({
      characterId: state.characterId, ownerId, view: ROOT, sourceImageId: state.source.imageId,
      sourceContentHash: state.source.contentHash, imageId: image.id, expectedCurrentAttemptId: null, expectedCurrentRevision: 0,
    });
    if (uploaded.status !== "uploaded" || uploaded.view.attemptId === null) throw new Error("fixture upload refused");
    const bareId = await state.render(frontBare, null, uploaded.view.lineageId ?? uploaded.view.attemptId);
    expect(await getReferenceViewSummary(state.characterId, ownerId, frontBare)).toMatchObject({ attemptId: bareId, state: "approved" });

    const clothed = await state.addBody(1, "clothed");
    expect(clothed.result.status).toBe("written");
    expect(await getReferenceViewSummary(state.characterId, ownerId, ROOT)).toMatchObject({ state: "approved" });
    expect(await getReferenceViewSummary(state.characterId, ownerId, frontBare)).toMatchObject({ state: "approved", consumable: true });

    await state.addBody(2, "unclothed");
    expect(await getReferenceViewSummary(state.characterId, ownerId, frontBare)).toMatchObject({ state: "stale", consumable: false });
    expect(await state.currentKey("bare")).not.toBeNull();
  });

  it("never marks an uploaded view stale by the body images", async () => {
    const state = await fixture();
    const image = await asset(state.characterId, "reference_view");
    const uploaded = await installUploadedReferenceView({
      characterId: state.characterId, ownerId, view: ROOT, sourceImageId: state.source.imageId,
      sourceContentHash: state.source.contentHash, imageId: image.id, expectedCurrentAttemptId: null, expectedCurrentRevision: 0,
    });
    expect(uploaded.status).toBe("uploaded");

    await state.addBody(1, "clothed");

    expect(await getReferenceViewSummary(state.characterId, ownerId, ROOT)).toMatchObject({ state: "approved", consumable: true });
  });
});

describe.skipIf(!ready)("body image retention", () => {
  it("collects a retired image after the window and never the one in use", async () => {
    const state = await fixture();
    const first = await state.addBody(1, "clothed");
    const second = await state.addBody(1, "clothed", first.image.id);
    await db()
      .update(characterBodyReferences)
      .set({ updatedAt: new Date(Date.now() - REFERENCE_VIEW_RETENTION_MS - 60_000) })
      .where(and(eq(characterBodyReferences.characterId, state.characterId), eq(characterBodyReferences.current, false)));

    const counts = await referenceViewSweepPass();

    expect(counts.bodyReferenceAssetsPurged).toBeGreaterThanOrEqual(1);
    expect(await db().select({ id: images.id }).from(images).where(eq(images.id, first.image.id))).toEqual([]);
    expect((await bodyRows(state.characterId)).map((row) => row.imageId)).toEqual([second.image.id]);
    expect(await db().select({ id: images.id }).from(images).where(eq(images.id, second.image.id))).toHaveLength(1);
  });
});
