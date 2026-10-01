import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  emptyCharacterProfile,
  REFERENCE_VIEW_GENERATION_VERSION,
  referenceViewDependents,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type ReferenceView,
} from "@/contracts";
import { readDailyUsage } from "@/server/api";
import { characterReferenceViews, characters, db, JOB_STALE_MS, jobs } from "@/server/db";
import {
  endTestPool,
  expectApiError,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import {
  queueReferenceViewBuild,
  queueReviewDependents,
  regenerateReferenceViews,
} from "../../app/api/characters/[id]/reference-views/shared";
import { createImageAsset, saveImageBuffer } from "./asset-storage";
import {
  claimReferenceViewLeases,
  currentReferenceViewRow,
  finalizeReferenceView,
  getReferenceViewSummary,
  readAcceptedPortraitSource,
  reconcileExpiredReferenceViewWork,
  reserveReferenceView,
  reviewReferenceView,
  REFERENCE_VIEW_LEASE_EXPIRED,
} from "./reference-view-store";

// This suite kills the character-wide single-flight regression. Every claim,
// heartbeat cutoff, fenced write and charge assertion depends on real rows and
// transaction serialization, so it belongs in the CI-selected engine suite.
const ready = await probeIntegrationDb("reference view leases.int.test", "character_reference_views");
const front: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
const side: ReferenceView = { angle: "side_left", wardrobe: "clothed" };
const sideBare: ReferenceView = { angle: "side_left", wardrobe: "bare" };
const right: ReferenceView = { angle: "side_right", wardrobe: "clothed" };
let ownerId = "";
let temp: TempDataRoot | undefined;

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-reference-leases-int");
  ownerId = (await seedTestUser("reference-leases")).id;
});

afterEach(async () => {
  if (!ready || !ownerId) return;
  await db()
    .update(jobs)
    .set({ status: "done", finishedAt: new Date() })
    .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.status, ["queued", "running"])));
});

afterAll(async () => {
  if (ready) await purgeOwnerRows([ownerId]);
  await temp?.cleanup();
  await endTestPool();
});

function adultProfile() {
  return {
    ...emptyCharacterProfile(),
    attributes: [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: "eighteen", source: "creation" as const }],
  };
}

async function fixture() {
  const [character] = await db()
    .insert(characters)
    .values({ ownerId, name: "Reference lease fixture", profile: adultProfile() })
    .returning({ id: characters.id });
  if (!character) throw new Error("fixture character insert failed");
  const portrait = await createImageAsset({ ownerId, kind: "avatar", entityKind: "character", entityId: character.id });
  const saved = await saveImageBuffer(portrait.id, await testPngBuffer());
  if (!saved || saved.status !== "ready") throw new Error("fixture portrait failed to save");
  await db()
    .update(characters)
    .set({ acceptedAvatarImageId: portrait.id, acceptedAt: new Date() })
    .where(eq(characters.id, character.id));
  const source = await readAcceptedPortraitSource(character.id, ownerId);
  if (!source.ok) throw new Error("fixture portrait unreadable");
  return { characterId: character.id, source };
}

async function job(characterId: string, heartbeatAt = new Date()): Promise<string> {
  const [row] = await db()
    .insert(jobs)
    .values({
      ownerId,
      type: "reference_views",
      status: "running",
      heartbeatAt,
      payload: { characterId, targets: [], leases: [] },
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("fixture job insert failed");
  return row.id;
}

async function reserve(characterId: string, source: { imageId: string; contentHash: string }, jobId: string, view: ReferenceView) {
  return reserveReferenceView({
    jobId,
    characterId,
    ownerId,
    view,
    sourceImageId: source.imageId,
    sourceContentHash: source.contentHash,
  });
}

/** A finished, unreviewed attempt in the root slot, with readable bytes a review can check. */
async function unreviewedFront(characterId: string, source: { imageId: string; contentHash: string }): Promise<string> {
  const jobId = await job(characterId);
  await claimReferenceViewLeases({ characterId, ownerId, jobId, targets: [front] });
  const attempt = await reserve(characterId, source, jobId, front);
  if (attempt === null) throw new Error("root attempt was not reserved");
  const produced = await createImageAsset({ ownerId, kind: "reference_view", entityKind: "character", entityId: characterId });
  const saved = await saveImageBuffer(produced.id, await testPngBuffer());
  if (!saved || saved.status !== "ready") throw new Error("fixture view failed to save");
  await finalizeReferenceView({ jobId, viewId: attempt, characterId, ownerId, imageId: produced.id, method: "rendered" });
  await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, jobId));
  return attempt;
}

