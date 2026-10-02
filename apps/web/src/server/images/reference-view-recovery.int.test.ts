import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";
import {
  emptyCharacterProfile,
  referenceViewUpstream,
  VISUAL_IMAGE_AGE_ATTRIBUTE_ID,
  type ReferenceView,
  type ReferenceViewQueueOutcome,
} from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { expectDiagnostic } from "@/test/diagnostics";

/**
 * **Recovering a failed render's paid output never pays for it twice, and
 * never hands out bytes nobody reviewed** (#682).
 *
 * A Civitai render can succeed and be billed, then fail its download; the
 * view's row stays `failed` but keeps that render's own `images` row so the
 * paid output can be fetched again with no new workflow. Each case here kills
 * one way that promise would break under the real character lock, the real
 * `images` foreign key, the real lease readers, and real files on disk — none
 * of it provable against a mocked store:
 *
 * - a failed row's link leaking into the sheet, the consumable-view seam, the
 *   history list, or a bulk Build that would pay for the same render again;
 * - a recovery guarded only by the tab that started it: while it downloads,
 *   another tab's regenerate (paid), upload or restore replaces the slot, so
 *   the paid output is thrown away or the queued render overwrites it;
 * - a recovery's claim on its slot that outlives the run (the slot stays busy
 *   after an install or a refusal), or that never lapses when its process
 *   dies, or that takes the offer with it when it does;
 * - two concurrent recoveries both downloading or both installing, rather
 *   than the claim admitting one;
 * - a copy from a refused install (the sheet moved, the linked row vanished
 *   under retention) surviving on disk instead of being deleted;
 * - a withdrawn or still-standing offer read wrong — fetched bytes that can
 *   never be decoded, or a link retention already nulled, offered forever, or
 *   a merely slow output withdrawn.
 *
 * The transport's read-only fetch of a paid output is the one collaborator
 * replaced here: it is another lane's network call, and these claims are about
 * the rows, the lock and the bytes on disk. Everything else is real.
 */
vi.mock("../ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai")>();
  return { ...actual, recoverCivitaiOutput: vi.fn() };
});

