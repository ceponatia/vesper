import fs from "node:fs/promises";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  emptyCharacterProfile,
  REFERENCE_VIEW_GENERATION_VERSION,
  referenceViewUpstream,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type ReferenceView,
} from "@/contracts";
import { characterReferenceViews, characters, db, images, jobs } from "@/server/db";
import { endTestPool, expectApiError, probeIntegrationDb, purgeOwnerRows, seedTestUser, testPngBuffer, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { regenerateReferenceViews } from "../../app/api/characters/[id]/reference-views/shared";
import { createImageAsset, readImageBytes, saveImageBuffer } from "./asset-storage";
import { absoluteImagePath } from "./paths";
import { referenceViewSweepPass } from "./reference-view-maintenance";
import { claimReferenceViewLeases, currentReferenceViewRow, finalizeReferenceView, getReferenceViewSummary, installUploadedReferenceView, readAcceptedPortraitSource, referenceViewHistoryEntries, reserveReferenceView, restoreReferenceView, reviewReferenceView, withReferenceViewLock, REFERENCE_VIEW_RETENTION_MS, REFERENCE_VIEW_UPSTREAM_UNAPPROVED } from "./reference-view-store";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { uploadReferenceView } from "./reference-view-upload";
import { loadConsumableReferenceView } from "./reference-view-consume";

// These claims depend on real transaction locks, stored ownership and retained files.
const ready = await probeIntegrationDb("reference view review.int.test", "character_reference_views");
const view: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const bareView: ReferenceView = { angle: "front_full", wardrobe: "bare" };
const feedback = { reasons: ["wrong_outfit" as const], correction: "Keep the original jacket." };
let ownerId = "";
let otherOwnerId = "";
let temp: TempDataRoot | undefined;

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-reference-review-int");
  ownerId = (await seedTestUser("reference-review")).id;
  otherOwnerId = (await seedTestUser("reference-review-other")).id;
});
afterAll(async () => {
  await purgeOwnerRows([ownerId, otherOwnerId]);
  await temp?.cleanup();
  await endTestPool();
});

async function asset(characterId: string, kind: "avatar" | "reference_view") {
  const row = await createImageAsset({ ownerId, kind, entityKind: "character", entityId: characterId });
  const saved = await saveImageBuffer(row.id, await testPngBuffer());
  if (!saved || saved.status !== "ready") throw new Error("fixture image failed to save");
  return saved;
}

function profileWithAge(band: string | null) {
  return {
    ...emptyCharacterProfile(),
    attributes: band === null ? [] : [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: band, source: "creation" as const }],
  };
}

