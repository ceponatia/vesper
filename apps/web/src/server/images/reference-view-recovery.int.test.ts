import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import {
  emptyCharacterProfile,
  referenceViewUpstream,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type ReferenceView,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";

/*
 * The transport's read-only fetch of a paid output is the one collaborator
 * replaced here: it is another lane's network call, and these claims are about
 * the rows, the lock and the bytes on disk. Everything else is real.
 */
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, recoverCivitaiOutput: vi.fn() };
});

import { recoverCivitaiOutput } from "../ai";
import { characterReferenceViews, characters, db, images, jobs, usageCounters } from "@/server/db";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser, testPngBuffer, withTempDataRoot, type TempDataRoot } from "@/server/test-support";
import { createImageAsset, failImage, imageMeta, mergeMetaSql, readImageBytes, saveImageBuffer } from "./asset-storage";
import { imagesDirectoryPath } from "./paths";
import { loadConsumableReferenceView } from "./reference-view-consume";
import { recoverReferenceView, REFERENCE_VIEW_OUTPUT_EXPIRED, REFERENCE_VIEW_OUTPUT_RECOVERED } from "./reference-view-recovery";
import {
  claimReferenceViewLeases,
  failReferenceView,
  finalizeReferenceView,
  getReferenceViewSet,
  getReferenceViewSummary,
  plannedReferenceViewsForCharacter,
  readAcceptedPortraitSource,
  REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY,
  referenceViewHistoryEntries,
  referenceViewsToRebuild,
  reserveReferenceView,
  reviewReferenceView,
} from "./reference-view-store";

// These claims depend on the character lock, stored rows, the images foreign
// key, and the file the one webp writer leaves on disk.
const ready = await probeIntegrationDb("reference-view-recovery.int.test", "character_reference_views");
const mockRecover = vi.mocked(recoverCivitaiOutput);

const FRONT: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const BACK: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
const FRONT_BARE: ReferenceView = { angle: "front_full", wardrobe: "bare" };
const WORKFLOW_ID = "civitai-workflow-recovery";
const BLOB_ID = "civitai-blob-recovery";
const UNDELIVERED = "Civitai output download failed (civitai_output_undelivered; retry=reconcile)";

let ownerId = "";
let otherOwnerId = "";
let temp: TempDataRoot | undefined;

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-reference-recovery-int");
  ownerId = (await seedTestUser("reference-recovery")).id;
  otherOwnerId = (await seedTestUser("reference-recovery-other")).id;
});
afterAll(async () => {
  await purgeOwnerRows([ownerId, otherOwnerId]);
  await temp?.cleanup();
  await endTestPool();
});
beforeEach(() => {
  mockRecover.mockReset();
});

/** What a Civitai render's failure records when its billed output never arrived. */
function undeliveredRender(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelSlug: CIVITAI_QWEN_IMAGE_21_SLUG,
    task: "variant",
    predictionId: WORKFLOW_ID,
    undeliveredOutputId: BLOB_ID,
    shape: {
      mode: "target_ratio",
      requestedAspect: 3 / 4,
      targetSource: "lane",
      sentField: null,
      sentValue: null,
      expectedAspect: null,
      returned: null,
      crop: null,
      providerSize: null,
    },
    ...patch,
  };
}

/** A stored, ready image of this character — a portrait or an approved view's asset. */
async function storedImage(characterId: string, kind: "avatar" | "reference_view") {
  const reserved = await createImageAsset({ ownerId, kind, entityKind: "character", entityId: characterId });
  const stored = await saveImageBuffer(reserved.id, await testPngBuffer());
  if (stored === null || stored.status !== "ready") throw new Error(`the ${kind} fixture did not store`);
  return stored;
}

/**
 * A character whose `slot` failed after its render was billed: a running
 * job's lease, a reserved attempt, the render's own row failed with the
 * workflow and blob it never delivered, and the attempt failed with that row
 * linked — the build lane's own sequence. A slot with an upstream view gets
 * that view built and approved first, so the attempt records it.
 */