import { recoverCivitaiOutput } from "../ai";
import { regenerateReferenceViews } from "../../app/api/characters/[id]/reference-views/shared";
import { characterReferenceViews, characters, db, images, jobs, JOB_STALE_MS, usageCounters } from "@/server/db";
import {
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { createImageAsset, failImage, imageMeta, mergeMetaSql, readImageBytes, saveImageBuffer } from "./asset-storage";
import { listCharacterMediaJobs } from "./character-media-jobs";
import { PAID_OUTPUT_UNAVAILABLE_KEY } from "./paid-output";
import { imagesDirectoryPath } from "./paths";
import { loadConsumableReferenceView } from "./reference-view-consume";
import {
  recoverReferenceView,
  REFERENCE_VIEW_OUTPUT_EXPIRED,
  REFERENCE_VIEW_OUTPUT_RECOVERED,
  REFERENCE_VIEW_OUTPUT_UNAVAILABLE,
} from "./reference-view-recovery";
import {
  claimReferenceViewLeases,
  claimReferenceViewRecovery,
  failReferenceView,
  finalizeReferenceView,
  getReferenceViewSet,
  getReferenceViewSummary,
  plannedReferenceViewsForCharacter,
  readAcceptedPortraitSource,
  referenceViewHistoryEntries,
  referenceViewSlotBusy,
  referenceViewsToRebuild,
  reserveReferenceView,
  restoreReferenceView,
  reviewReferenceView,
} from "./reference-view-store";
import { uploadReferenceView } from "./reference-view-upload";

// These claims depend on the character lock, stored rows, the images foreign
// key, the lease readers, and the file the one webp writer leaves on disk.
const ready = await probeIntegrationDb("reference-view-recovery.int.test", "character_reference_views");
const mockRecover = vi.mocked(recoverCivitaiOutput);

const FRONT: ReferenceView = { angle: "front_full", wardrobe: "clothed" };
const BACK: ReferenceView = { angle: "back_full", wardrobe: "clothed" };
const LEFT: ReferenceView = { angle: "side_left", wardrobe: "clothed" };
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
 * that view built and approved first, so the attempt records it; with
 * `priorReady`, the slot first gets a ready attempt the failed one supersedes,
 * so there is a retained version to restore.
 */
async function failedRender(
  slot: ReferenceView,
  render: Record<string, unknown> = undeliveredRender(),
  options: { priorReady?: boolean } = {},
) {
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
  const renderReady = async (target: ReferenceView, upstreamViewId: string | null) => {
    const built = await leaseAndReserve(target, upstreamViewId);
    const asset = await storedImage(characterId, "reference_view");
    await finalizeReferenceView({ jobId: built.jobId, viewId: built.attemptId, characterId, ownerId, imageId: asset.id, method: "rendered" });
    await settle(built.jobId);
    return built.attemptId;
  };

  let upstreamViewId: string | null = null;
  const upstream = referenceViewUpstream(slot);
  if (upstream !== null) {
    const built = await renderReady(upstream, null);
    const approval = await reviewReferenceView({
      characterId, ownerId, view: upstream, attemptId: built, expectedRevision: 0, verdict: "approve",
    });
    if (approval.status !== "reviewed") throw new Error("the recovery upstream was not approved");
    upstreamViewId = built;
  }
  const priorAttemptId = options.priorReady === true ? await renderReady(slot, upstreamViewId) : null;

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
    priorAttemptId,
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

/** Every recovery claim ever taken on this character's slots, oldest first. */
async function recoveryClaims(characterId: string) {
  return db().select().from(jobs).where(and(
    eq(jobs.ownerId, ownerId),
    eq(jobs.type, "reference_views"),
    sql`${jobs.payload} ->> 'characterId' = ${characterId}`,
    sql`${jobs.payload} ->> 'recovery' = 'true'`,
  )).orderBy(jobs.createdAt);
}

/** A download held open until the test lets it land — a recovery caught mid-flight. */
function heldDownload() {
  let land: (answer: Awaited<ReturnType<typeof recoverCivitaiOutput>>) => void = () => undefined;
  const started = new Promise<void>((resolveStarted) => {
    mockRecover.mockImplementation(() => new Promise((resolve) => {
      land = resolve;
      resolveStarted();
    }));
  });
  return { started, land: (answer: Awaited<ReturnType<typeof recoverCivitaiOutput>>) => land(answer) };
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
      .set({ meta: mergeMetaSql({ [PAID_OUTPUT_UNAVAILABLE_KEY]: new Date().toISOString() }) })
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

    // The failed original is left to retention; nothing was charged, and the
    // one job row is the recovery's own claim, released as it installed —
    // never a render.
    expect((await imageRow(state.failedImageId))?.status).toBe("failed");
    const jobsAfter = await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, ownerId));
    expect(jobsAfter).toHaveLength(jobsBefore.length + 1);
    const [claim] = await recoveryClaims(state.characterId);
    expect(claim).toMatchObject({ status: "done" });
    expect(claim?.payload).toMatchObject({ leases: [], built: 1, failed: 0, referenceViewAttemptIds: [state.attemptId] });
    expect(await db().select({ id: usageCounters.id }).from(usageCounters).where(and(
      eq(usageCounters.ownerId, ownerId), eq(usageCounters.kind, "provider_image_day"),
    ))).toEqual([]);
    // The slot is free again, and the character's media jobs show the image.
    expect(await referenceViewSlotBusy(state.characterId, ownerId, BACK)).toBe(false);
    expect((await getReferenceViewSet(state.characterId, ownerId)).building).toBe(false);
    const recovery = (await listCharacterMediaJobs(state.characterId, ownerId)).find((job) => job.id === claim?.id);
    expect(recovery).toMatchObject({ lifecycle: "succeeded", results: [{ id: state.attemptId, imageId: row.imageId }] });

    // A second recovery of the same attempt finds nothing failed to recover.
    expect((await recoverReferenceView(state.request)).status).toBe("changed");
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  // While a recovery downloads, every other writer — in any tab or process —
  // sees its claim: the slot reads busy to regenerate (single and batch),
  // upload, restoration and another recovery, and the sheet reads building.
  it("holds its slot against every other writer for as long as it downloads", async () => {
    const state = await failedRender(BACK, undeliveredRender(), { priorReady: true });
    const download = heldDownload();
    const inFlight = recoverReferenceView(state.request);
    await download.started;

    expect(await referenceViewSlotBusy(state.characterId, ownerId, BACK)).toBe(true);
    expect((await getReferenceViewSet(state.characterId, ownerId)).building).toBe(true);

    const regenerate = await regenerateReferenceViews({
      characterId: state.characterId,
      ownerId,
      req: new NextRequest(`https://vesper.test/api/characters/${state.characterId}/reference-views/regenerate`, { method: "POST" }),
      user: { id: ownerId },
      requested: [BACK],
    });
    const regenerated = await expectJson<{ views: ReferenceViewQueueOutcome }>(regenerate, 200);
    expect(regenerated.views).toMatchObject({ queued: false, reason: "busy", targets: [{ ...BACK, state: "busy" }] });
    // A batch's admission takes a slot off the recovering one's line and
    // leaves the recovering slot alone.
    const [batch] = await db().insert(jobs).values({
      ownerId, type: "reference_views", status: "running", payload: { characterId: state.characterId, targets: [], leases: [] },
    }).returning({ id: jobs.id });
    if (!batch) throw new Error("the batch job did not insert");
    const admitted = await claimReferenceViewLeases({ characterId: state.characterId, ownerId, jobId: batch.id, targets: [BACK, LEFT] });
    expect(admitted).toEqual({ claimed: [{ ...LEFT, attemptId: null }], busy: [BACK] });
    await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, batch.id));

    const dataUrl = `data:image/png;base64,${(await testPngBuffer()).toString("base64")}`;
    expect((await uploadReferenceView({ characterId: state.characterId, ownerId, view: BACK, dataUrl })).status).toBe("busy");
    expect((await restoreReferenceView({
      characterId: state.characterId, ownerId, view: BACK, attemptId: state.priorAttemptId ?? "",
      expectedCurrentAttemptId: state.attemptId, expectedCurrentRevision: 0,
    })).status).toBe("busy");
    expect((await recoverReferenceView(state.request)).status).toBe("busy");
    expect(mockRecover).toHaveBeenCalledTimes(1);

    download.land({ ok: true, image: await testPngBuffer(600, 800) });
    expect((await inFlight).status).toBe("recovered");
    expect((await viewRow(state.attemptId)).status).toBe("ready");
    expect(await referenceViewSlotBusy(state.characterId, ownerId, BACK)).toBe(false);
    expect((await getReferenceViewSet(state.characterId, ownerId)).building).toBe(false);
  });

  // Two clicks race: both may pass the unlocked checks, but the claim is
  // taken under the character lock, so only one recovery downloads and
  // installs; the other is refused before it fetches anything.
  it("downloads and installs one of two simultaneous recoveries", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(600, 800) });

    const outcomes = await Promise.all([recoverReferenceView(state.request), recoverReferenceView(state.request)]);

    const statuses = outcomes.map((outcome) => outcome.status).sort();
    expect(statuses).toContain("recovered");
    expect(["busy", "changed"]).toContain(statuses.find((status) => status !== "recovered"));
    expect(mockRecover).toHaveBeenCalledTimes(1);
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
    // None of these took a claim.
    expect(await recoveryClaims(state.characterId)).toEqual([]);
  });

  // A link retention already nulled is the commit's `expired`, answered at
  // the door: only a stale tab can still be offering it.
  it("answers expired before fetching anything once retention has unlinked the failed render", async () => {
    const state = await failedRender(FRONT);
    await db().update(characterReferenceViews).set({ imageId: null }).where(eq(characterReferenceViews.id, state.attemptId));

    expect((await recoverReferenceView(state.request)).status).toBe("expired");
    expect(mockRecover).not.toHaveBeenCalled();
    expect(await recoveryClaims(state.characterId)).toEqual([]);
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
    expect(typeof meta[PAID_OUTPUT_UNAVAILABLE_KEY]).toBe("string");
    // Retention's clock is untouched: the row still goes when it always would.
    expect(meta.failedAt).toBe(failedAt);
    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId]);
    // The withdrawn offer is not fetched again.
    expect((await recoverReferenceView(state.request)).status).toBe("expired");
    expect(mockRecover).toHaveBeenCalledTimes(1);
  });

  // Bytes sharp cannot decode are the provider's stored output: every fetch
  // returns the same garbage, so the offer is withdrawn rather than retried.
  it("withdraws the offer when the fetched bytes cannot be decoded, and stores nothing", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockResolvedValue({ ok: true, image: Buffer.from("these bytes are not an image") });
    const sink = new DiagnosticCollector();

    expect((await recoverReferenceView({ ...state.request, sink })).status).toBe("expired");

    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_EXPIRED);
    expect(typeof imageMeta((await imageRow(state.failedImageId))?.meta)[PAID_OUTPUT_UNAVAILABLE_KEY]).toBe("string");
    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: false });
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId]);
    expect(await referenceViewSlotBusy(state.characterId, ownerId, FRONT)).toBe(false);
  });

  it("keeps the offer, and releases its claim, when a fetch fails for a reason that may pass", async () => {
    const state = await failedRender(FRONT);
    mockRecover.mockResolvedValue({ ok: false, permanent: false, error: "Civitai answered 503" });
    const sink = new DiagnosticCollector();

    expect((await recoverReferenceView({ ...state.request, sink })).status).toBe("unavailable");

    expectDiagnostic(sink, REFERENCE_VIEW_OUTPUT_UNAVAILABLE);
    const meta = imageMeta((await imageRow(state.failedImageId))?.meta);
    expect(meta).not.toHaveProperty(PAID_OUTPUT_UNAVAILABLE_KEY);
    expect(await getReferenceViewSummary(state.characterId, ownerId, FRONT)).toMatchObject({ state: "failed", recoverable: true });
    expect(await referenceViewAssets(state.characterId)).toEqual([state.failedImageId]);
    // The refused run gave the slot back, and says how it ended.
    expect(await referenceViewSlotBusy(state.characterId, ownerId, FRONT)).toBe(false);
    const [claim] = await recoveryClaims(state.characterId);
    expect(claim).toMatchObject({ status: "done" });
    expect(claim?.payload).toMatchObject({ leases: [], built: 0, failed: 1, code: REFERENCE_VIEW_OUTPUT_UNAVAILABLE });
  });

  // A process that dies mid-download beats its claim no more. The claim
  // lapses within JOB_STALE_MS, the slot is free, and the offer is exactly
  // as it was, for the next recovery to take.
  it("lets a dead run's claim lapse, and leaves the offer for the next recovery", async () => {
    const state = await failedRender(FRONT);
    const claim = await claimReferenceViewRecovery(state.request);
    if (!claim.ok) throw new Error("the claim was not taken");
    expect(await referenceViewSlotBusy(state.characterId, ownerId, FRONT)).toBe(true);
    expect((await getReferenceViewSet(state.characterId, ownerId)).building).toBe(true);

    await db().update(jobs).set({ heartbeatAt: new Date(Date.now() - JOB_STALE_MS - 60_000) }).where(eq(jobs.id, claim.jobId));

    expect(await referenceViewSlotBusy(state.characterId, ownerId, FRONT)).toBe(false);
    const set = await getReferenceViewSet(state.characterId, ownerId);
    expect(set.building).toBe(false);
    expect(set.views.find((view) => view.angle === FRONT.angle && view.wardrobe === FRONT.wardrobe))
      .toMatchObject({ attemptId: state.attemptId, state: "failed", recoverable: true });
    // The ordinary read reconciled the dead claim; the failed attempt is untouched.
    const [lapsed] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, claim.jobId));
    expect(lapsed?.status).toBe("failed");
    expect(await viewRow(state.attemptId)).toMatchObject({ status: "failed", imageId: state.failedImageId });

    mockRecover.mockResolvedValue({ ok: true, image: await testPngBuffer(600, 800) });
    expect((await recoverReferenceView(state.request)).status).toBe("recovered");
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
    expect(await referenceViewSlotBusy(state.characterId, ownerId, FRONT)).toBe(false);
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