async function fixture(fixtureView: ReferenceView = view) {
  const [character] = await db().insert(characters).values({
    ownerId,
    name: "Reference review fixture",
    profile: profileWithAge("eighteen"),
  }).returning();
  if (!character) throw new Error("fixture character insert failed");
  const portrait = await asset(character.id, "avatar");
  await db().update(characters).set({ acceptedAvatarImageId: portrait.id, acceptedAt: new Date() }).where(eq(characters.id, character.id));
  const source = await readAcceptedPortraitSource(character.id, ownerId);
  if (!source.ok) throw new Error("fixture portrait unreadable");
  const base = { characterId: character.id, ownerId, sourceImageId: source.imageId, sourceContentHash: source.contentHash };
  const claimSlot = async (slot: ReferenceView = fixtureView) => {
    const [job] = await db().insert(jobs).values({
      ownerId,
      type: "reference_views",
      status: "running",
      payload: { characterId: character.id, targets: [], leases: [] },
    }).returning({ id: jobs.id });
    if (!job) throw new Error("fixture job insert failed");
    const claim = await claimReferenceViewLeases({
      characterId: character.id,
      ownerId,
      jobId: job.id,
      targets: [slot],
    });
    if (claim.claimed.length !== 1) throw new Error("fixture lease claim failed");
    return job.id;
  };
  const addAttemptFor = async (slot: ReferenceView, upstreamViewId: string | null) => {
    const jobId = await claimSlot(slot);
    const id = await reserveReferenceView({ ...base, view: slot, upstreamViewId, jobId });
    if (id === null) throw new Error("fixture view unexpectedly refused");
    const image = await asset(character.id, "reference_view");
    await finalizeReferenceView({ jobId, viewId: id, characterId: character.id, ownerId, imageId: image.id, method: "rendered" });
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, jobId));
    return { id, image };
  };
  // A view builds only from its upstream's approved current attempt, so the
  // fixture builds and approves the chain above the slot under test first.
  const approveUpstreamOf = async (slot: ReferenceView): Promise<string | null> => {
    const upstream = referenceViewUpstream(slot);
    if (upstream === null) return null;
    const built = await addAttemptFor(upstream, await approveUpstreamOf(upstream));
    const approval = await reviewReferenceView({
      characterId: character.id, ownerId, view: upstream, attemptId: built.id, expectedRevision: 0, verdict: "approve",
    });
    if (approval.status !== "reviewed") throw new Error(`fixture could not approve ${upstream.angle}/${upstream.wardrobe}`);
    return built.id;
  };
  const upstreamViewId = await approveUpstreamOf(fixtureView);
  const input = { characterId: character.id, ownerId, view: fixtureView };
  const reserve = { ...base, view: fixtureView, upstreamViewId };
  const addAttempt = () => addAttemptFor(fixtureView, upstreamViewId);
  const first = await addAttempt();
  return { input, reserve, claimSlot, addAttempt, first, portrait, upstreamViewId };
}

async function retainedFixture() {
  const state = await fixture();
  await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "reject", feedback });
  const second = await state.addAttempt();
  const restore = { ...state.input, attemptId: state.first.id, expectedCurrentAttemptId: second.id, expectedCurrentRevision: 0 };
  return { ...state, second, restore };
}