async function failedRender(slot: ReferenceView, render: Record<string, unknown> = undeliveredRender()) {
  const [character] = await db().insert(characters).values({
    ownerId,
    name: "Reference recovery fixture",
    profile: {
      ...emptyCharacterProfile(),
      attributes: [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: "eighteen", source: "creation" as const }],
    },
  }).returning({ id: characters.id });
  if (!character) throw new Error("the recovery character did not insert");
  const characterId = character.id;
  const portrait = await storedImage(characterId, "avatar");
  await db().update(characters).set({ acceptedAvatarImageId: portrait.id, acceptedAt: new Date() }).where(eq(characters.id, characterId));
  const source = await readAcceptedPortraitSource(characterId, ownerId);
  if (!source.ok) throw new Error("the recovery portrait did not read");

  const leaseAndReserve = async (target: ReferenceView, upstreamViewId: string | null) => {
    const [job] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status: "running", payload: { characterId, targets: [], leases: [] },
    }).returning({ id: jobs.id });
    if (!job) throw new Error("the recovery job did not insert");
    const claim = await claimReferenceViewLeases({ characterId, ownerId, jobId: job.id, targets: [target] });
    if (claim.claimed.length !== 1) throw new Error("the recovery lease was not claimed");
    const attemptId = await reserveReferenceView({
      jobId: job.id, characterId, ownerId, view: target,
      sourceImageId: source.imageId, sourceContentHash: source.contentHash, upstreamViewId,
    });
    if (attemptId === null) throw new Error("the recovery attempt was not reserved");
    return { jobId: job.id, attemptId };
  };
  const settle = (jobId: string) => db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, jobId));

  let upstreamViewId: string | null = null;
  const upstream = referenceViewUpstream(slot);
  if (upstream !== null) {
    const built = await leaseAndReserve(upstream, null);
    const asset = await storedImage(characterId, "reference_view");
    await finalizeReferenceView({ jobId: built.jobId, viewId: built.attemptId, characterId, ownerId, imageId: asset.id, method: "rendered" });
    await settle(built.jobId);
    const approval = await reviewReferenceView({
      characterId, ownerId, view: upstream, attemptId: built.attemptId, expectedRevision: 0, verdict: "approve",
    });
    if (approval.status !== "reviewed") throw new Error("the recovery upstream was not approved");
    upstreamViewId = built.attemptId;
  }

  const attempt = await leaseAndReserve(slot, upstreamViewId);
  const renderRow = await createImageAsset({
    ownerId, kind: "reference_view", entityKind: "character", entityId: characterId,
    prompt: "the compiled view prompt", sourceImageId: source.imageId,
    meta: { referenceView: { angle: slot.angle, wardrobe: slot.wardrobe } },
  });
  await failImage(renderRow.id, UNDELIVERED, { render });
  const failed = await failReferenceView({
    jobId: attempt.jobId, viewId: attempt.attemptId, characterId, ownerId,
    failureCode: "other", failureMessage: UNDELIVERED, imageId: renderRow.id, upstreamViewId,
  });
  if (failed !== "failed") throw new Error("the recovery attempt did not fail");
  await settle(attempt.jobId);
  return {
    characterId,
    attemptId: attempt.attemptId,
    failedImageId: renderRow.id,
    upstreamViewId,
    request: { characterId, ownerId, view: slot, attemptId: attempt.attemptId },
  };
}

async function viewRow(attemptId: string) {
  const [row] = await db().select().from(characterReferenceViews).where(eq(characterReferenceViews.id, attemptId));
  if (!row) throw new Error("the attempt row is gone");
  return row;
}

async function imageRow(imageId: string) {
  const [row] = await db().select().from(images).where(eq(images.id, imageId));
  return row;
}

async function referenceViewAssets(characterId: string): Promise<string[]> {
  const rows = await db().select({ id: images.id }).from(images).where(and(
    eq(images.entityId, characterId), eq(images.kind, "reference_view"),
  ));
  return rows.map((row) => row.id).sort();
}