function routeRequest(characterId: string): NextRequest {
  return new NextRequest(`https://vesper.test/api/characters/${characterId}/reference-views/front_full/clothed/review`, {
    method: "POST",
  });
}

const slotKeys = (views: readonly ReferenceView[]): string[] => views.map((view) => `${view.angle}:${view.wardrobe}`).sort();

describe.skipIf(!ready)("reference view per-slot leases", () => {
  it("serializes overlapping claims while admitting disjoint and partially overlapping targets", async () => {
    const state = await fixture();
    const firstJob = await job(state.characterId);
    const secondJob = await job(state.characterId);
    const [first, second] = await Promise.all([
      claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: firstJob, targets: [front] }),
      claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: secondJob, targets: [front] }),
    ]);
    expect([first.claimed.length, second.claimed.length].sort()).toEqual([0, 1]);
    expect([first.busy.length, second.busy.length].sort()).toEqual([0, 1]);

    const winnerJob = first.claimed.length === 1 ? firstJob : secondJob;
    const winnerAttempt = await reserve(state.characterId, state.source, winnerJob, front);
    expect(winnerAttempt).not.toBeNull();
    const [ownedAttempt] = await db().select({ payload: jobs.payload }).from(jobs).where(eq(jobs.id, winnerJob));
    expect(ownedAttempt?.payload).toEqual(expect.objectContaining({
      referenceViewAttemptIds: [winnerAttempt],
    }));

    // Partial and disjoint admission, on a sheet whose building slot is a side
    // view: every slot is built from the front, so a building front would put
    // the whole sheet on its line (the build-order case below).
    const sideState = await fixture();
    const sideJob = await job(sideState.characterId);
    expect((await claimReferenceViewLeases({
      characterId: sideState.characterId, ownerId, jobId: sideJob, targets: [side],
    })).claimed).toHaveLength(1);

    const partialJob = await job(sideState.characterId);
    const partial = await claimReferenceViewLeases({
      characterId: sideState.characterId,
      ownerId,
      jobId: partialJob,
      targets: [side, back],
    });
    expect(partial.busy).toEqual([side]);
    expect(partial.claimed).toEqual([{ ...back, attemptId: null }]);

    const disjointJob = await job(sideState.characterId);
    const disjoint = await claimReferenceViewLeases({
      characterId: sideState.characterId,
      ownerId,
      jobId: disjointJob,
      targets: [right],
    });
    expect(disjoint.claimed).toEqual([{ ...right, attemptId: null }]);
  });

  // The build order under the claim's own lock (#670 review): two requests that
  // each passed the route's pre-admission checks — one rebuilding an approved
  // upstream, one its dependent — used to lease both, because only identical
  // slots conflicted. The dependent then rendered against the upstream being
  // replaced (paid, and stale on arrival) or was refused after its charge.
  it("never leases two slots on one line of the build order at once, whoever claims first", async () => {
    const state = await fixture();
    const upstreamJob = await job(state.characterId);
    const dependentJob = await job(state.characterId);
    const [upstream, dependent] = await Promise.all([
      claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: upstreamJob, targets: [front] }),
      claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: dependentJob, targets: [back] }),
    ]);
    expect([upstream.claimed.length, dependent.claimed.length].sort()).toEqual([0, 1]);

    // Through every level, in both directions: the side view building blocks
    // the view built from it and the view it is built from, and leaves an
    // unrelated angle alone.
    const lineState = await fixture();
    const sideJob = await job(lineState.characterId);
    expect((await claimReferenceViewLeases({
      characterId: lineState.characterId, ownerId, jobId: sideJob, targets: [side],
    })).claimed).toHaveLength(1);
    const lineJob = await job(lineState.characterId);
    const line = await claimReferenceViewLeases({
      characterId: lineState.characterId, ownerId, jobId: lineJob, targets: [sideBare, front, back],
    });
    expect(line.busy).toEqual([sideBare, front]);
    expect(line.claimed).toEqual([{ ...back, attemptId: null }]);
  });

  it("reclaims an expired attempt and fences its late finalization behind the newer current row", async () => {
    const state = await fixture();
    const oldJob = await job(state.characterId);
    expect((await claimReferenceViewLeases({
      characterId: state.characterId,
      ownerId,
      jobId: oldJob,
      targets: [front],
    })).claimed).toHaveLength(1);
    const oldAttempt = await reserve(state.characterId, state.source, oldJob, front);
    if (oldAttempt === null) throw new Error("old attempt was not reserved");

    const expired = new Date(Date.now() - JOB_STALE_MS - 60_000);
    await db().update(jobs).set({ heartbeatAt: expired }).where(eq(jobs.id, oldJob));
    const newJob = await job(state.characterId);
    const reclaimed = await claimReferenceViewLeases({
      characterId: state.characterId,
      ownerId,
      jobId: newJob,
      targets: [front],
    });
    expect(reclaimed.claimed).toEqual([{ ...front, attemptId: null }]);
    const [abandoned] = await db()
      .select()
      .from(characterReferenceViews)
      .where(eq(characterReferenceViews.id, oldAttempt));
    expect(abandoned).toMatchObject({ status: "failed", failureCode: REFERENCE_VIEW_LEASE_EXPIRED, current: true });

    const newAttempt = await reserve(state.characterId, state.source, newJob, front);
    if (newAttempt === null) throw new Error("new attempt was not reserved");
    const produced = await createImageAsset({
      ownerId,
      kind: "reference_view",
      entityKind: "character",
      entityId: state.characterId,
    });
    expect(await finalizeReferenceView({
      jobId: oldJob,
      viewId: oldAttempt,
      characterId: state.characterId,
      ownerId,
      imageId: produced.id,
      method: "rendered",
    })).toBe("fenced");
    expect(await currentReferenceViewRow(state.characterId, front)).toMatchObject({ id: newAttempt, status: "pending" });
  });

  it("reconciles a pending attempt that has no live lease into retryable failure", async () => {
    const state = await fixture();
    const [orphan] = await db()
      .insert(characterReferenceViews)
      .values({
        characterId: state.characterId,
        angleId: back.angle,
        wardrobe: back.wardrobe,
        current: true,
        status: "pending",
        sourceImageId: state.source.imageId,
        sourceContentHash: state.source.contentHash,
        generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
      })
      .returning({ id: characterReferenceViews.id });
    if (!orphan) throw new Error("orphan fixture insert failed");

    expect(await reconcileExpiredReferenceViewWork(state.characterId)).toBe(1);
    expect(await currentReferenceViewRow(state.characterId, back)).toMatchObject({
      id: orphan.id,
      status: "failed",
      failureCode: REFERENCE_VIEW_LEASE_EXPIRED,
    });
  });

  it("charges only newly claimed targets and reports every partial-admission outcome", async () => {
    const state = await fixture();
    const blocker = await job(state.characterId);
    expect((await claimReferenceViewLeases({
      characterId: state.characterId,
      ownerId,
      jobId: blocker,
      targets: [side],
    })).claimed).toHaveLength(1);
    const before = await readDailyUsage(ownerId, "provider_image_day");

    const outcome = await queueReferenceViewBuild({
      characterId: state.characterId,
      ownerId,
      req: new NextRequest(`https://vesper.test/api/characters/${state.characterId}/reference-views/regenerate`, {
        method: "POST",
      }),
      user: { id: ownerId },
      // `sideBare` is on the building side view's line: busy, and not charged.
      targets: [side, back, sideBare],
      planned: 8,
    });
    const after = await readDailyUsage(ownerId, "provider_image_day");

    expect(outcome).toMatchObject({
      queued: true,
      reason: null,
      admitted: 1,
      targets: [
        { ...side, state: "busy" },
        { ...back, state: "queued" },
        { ...sideBare, state: "busy" },
      ],
    });
    expect(after.used - before.used).toBe(1);
  });

  // Approval is a spending action (#670): the count the Approve control
  // discloses before the write is the count the review route admits, queues and
  // charges after it, through the one admission helper every build uses — and
  // a rejection spends nothing at all.
  it("charges an approval exactly the views it disclosed, and a rejection nothing", async () => {
    const rejected = await fixture();
    const rejectedAttempt = await unreviewedFront(rejected.characterId, rejected.source);
    expect((await reviewReferenceView({
      characterId: rejected.characterId, ownerId, view: front, attemptId: rejectedAttempt, expectedRevision: 0, verdict: "reject",
    })).status).toBe("reviewed");
    const beforeReject = await readDailyUsage(ownerId, "provider_image_day");
    const nothing = await queueReviewDependents({
      characterId: rejected.characterId, ownerId, req: routeRequest(rejected.characterId), user: { id: ownerId }, view: front, trigger: "reject",
    });
    expect(nothing).toMatchObject({ queued: false, reason: null, admitted: 0, targets: [] });
    expect((await readDailyUsage(ownerId, "provider_image_day")).used).toBe(beforeReject.used);

    const state = await fixture();
    const attempt = await unreviewedFront(state.characterId, state.source);
    const disclosed = (await getReferenceViewSummary(state.characterId, ownerId, front)).approvalBuilds;
    expect(slotKeys(disclosed)).toEqual(slotKeys(referenceViewDependents(front)));

    expect((await reviewReferenceView({
      characterId: state.characterId, ownerId, view: front, attemptId: attempt, expectedRevision: 0, verdict: "approve",
    })).status).toBe("reviewed");
    const before = await readDailyUsage(ownerId, "provider_image_day");
    const outcome = await queueReviewDependents({
      characterId: state.characterId, ownerId, req: routeRequest(state.characterId), user: { id: ownerId }, view: front, trigger: "approve",
    });
    const after = await readDailyUsage(ownerId, "provider_image_day");

    expect(outcome).toMatchObject({ queued: true, reason: null, admitted: disclosed.length });
    expect(slotKeys(outcome.targets)).toEqual(slotKeys(disclosed));
    expect(outcome.targets.every((target) => target.state === "queued")).toBe(true);
    expect(after.used - before.used).toBe(disclosed.length);
  });

  // The build order's gate at the admission door (#670): a regenerate request
  // naming ANY slot still waiting on its unapproved upstream refuses the WHOLE
  // request as a 409 `waiting`, before anything is claimed or charged. The
  // implementation this kills claims and renders the ready slot (`front`) while
  // quietly skipping the waiting one (`back`) — a client would see a partial,
  // silently incomplete build instead of the refusal the docs promise.
  it("refuses a whole regenerate request, charging and claiming nothing, when one named slot still waits on its upstream", async () => {
    const state = await fixture();
    const before = await readDailyUsage(ownerId, "provider_image_day");

    const response = await regenerateReferenceViews({
      characterId: state.characterId,
      ownerId,
      req: routeRequest(state.characterId),
      user: { id: ownerId },
      requested: [front, back],
    });
    await expectApiError(response, 409, "waiting");

    expect((await readDailyUsage(ownerId, "provider_image_day")).used).toBe(before.used);
    // Whole-batch, not per-slot: `front` — which was ready to build — was never
    // claimed either, so a later request can still claim it fresh.
    const afterJob = await job(state.characterId);
    expect(
      (await claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: afterJob, targets: [front] })).claimed,
    ).toEqual([{ ...front, attemptId: null }]);
  });

  // The same door for a request that names a view AND a view built from it
  // (#670 review). With the front approved, `back` reads ready on the sheet —
  // only the request itself makes it wait: rebuilding the front replaces the
  // upstream `back` would render from. Charging both would buy one render that
  // lands on nothing, then a second charge when the new front is approved.
  it("refuses a whole regenerate request that names a view and a view built from it, charging nothing", async () => {
    const state = await fixture();
    const attempt = await unreviewedFront(state.characterId, state.source);
    expect((await reviewReferenceView({
      characterId: state.characterId, ownerId, view: front, attemptId: attempt, expectedRevision: 0, verdict: "approve",
    })).status).toBe("reviewed");
    expect(await getReferenceViewSummary(state.characterId, ownerId, back)).toMatchObject({ state: "missing", waitingOn: null });
    const before = await readDailyUsage(ownerId, "provider_image_day");

    const response = await regenerateReferenceViews({
      characterId: state.characterId,
      ownerId,
      req: routeRequest(state.characterId),
      user: { id: ownerId },
      requested: [front, back],
    });
    await expectApiError(response, 409, "waiting");

    expect((await readDailyUsage(ownerId, "provider_image_day")).used).toBe(before.used);
    // Refused before admission: no build job exists for this character at all,
    // so neither slot was leased.
    const live = await db()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.type, "reference_views"), inArray(jobs.status, ["queued", "running"])));
    expect(live).toEqual([]);
  });
});