describe.skipIf(!ready)("reference review and recovery", () => {
  it("serializes concurrent verdicts without taking a second pooled connection, and binds Undo to the last revision", async () => {
    const state = await fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => reviewReferenceView({
      ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "approve",
    })));
    expect(results.filter((result) => result.status === "reviewed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "changed")).toHaveLength(11);
    expect((await getReferenceViewSummary(state.input.characterId, ownerId, view)).consumable).toBe(true);
    expect((await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "undo" })).status).toBe("changed");
    const undo = await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 1, verdict: "undo" });
    expect(undo.status).toBe("reviewed");
    if (undo.status === "reviewed") expect(undo.view).toMatchObject({ state: "unreviewed", consumable: false, reviewRevision: 2 });
  });

  it("never applies a stale viewer's approval to a replacement, and rejects a foreign owner", async () => {
    const state = await fixture();
    const newer = await state.addAttempt();
    expect((await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "approve" })).status).toBe("changed");
    expect((await reviewReferenceView({ ...state.input, ownerId: otherOwnerId, attemptId: newer.id, expectedRevision: 0, verdict: "approve" })).status).toBe("not_found");
    expect((await getReferenceViewSummary(state.input.characterId, ownerId, view)).state).toBe("unreviewed");
  });

  it("restores independent, unreviewed bytes while preserving rejected feedback and surviving original history cleanup", async () => {
    const state = await retainedFixture();
    const originalBytes = await readImageBytes(state.first.image);
    const history = await referenceViewHistoryEntries(state.input.characterId, ownerId, view);
    expect(history.find((entry) => entry.id === state.first.id)).toMatchObject({ verdict: "rejected", feedback, restoreUnavailable: null });
    const result = await restoreReferenceView(state.restore);
    expect(result.status).toBe("restored");
    if (result.status !== "restored") return;
    expect(result.view).toMatchObject({ state: "unreviewed", consumable: false, feedback: null, reviewRevision: 0 });
    expect(result.view.imageId).not.toBe(state.first.image.id);
    const [copy] = await db().select().from(images).where(eq(images.id, result.view.imageId ?? ""));
    if (!copy) throw new Error("restored asset missing");
    expect(await readImageBytes(copy)).toEqual(originalBytes);
    expect((await fs.stat(absoluteImagePath(copy))).mode & 0o777).toBe(0o600);
    // Only the original attempt ages out. The current candidate owns a different file.
    await db().update(characterReferenceViews).set({ updatedAt: new Date(Date.now() - REFERENCE_VIEW_RETENTION_MS - 60_000) }).where(eq(characterReferenceViews.id, state.first.id));
    await referenceViewSweepPass();
    expect(await readImageBytes(copy)).toEqual(originalBytes);
    expect((await getReferenceViewSummary(state.input.characterId, ownerId, view)).state).toBe("unreviewed");
    const [original] = await db().select().from(characterReferenceViews).where(eq(characterReferenceViews.id, state.first.id));
    expect(original).toMatchObject({ verdict: "rejected", feedback, imageId: null, current: false });
  });

  it("refuses stale history and concurrent restores instead of overwriting the newest slot", async () => {
    const state = await retainedFixture();
    const outcomes = await Promise.all([restoreReferenceView(state.restore), restoreReferenceView(state.restore)]);
    expect(outcomes.filter((result) => result.status === "restored")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "changed")).toHaveLength(1);
    const rows = await db().select().from(characterReferenceViews).where(and(eq(characterReferenceViews.characterId, state.input.characterId), eq(characterReferenceViews.current, true)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBeNull();
  });

  it("keeps reservation and restoration atomic when a new generation claims the slot", async () => {
    const state = await retainedFixture();
    const jobId = await state.claimSlot();
    const [result, reservation] = await Promise.all([restoreReferenceView(state.restore), reserveReferenceView({ ...state.reserve, jobId })]);
    expect(["restored", "changed", "busy"]).toContain(result.status);
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(reservation);
  });

  it("refuses a stale source at reservation before a build can call the provider", async () => {
    const state = await fixture();
    const replacement = await asset(state.input.characterId, "avatar");
    await db().update(characters).set({ acceptedAvatarImageId: replacement.id, acceptedAt: new Date() })
      .where(eq(characters.id, state.input.characterId));
    const jobId = await state.claimSlot();
    expect(await reserveReferenceView({ ...state.reserve, jobId })).toBeNull();
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(state.first.id);
  });

  it.each(["queued", "running"] as const)("refuses an upload during a %s build without changing the current attempt or creating an asset", async (status) => {
    const state = await fixture();
    await db().insert(jobs).values({ ownerId, type: "reference_views", status, payload: {
      characterId: state.input.characterId,
      targets: [`${view.angle}:${view.wardrobe}`],
      leases: [{ ...view, attemptId: null }],
    } });
    const before = await db().select({ id: images.id }).from(images).where(eq(images.entityId, state.input.characterId));
    const result = await uploadReferenceView({ ...state.input, dataUrl: `data:image/png;base64,${(await testPngBuffer()).toString("base64")}` });
    expect(result.status).toBe("busy");
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(state.first.id);
    const after = await db().select({ id: images.id }).from(images).where(eq(images.entityId, state.input.characterId));
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it("rechecks a build committed while upload installation waits for the character lock", async () => {
    const state = await fixture();
    const image = await asset(state.input.characterId, "reference_view");
    let entered!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const admission = withReferenceViewLock(state.input.characterId, async (tx) => {
      entered();
      await resume;
      await tx.insert(jobs).values({ ownerId, type: "reference_views", status: "queued", payload: {
        characterId: state.input.characterId,
        targets: [`${view.angle}:${view.wardrobe}`],
        leases: [{ ...view, attemptId: null }],
      } });
    });
    await locked;
    const installation = installUploadedReferenceView({ ...state.reserve, imageId: image.id,
      expectedCurrentAttemptId: state.first.id, expectedCurrentRevision: 0 });
    release();
    const [, result] = await Promise.all([admission, installation]);
    expect(result.status).toBe("busy");
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(state.first.id);
  });

  it("protects pending generations and resolves competing uploads with one approved current attempt", async () => {
    const state = await fixture();
    const image = await asset(state.input.characterId, "reference_view");
    const input = { ...state.reserve, imageId: image.id, expectedCurrentAttemptId: state.first.id, expectedCurrentRevision: 0 };
    const results = await Promise.all([installUploadedReferenceView(input), installUploadedReferenceView(input)]);
    expect(results.filter((result) => result.status === "uploaded")).toHaveLength(1);
    expect(results.filter((result) => result.status === "changed")).toHaveLength(1);
    const current = await currentReferenceViewRow(state.input.characterId, view);
    expect(current).toMatchObject({ current: true, status: "ready", verdict: "approved", imageId: image.id });
    const jobId = await state.claimSlot();
    const pending = await reserveReferenceView({ ...state.reserve, jobId });
    expect((await installUploadedReferenceView({ ...input, expectedCurrentAttemptId: pending })).status).toBe("busy");
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(pending);
  });

  it("does not replace a review or accepted portrait changed while upload bytes were processed", async () => {
    const state = await fixture();
    const image = await asset(state.input.characterId, "reference_view");
    const input = { ...state.reserve, imageId: image.id, expectedCurrentAttemptId: state.first.id, expectedCurrentRevision: 0 };
    await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "reject", feedback });
    expect((await installUploadedReferenceView(input)).status).toBe("changed");
    const portrait = await asset(state.input.characterId, "avatar");
    await db().update(characters).set({ acceptedAvatarImageId: portrait.id }).where(eq(characters.id, state.input.characterId));
    expect((await installUploadedReferenceView({ ...input, expectedCurrentRevision: 1 })).status).toBe("changed");
    expect((await currentReferenceViewRow(state.input.characterId, view))).toMatchObject({ id: state.first.id, verdict: "rejected", feedback });
  });

  it.each([
    ["minor", "teen"],
    ["unresolved", null],
  ] as const)("revokes an approved bare attempt when apparent age becomes %s", async (_label, band) => {
    const state = await fixture(bareView);
    const approved = await reviewReferenceView({
      ...state.input,
      attemptId: state.first.id,
      expectedRevision: 0,
      verdict: "approve",
    });
    expect(approved.status).toBe("reviewed");
    expect((await getReferenceViewSummary(state.input.characterId, ownerId, bareView)).consumable).toBe(true);

    await db().update(characters).set({ profile: profileWithAge(band) }).where(eq(characters.id, state.input.characterId));

    expect(await getReferenceViewSummary(state.input.characterId, ownerId, bareView)).toMatchObject({
      state: "ineligible",
      attemptId: state.first.id,
      consumable: false,
    });
    expect(await loadConsumableReferenceView({ ownerId, characterId: state.input.characterId, view: bareView }))
      .toEqual({ ok: false, reason: "ineligible" });
    expect((await referenceViewHistoryEntries(state.input.characterId, ownerId, bareView))[0]?.restoreUnavailable)
      .toBe("ineligible");

    // Every route-facing write rechecks the current plan under the character
    // lock rather than trusting the plan that admitted the original render.
    expect((await reviewReferenceView({
      ...state.input,
      attemptId: state.first.id,
      expectedRevision: 1,
      verdict: "approve",
    })).status).toBe("ineligible");
    expect((await restoreReferenceView({
      ...state.input,
      attemptId: state.first.id,
      expectedCurrentAttemptId: state.first.id,
      expectedCurrentRevision: 1,
    })).status).toBe("ineligible");
    const jobId = await state.claimSlot();
    expect(await reserveReferenceView({ ...state.reserve, jobId })).toBeNull();
    expect((await uploadReferenceView({
      ...state.input,
      dataUrl: `data:image/png;base64,${(await testPngBuffer()).toString("base64")}`,
    })).status).toBe("ineligible");
  });

  it("settles a bare render as stale when apparent age changes after reservation", async () => {
    const state = await fixture(bareView);
    const jobId = await state.claimSlot();
    const pending = await reserveReferenceView({ ...state.reserve, jobId });
    if (pending === null) throw new Error("adult bare reservation unexpectedly refused");
    const image = await asset(state.input.characterId, "reference_view");
    await db().update(characters).set({ profile: profileWithAge("teen") }).where(eq(characters.id, state.input.characterId));
    expect(await finalizeReferenceView({
      jobId,
      viewId: pending,
      characterId: state.input.characterId,
      ownerId,
      imageId: image.id,
      method: "rendered",
    })).toBe("stale");
    expect(await getReferenceViewSummary(state.input.characterId, ownerId, bareView)).toMatchObject({
      state: "ineligible",
      attemptId: pending,
      consumable: false,
    });
  });

  // The build order's guard at the storage layer: a view rendered from an
  // upstream attempt that is no longer that slot's approved current one reads
  // stale, cannot be approved (it would build its own dependents from a stale
  // body), and cannot be rebuilt while that upstream renders — the lease claim
  // refuses it under the character lock, so nothing is charged.
  it("stales, refuses approval of, and refuses to rebuild a view whose upstream was replaced", async () => {
    const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
    const state = await fixture(back);
    expect(await getReferenceViewSummary(state.input.characterId, ownerId, back))
      .toMatchObject({ state: "unreviewed", waitingOn: null, approvalBuilds: [{ angle: "back_full", wardrobe: "bare" }] });

    // Regenerate the front: a new attempt supersedes the approved one it was built from.
    const frontJob = await state.claimSlot(view);
    expect(await reserveReferenceView({ ...state.reserve, view, upstreamViewId: null, jobId: frontJob })).not.toBeNull();

    expect(await getReferenceViewSummary(state.input.characterId, ownerId, back))
      .toMatchObject({ state: "stale", consumable: false, waitingOn: view });
    expect((await reviewReferenceView({ ...state.input, attemptId: state.first.id, expectedRevision: 0, verdict: "approve" })).status)
      .toBe("incompatible");
    const [backJob] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status: "running", payload: { characterId: state.input.characterId, targets: [], leases: [] },
    }).returning({ id: jobs.id });
    if (!backJob) throw new Error("fixture job insert failed");
    expect(await claimReferenceViewLeases({ characterId: state.input.characterId, ownerId, jobId: backJob.id, targets: [back] }))
      .toEqual({ claimed: [], busy: [back] });
    expect((await currentReferenceViewRow(state.input.characterId, back))?.id).toBe(state.first.id);
  });

  // Defense in depth behind the claim: if the upstream ever stops being the
  // approved attempt AFTER a dependent's lease was claimed — by any path that
  // bypasses the routes' guards — the reservation still refuses before any
  // provider call, and says so: a worker never loses a charge in silence.
  it("refuses, and reports, a reservation whose upstream moved after its lease was claimed", async () => {
    const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
    const state = await fixture(back);
    const backJob = await state.claimSlot();
    // The approved front is un-approved underneath the live lease, bypassing the review guard.
    await db().update(characterReferenceViews)
      .set({ verdict: null, reviewedAt: null, reviewedByUserId: null })
      .where(eq(characterReferenceViews.id, state.upstreamViewId ?? ""));
    const sink = new DiagnosticCollector();
    expect(await reserveReferenceView({ ...state.reserve, jobId: backJob, sink })).toBeNull();
    expect(sink.items.map((item) => item.code)).toContain(REFERENCE_VIEW_UPSTREAM_UNAPPROVED);
    expect((await currentReferenceViewRow(state.input.characterId, back))?.id).toBe(state.first.id);
  });

  // The lineage rule at the storage layer: regenerating the front stales the
  // views built from it; restoring the original front ("Use this version")
  // makes a new row, and approving that copy revives them — no rebuild, no
  // charge — because they recorded the original's lineage, which the copy keeps.
  it("revives the views built from an attempt when a restored copy of it is approved", async () => {
    const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
    const state = await fixture(back);
    const original = state.upstreamViewId;
    if (original === null) throw new Error("fixture front attempt missing");

    const frontJob = await state.claimSlot(view);
    const regenerated = await reserveReferenceView({ ...state.reserve, view, upstreamViewId: null, jobId: frontJob });
    if (regenerated === null) throw new Error("front regeneration was not reserved");
    const image = await asset(state.input.characterId, "reference_view");
    await finalizeReferenceView({
      jobId: frontJob, viewId: regenerated, characterId: state.input.characterId, ownerId, imageId: image.id, method: "rendered",
    });
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, frontJob));
    expect((await getReferenceViewSummary(state.input.characterId, ownerId, back)).state).toBe("stale");

    const restored = await restoreReferenceView({
      characterId: state.input.characterId, ownerId, view, attemptId: original,
      expectedCurrentAttemptId: regenerated, expectedCurrentRevision: 0,
    });
    expect(restored.status).toBe("restored");
    if (restored.status !== "restored") return;
    expect(restored.view).toMatchObject({ state: "unreviewed", lineageId: original });
    expect(restored.view.attemptId).not.toBe(original);
    // The Approve control discloses no rebuild of the view built from the original.
    expect(restored.view.approvalBuilds).not.toContainEqual(back);
    const [copyRow] = await db().select().from(characterReferenceViews).where(eq(characterReferenceViews.id, restored.view.attemptId ?? ""));
    expect(copyRow?.originAttemptId).toBe(original);

    expect((await reviewReferenceView({
      ...state.input, view, attemptId: restored.view.attemptId ?? "", expectedRevision: 0, verdict: "approve",
    })).status).toBe("reviewed");
    expect(await getReferenceViewSummary(state.input.characterId, ownerId, back)).toMatchObject({ state: "unreviewed", waitingOn: null });
  });

  // Replacing a view while a view built from it is rendering strands that
  // render: it lands stale, already charged, and Build offers it again. So an
  // upload, a restoration and a regeneration of the upstream all wait — the
  // slot's own lease is idle here; only its dependent is building.
  it("refuses to replace a view while a view built from it is rendering", async () => {
    const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
    const state = await fixture(back);
    const original = state.upstreamViewId;
    if (original === null) throw new Error("fixture front attempt missing");

    // A second, approved front attempt — leaving the original retained for restoration.
    const frontJob = await state.claimSlot(view);
    const second = await reserveReferenceView({ ...state.reserve, view, upstreamViewId: null, jobId: frontJob });
    if (second === null) throw new Error("second front attempt was not reserved");
    const image = await asset(state.input.characterId, "reference_view");
    await finalizeReferenceView({ jobId: frontJob, viewId: second, characterId: state.input.characterId, ownerId, imageId: image.id, method: "rendered" });
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, frontJob));
    expect((await reviewReferenceView({ ...state.input, view, attemptId: second, expectedRevision: 0, verdict: "approve" })).status).toBe("reviewed");

    // `back` starts rebuilding from it: a live lease and a pending attempt.
    const backJob = await state.claimSlot();
    expect(await reserveReferenceView({ ...state.reserve, upstreamViewId: second, jobId: backJob })).not.toBeNull();
    expect(await getReferenceViewSummary(state.input.characterId, ownerId, view)).toMatchObject({ downstreamBuilding: true });

    const dataUrl = `data:image/png;base64,${(await testPngBuffer()).toString("base64")}`;
    expect((await uploadReferenceView({ ...state.input, view, dataUrl })).status).toBe("busy");
    expect((await restoreReferenceView({
      characterId: state.input.characterId, ownerId, view, attemptId: original,
      expectedCurrentAttemptId: second, expectedCurrentRevision: 1,
    })).status).toBe("busy");
    expect((await referenceViewHistoryEntries(state.input.characterId, ownerId, view))
      .find((entry) => entry.id === original)?.restoreUnavailable).toBe("busy");
    const response = await regenerateReferenceViews({
      characterId: state.input.characterId,
      ownerId,
      req: new NextRequest(`https://vesper.test/api/characters/${state.input.characterId}/reference-views/regenerate`, { method: "POST" }),
      user: { id: ownerId },
      requested: [view],
    });
    await expectApiError(response, 409, "busy");
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(second);
  });

  // An approved view whose FILE is gone used to keep reading approved off its
  // row status: every build of the views made from it was charged, found no
  // bytes to send and rendered nothing, and Build offered them again. An
  // ordinary sheet read now settles it the way the image sweep does, so the
  // view reads stale (Build offers the view itself) and its dependents wait.
  it("stops reading an approved view as approved once its file is gone, so the views built from it wait", async () => {
    const back: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
    const state = await fixture(back);
    const front = await currentReferenceViewRow(state.input.characterId, view);
    const [frontAsset] = await db().select().from(images).where(eq(images.id, front?.imageId ?? ""));
    if (!frontAsset) throw new Error("fixture front asset missing");
    await fs.unlink(absoluteImagePath(frontAsset));

    expect(await getReferenceViewSummary(state.input.characterId, ownerId, view)).toMatchObject({ state: "stale", consumable: false });
    expect(await getReferenceViewSummary(state.input.characterId, ownerId, back)).toMatchObject({ state: "stale", waitingOn: view });
    const [settled] = await db().select({ status: images.status }).from(images).where(eq(images.id, frontAsset.id));
    expect(settled?.status).toBe("failed");
  });

  it("refuses foreign, wrong-slot, expired, unreadable, incompatible and busy attempts", async () => {
    const state = await retainedFixture();
    expect((await restoreReferenceView({ ...state.restore, ownerId: otherOwnerId })).status).toBe("not_found");
    expect((await restoreReferenceView({ ...state.restore, view: { ...view, angle: "back_full" } })).status).toBe("not_found");
    await db().update(characterReferenceViews).set({ updatedAt: new Date(Date.now() - REFERENCE_VIEW_RETENTION_MS - 60_000) }).where(eq(characterReferenceViews.id, state.first.id));
    expect((await restoreReferenceView(state.restore)).status).toBe("expired");
    await db().update(characterReferenceViews).set({ updatedAt: new Date(), generationVersion: REFERENCE_VIEW_GENERATION_VERSION - 1 }).where(eq(characterReferenceViews.id, state.first.id));
    expect((await restoreReferenceView(state.restore)).status).toBe("incompatible");
    await db().update(characterReferenceViews).set({ generationVersion: REFERENCE_VIEW_GENERATION_VERSION, sourceContentHash: "changed bytes" }).where(eq(characterReferenceViews.id, state.first.id));
    expect((await restoreReferenceView(state.restore)).status).toBe("incompatible");
    await db().update(characterReferenceViews).set({ sourceContentHash: state.reserve.sourceContentHash }).where(eq(characterReferenceViews.id, state.first.id));
    const [job] = await db().insert(jobs).values({ ownerId, type: "reference_views", status: "running", payload: {
      characterId: state.input.characterId,
      targets: [`${view.angle}:${view.wardrobe}`],
      leases: [{ ...view, attemptId: null }],
    } }).returning();
    expect((await restoreReferenceView(state.restore)).status).toBe("busy");
    if (job) await db().update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
    await fs.unlink(absoluteImagePath(state.first.image));
    expect((await restoreReferenceView(state.restore)).status).toBe("unavailable");
    expect((await currentReferenceViewRow(state.input.characterId, view))?.id).toBe(state.second.id);
  });
});