describe.skipIf(!ready)("a failed render's paid output", () => {
  it("keeps the failed render linked while the sheet draws nothing, and offers the output", async () => {
    const state = await failedRender(BACK);

    expect((await viewRow(state.attemptId)).imageId).toBe(state.failedImageId);
    const summary = await getReferenceViewSummary(state.characterId, ownerId, BACK);
    expect(summary).toMatchObject({ attemptId: state.attemptId, state: "failed", imageId: null, consumable: false, recoverable: true });
    // Nothing reaches a render or the history list from a failed row.
    expect(await loadConsumableReferenceView({ ownerId, characterId: state.characterId, view: BACK }))
      .toEqual({ ok: false, reason: "failed" });
    expect((await referenceViewHistoryEntries(state.characterId, ownerId, BACK)).map((entry) => entry.id))
      .not.toContain(state.attemptId);
    // Build never pays for it twice.
    const set = await getReferenceViewSet(state.characterId, ownerId);
    const planned = await plannedReferenceViewsForCharacter(state.characterId, ownerId);
    expect(referenceViewsToRebuild(set, planned)).not.toContainEqual(BACK);
  });

  it("offers nothing once the output is withdrawn, or for a render no provider can be asked again", async () => {
    const withdrawn = await failedRender(FRONT);
    await db().update(images)
      .set({ meta: mergeMetaSql({ [REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY]: new Date().toISOString() }) })
      .where(eq(images.id, withdrawn.failedImageId));
    expect(await getReferenceViewSummary(withdrawn.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
    const set = await getReferenceViewSet(withdrawn.characterId, ownerId);
    expect(referenceViewsToRebuild(set, await plannedReferenceViewsForCharacter(withdrawn.characterId, ownerId))).toContainEqual(FRONT);

    const elsewhere = await failedRender(FRONT, undeliveredRender({ modelSlug: "qwen/qwen-image-edit-2511" }));
    expect(await getReferenceViewSummary(elsewhere.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
  });

  it("never leaks an ineligible failed row's link", async () => {
    const state = await failedRender(FRONT_BARE);
    await db().update(characters).set({
      profile: { ...emptyCharacterProfile(), attributes: [{ id: VISUAL_IMAGE_AGE_ATTRIBUTE_ID, value: "teen", source: "creation" as const }] },
    }).where(eq(characters.id, state.characterId));

    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT_BARE))
      .toMatchObject({ attemptId: state.attemptId, state: "ineligible", imageId: null, recoverable: false });
    expect((await recoverReferenceView(state.request)).status).toBe("ineligible");
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it("installs the paid output as the same attempt, unreviewed, with no new render and no charge", async () => {
    const state = await failedRender(BACK);
    // A frame wider than 3:4, so the render's own crop decision has work to do.
    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(900, 1000) });
    const jobsBefore = await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, ownerId));
    const sink = new DiagnosticCollector();

    const result = await recoverReferenceView({ ...state.request, sink });

    expect(result.status).toBe("recovered");
    if (result.status !== "recovered") return;
    expect(result.view).toMatchObject({
      attemptId: state.attemptId, state: "unreviewed", consumable: false, recoverable: false,
      method: "rendered", failureCode: null, failureMessage: null, reviewedAt: null,
    });
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledWith({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });
    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_RECOVERED);

    const row = await viewRow(state.attemptId);
    expect(row).toMatchObject({
      current: true, status: "ready", method: "rendered", verdict: null, reviewedAt: null,
      failureCode: null, failureMessage: null, upstreamViewId: state.upstreamViewId, bodyReferenceSet: null,
    });
    expect(row.imageId).toBe(result.view.imageId);
    expect(row.imageId).not.toBe(state.failedImageId);

    // A real webp, cropped to the render's own 3:4 the way the render would have.
    const copy = await imageRow(row.imageId ?? "");
    if (!copy) throw new Error("the recovered copy is missing");
    expect(copy).toMatchObject({ status: "ready", kind: "reference_view", entityId: state.characterId, prompt: "the compiled view prompt" });
    expect(copy.bytes).toBeGreaterThan(0);
    const stored = await readImageBytes(copy);
    if (stored === null) throw new Error("the recovered copy has no file");
    expect(await sharp(stored).metadata()).toMatchObject({ format: "webp", width: 750, height: 1000 });
    const meta = imageMeta(copy.meta);
    expect(meta.recoveredFrom).toEqual({ imageId: state.failedImageId, workflowId: WORKFLOW_ID, blobId: BLOB_ID });
    expect(meta).not.toHaveProperty("error");
    expect(meta).not.toHaveProperty("failedAt");
    expect(meta.render).toMatchObject({
      predictionId: WORKFLOW_ID,
      shape: { crop: { targetRatio: 3 / 4, placement: "center" }, providerSize: { width: 900, height: 1000 }, returned: { width: 750, height: 1000 } },
    });

    // The failed original is left to retention; nothing was queued or charged.
    expect((await imageRow(state.failedImageId))?.status).toBe("failed");
    expect(await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, ownerId))).toHaveLength(jobsBefore.length);
    expect(await db().select({ id: usageCounters.id }).from(usageCounters).where(and(
      eq(usageCounters.ownerId, ownerId), eq(usageCounters.kind, "provider_image_day"),
    ))).toEqual([]);

    // A second recovery of the same attempt finds nothing failed to recover.
    expect((await recoverReferenceView(state.request)).status).toBe("changed");
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  // Two clicks race: both may pass the unlocked checks and fetch, but the
  // commit is serialized on the character lock and only a still-failed attempt
  // takes a copy. The loser's copy is compensated, so exactly one remains.
  it("installs one of two simultaneous recoveries and leaves no second copy", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(600, 800) });

    const outcomes = await Promise.all([recoverReferenceView(state.request), recoverReferenceView(state.request)]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["changed", "recovered"]);
    const installed = (await viewRow(state.attemptId)).imageId;
    expect(installed).not.toBeNull();
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId, installed ?? ""].sort());
  });

  it("refuses another attempt, a foreign owner, a busy slot and a moved portrait before fetching anything", async () => {
    const state = await failedRender(FRONT);
    expect((await recoverReferenceView({ ...state.request, attemptId: "not-this-attempt" })).status).toBe("changed");
    expect((await recoverReferenceView({ ...state.request, ownerId: otherOwnerId })).status).toBe("not_found");

    const [job] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status: "running",
      payload: { characterId: state.characterId, targets: ["front_full:clothed"], leases: [{ ...FRONT, attemptId: null }] },
    }).returning({ id: jobs.id });
    expect((await recoverReferenceView(state.request)).status).toBe("busy");
    if (job) await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, job.id));

    // The bytes the attempt was rendered from are not the accepted portrait's.
    await db().update(characterReferenceViews).set({ sourceContentHash: "0".repeat(64) }).where(eq(characterReferenceViews.id, state.attemptId));
    expect((await recoverReferenceView(state.request)).status).toBe("incompatible");

    // Another portrait accepted: the offer stands, but it no longer fits the sheet.
    const moved = await failedRender(FRONT);
    const replacement = await storedImage(moved.characterId, "avatar");
    await db().update(characters).set({ acceptedAvatarImageId: replacement.id, acceptedAt: new Date() }).where(eq(characters.id, moved.characterId));
    expect(await getReferenceViewSummary(moved.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
    expect((await recoverReferenceView(moved.request)).status).toBe("incompatible");

    expect(mockRecover).not.toHaveBeenCalled();
    expect((await viewRow(state.attemptId)).status).toBe("failed");
  });

  it("withdraws the offer when the provider shows the output is gone for good", async () => {
    const state = await failedRender(FRONT);
    const failedAt = imageMeta((await imageRow(state.failedImageId))?.meta).failedAt;
    mockRecover.mockResolvedValue({ ok: false, permanent: true, error: "the blob is no longer available" });
    const sink = new DiagnosticCollector();

    expect((await recoverReferenceView({ ...state.request, sink })).status).toBe("expired");

    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_EXPIRED);
    const original = await imageRow(state.failedImageId);
    expect(original?.status).toBe("failed");
    const meta = imageMeta(original?.meta);
    expect(typeof meta[REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY]).toBe("string");
    // Retention's clock is untouched: the row still goes when it always would.
    expect(meta.failedAt).toBe(failedAt);
    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId]);
    // The withdrawn offer is not fetched again.
    expect((await recoverReferenceView(state.request)).status).toBe("expired");
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  it("keeps the offer when a fetch fails for a reason that may pass", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockResolvedValue({ ok: false, permanent: false, error: "Civitai answered 503" });

    expect((await recoverReferenceView(state.request)).status).toBe("unavailable");

    const meta = imageMeta((await imageRow(state.failedImageId))?.meta);
    expect(meta).not.toHaveProperty(REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY);
    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: true });
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId]);
  });

  // Retention deletes a failed row a day after it failed, and the foreign key
  // nulls the attempt's link. A download that lands after that has nothing to
  // be installed against: the answer is `expired`, and the copy it wrote goes.
  it("deletes its own copy when the commit refuses, and never the failed original", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockImplementation(async () => {
      await db().delete(images).where(eq(images.id, state.failedImageId));
      return { ok: true, image: await testPngBuffer(600, 800) };
    });

    expect((await recoverReferenceView(state.request)).status).toBe("expired");

    const row = await viewRow(state.attemptId);
    expect(row).toMatchObject({ status: "failed", imageId: null });
    expect(await referenceViewAssets(state.characterId)).toEqual([]);
    // No file outlives the row that explained it.
    const owned = new Set((await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId))).map((entry) => entry.id));
    const files = await fs.readdir(imagesDirectoryPath(ownerId));
    expect(files.filter((file) => !owned.has(path.basename(file, ".webp")))).toEqual([]);

    // A copy refused by an ordinary conflict goes the same way.
    const other = await failedRender(FRONT);
    mockRecover.mockImplementation(async () => {
      await db().update(characterReferenceViews).set({ sourceContentHash: "1".repeat(64) }).where(eq(characterReferenceViews.id, other.attemptId));
      return { ok: true, image: await testPngBuffer(600, 800) };
    });
    expect((await recoverReferenceView(other.request)).status).toBe("incompatible");
    expect(await referenceViewAssets(other.characterId)).toEqual([other.failedImageId]);
  });
});
