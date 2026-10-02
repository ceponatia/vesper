import sharp from "sharp";
import { z } from "zod";
import { IMAGE_TARGET_ASPECT, imageProfileTaskSchema } from "@vesper/image-core";
import type { ReferenceView } from "@/contracts";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { log, logDiagnostics } from "@/server/log";
import { recoverCivitaiOutput } from "../ai";
import { JOB_HEARTBEAT_INTERVAL_MS } from "../db";
import {
  createImageAsset,
  READY_RETIRED_META_KEYS,
  SHARP_DECODE_LIMITS,
  WEBP_QUALITY,
  writeWebpAtomic,
  type ImageRow,
} from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import { absoluteImagePath } from "./paths";
import { shapeProviderOutput, type ProviderOutputShapeRequest, type ShapedProviderOutput } from "./provider-output-shape";
import {
  beatReferenceViewRecoveryClaim,
  claimReferenceViewRecovery,
  installRecoveredReferenceView,
  readReferenceViewRecovery,
  REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY,
  releaseReferenceViewRecoveryClaim,
  withdrawReferenceViewOutputOffer,
  type RecoverReferenceViewResult,
  type ReferenceViewPaidOutput,
  type ReferenceViewRecoveryRead,
} from "./reference-view-store";

/**
 * **RECOVERING A PAID REFERENCE VIEW** — the image a failed render already paid
 * for, fetched again and installed without a new render.
 *
 * A Civitai render can succeed, be billed, and still fail its download. The
 * view's row then fails like any other, but it keeps its failed render's own
 * images row (`failReferenceView`), and that row records the workflow and the
 * output blob. While the output is still on offer and the attempt still fits
 * the sheet, the slot projects `recoverable`, and this service turns it back
 * into the attempt it should have been — `ready`, unreviewed — for nothing:
 * no admission, no budget charge, and never a new workflow.
 *
 * It is restoration's shape (`restoreReferenceView`): read and check outside the
 * lock, do the slow work outside the lock, then re-check everything and commit
 * under the character lock, compensating the copy a refusal leaves behind.
 *
 * 1. **Check** (`readReferenceViewRecovery`): the owned character, the plan,
 *    the attempt still current and failed, nothing building, the offer, the
 *    projected `recoverable`, and the accepted portrait's bytes.
 * 2. **Claim the slot** (`claimReferenceViewRecovery`) under the character
 *    lock, as a heartbeat-live lease every other writer reads: from here to
 *    the commit, regenerating, uploading, restoring or recovering the slot in
 *    any tab or process answers `busy`, and the sheet reads `building`. This
 *    run beats the claim until it ends, whatever happens to the client, and a
 *    process that dies leaves a claim that lapses within `JOB_STALE_MS`, with
 *    the offer untouched.
 * 3. **Download**, read-only, from the stored workflow and blob
 *    (`recoverCivitaiOutput`). An answer that the output can never be fetched
 *    withdraws the offer (`expired`); any other failure leaves it standing
 *    (`unavailable`), for the owner to try again.
 * 4. **The decode rule.** Bytes sharp cannot decode, or cannot encode as the
 *    stored webp, are the provider's stored output and fail the same way on
 *    every fetch, so they withdraw the offer too. Anything that fails after
 *    them — the disk, the database — is transient.
 * 5. **Shape** the provider's original exactly as the render would have
 *    (`shapeProviderOutput`), and write it through the one webp writer as a
 *    NEW pending row carrying the failed row's meta and `recoveredFrom`.
 * 6. **Commit** (`installRecoveredReferenceView`), which releases the claim in
 *    the transaction that installs; or delete that copy and release the claim.
 *    The failed original is never deleted; retention collects it on its own
 *    clock.
 *
 * Every refusal is a value and nothing here throws: an unexpected failure is
 * answered `unavailable`, which leaves the offer as it was.
 */

/** The one live spelling of the lane's diagnostic scope, as the build uses it. */
const SCOPE = "images.reference_views";

/** A failed view's paid output was installed as its unreviewed attempt, with no new render. */
export const REFERENCE_VIEW_OUTPUT_RECOVERED = `${SCOPE}.output_recovered`;

/** A failed view's paid output can never be fetched or stored; its recovery offer was withdrawn. */
export const REFERENCE_VIEW_OUTPUT_EXPIRED = `${SCOPE}.output_expired`;

/** A failed view's paid output could not be recovered this time; its recovery offer stands. */
export const REFERENCE_VIEW_OUTPUT_UNAVAILABLE = `${SCOPE}.output_unavailable`;

export interface RecoverReferenceViewInput {
  characterId: string;
  ownerId: string;
  view: ReferenceView;
  /** The failed attempt the owner is looking at; anything else current answers `changed`. */
  attemptId: string;
  /** Where the recovery's diagnostics are also said. They always reach the process log. */
  sink?: DiagnosticSink;
}

/** Recover one failed attempt's paid output. Never throws. */
export async function recoverReferenceView(input: RecoverReferenceViewInput): Promise<RecoverReferenceViewResult> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    return await recover(input, sink);
  } catch (error) {
    // Only the reads before the claim, or the claim itself, reach here: a run
    // that holds the claim answers for itself and releases it.
    reportUnavailable(sink, contextOf(input), "error", errorText(error));
    return { status: "unavailable" };
  } finally {
    logDiagnostics(SCOPE, collected.items, { characterId: input.characterId });
  }
}

async function recover(input: RecoverReferenceViewInput, sink: DiagnosticSink): Promise<RecoverReferenceViewResult> {
  const read = await readReferenceViewRecovery(input);
  if (!read.ok) return { status: read.refusal };
  const claim = await claimReferenceViewRecovery(input);
  if (!claim.ok) return { status: claim.refusal };

  const stopBeating = beatWhileRunning(claim.jobId);
  const run: ClaimedRun = { copy: null, installed: false };
  let answer: RecoverReferenceViewResult = { status: "unavailable" };
  let failure: string | null = null;
  try {
    answer = await recoverUnderClaim(input, read, claim.jobId, sink, run);
  } catch (error) {
    failure = errorText(error);
    reportUnavailable(sink, contextOf(input, read.output), "error", failure);
  } finally {
    stopBeating();
    // Only this recovery's own uninstalled copy is compensated. The failed
    // original is the offer, and retention collects it on its own clock.
    if (run.copy !== null && !run.installed) await discardCopy(run.copy.id, input.ownerId);
    // An install released its claim as it committed; every other end
    // releases it here, so the slot is never left held by a finished run.
    if (!run.installed) await releaseClaim(claim.jobId, answer, failure);
  }
  return answer;
}

/** What a claimed run has done so far, for the cleanup that follows every end. */
interface ClaimedRun {
  copy: ImageRow | null;
  installed: boolean;
}

/** Everything after the claim: fetch, the decode rule, shape, write, commit. */
async function recoverUnderClaim(
  input: RecoverReferenceViewInput,
  read: Extract<ReferenceViewRecoveryRead, { ok: true }>,
  claimJobId: string,
  sink: DiagnosticSink,
  run: ClaimedRun,
): Promise<RecoverReferenceViewResult> {
  const { asset, output } = read;
  const context = contextOf(input, output);

  // Outside every lock: a slow blob can take minutes, and nothing about the
  // download is the sheet's business until its bytes are in hand. The claim
  // keeps every other writer off the slot meanwhile.
  const fetched = await fetchPaidOutput(output);
  if (!fetched.ok) {
    if (fetched.permanent) return withdraw(output, input.ownerId, sink, context, fetched.error);
    reportUnavailable(sink, context, "fetch", fetched.error);
    return { status: "unavailable" };
  }
  const undecodable = await undecodableReason(fetched.image);
  if (undecodable !== null) {
    return withdraw(output, input.ownerId, sink, context, `the fetched output cannot be decoded and stored: ${undecodable}`);
  }

  const shaped = await shapeProviderOutput(fetched.image, recordedShapeRequest(asset.meta), sink);
  const copy = await createImageAsset({
    ownerId: input.ownerId,
    kind: "reference_view",
    entityKind: "character",
    entityId: input.characterId,
    prompt: asset.prompt,
    ...(asset.sourceImageId === null ? {} : { sourceImageId: asset.sourceImageId }),
    meta: recoveredMeta(asset.meta, output, shaped),
  });
  run.copy = copy;
  // The one webp writer every stored image goes through: the provider's
  // original is never written as fetched.
  const written = await writeWebpAtomic(absoluteImagePath(copy), shaped.image);
  const result = await installRecoveredReferenceView({
    characterId: input.characterId,
    ownerId: input.ownerId,
    view: input.view,
    attemptId: input.attemptId,
    claimJobId,
    failedImageId: output.imageId,
    copyId: copy.id,
    written,
  });
  run.installed = result.status === "recovered";
  if (run.installed) {
    sink.push(
      diag("info", REFERENCE_VIEW_OUTPUT_RECOVERED, "a failed view's paid output was recovered as its unreviewed attempt, with no new render", {
        path: SCOPE,
        context: { ...context, imageId: copy.id, recoveredFrom: output.imageId },
      }),
    );
  } else if (result.status === "unavailable") {
    // The claim lapsed under a run that was still going: other writers may
    // have been admitted, so nothing was installed, and the offer stands.
    reportUnavailable(sink, context, "claim", "the recovery's claim on the slot lapsed before it could install");
  } else {
    // The bytes were fetched and the sheet moved under them; the offer, if
    // it still stands, is judged afresh on the next read.
    log.warn("images", "a recovered reference view output was not installed", { ...context, refusal: result.status });
  }
  return result;
}

/** The diagnostic context every recovery line carries. */
function contextOf(input: RecoverReferenceViewInput, output?: ReferenceViewPaidOutput): Record<string, unknown> {
  return {
    characterId: input.characterId,
    angle: input.view.angle,
    wardrobe: input.view.wardrobe,
    attemptId: input.attemptId,
    ...(output === undefined ? {} : { workflowId: output.workflowId }),
  };
}

/** The offer stands; this attempt did not recover it. */
function reportUnavailable(
  sink: DiagnosticSink,
  context: Record<string, unknown>,
  stage: "fetch" | "claim" | "error",
  error: string,
): void {
  sink.push(
    diag("warn", REFERENCE_VIEW_OUTPUT_UNAVAILABLE, "a failed view's paid output could not be recovered this time; its recovery offer stands", {
      path: SCOPE,
      context: { ...context, stage, error: error.slice(0, 300) },
    }),
  );
}

/** The output is gone for good: withdraw the offer, say so, and answer `expired`. */
async function withdraw(
  output: ReferenceViewPaidOutput,
  ownerId: string,
  sink: DiagnosticSink,
  context: Record<string, unknown>,
  reason: string,
): Promise<RecoverReferenceViewResult> {
  const withdrawn = await withdrawOffer(output, ownerId);
  sink.push(
    diag("warn", REFERENCE_VIEW_OUTPUT_EXPIRED, "a failed view's paid output can never be recovered; its recovery offer is withdrawn", {
      path: SCOPE,
      context: { ...context, imageId: output.imageId, withdrawn, error: reason.slice(0, 300) },
    }),
  );
  return { status: "expired" };
}

/**
 * Why sharp cannot decode these bytes and encode them as the stored webp, or
 * null when it can: `writeWebpAtomic`'s own decode limits and encoder, run in
 * memory before anything is written. The bytes are the provider's stored
 * output, so a refusal here repeats on every fetch.
 */
async function undecodableReason(bytes: Buffer): Promise<string | null> {
  try {
    await sharp(bytes, SHARP_DECODE_LIMITS).webp({ quality: WEBP_QUALITY }).toBuffer();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** Keep a claim live for exactly as long as this run holds it — the job heartbeat's shape. */
function beatWhileRunning(claimJobId: string): () => void {
  const timer = setInterval(() => void beatReferenceViewRecoveryClaim(claimJobId), JOB_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Delete this run's uninstalled copy; a failure is logged, and the sweep collects the row later. */
async function discardCopy(copyId: string, ownerId: string): Promise<void> {
  try {
    await deleteOwnedImage(copyId, ownerId, { kind: "reference_view" });
  } catch (error) {
    log.warn("images", "unused recovered reference view cleanup failed", { imageId: copyId, error: errorText(error) });
  }
}

/**
 * Release the claim after any end but an install, recording how the run ended
 * for the character's media-jobs read: the refusal's diagnostic code, or the
 * text of what threw. A release that fails is logged; the claim then lapses
 * within `JOB_STALE_MS` on its own.
 */
async function releaseClaim(claimJobId: string, answer: RecoverReferenceViewResult, failure: string | null): Promise<void> {
  const code = failure !== null || answer.status === "unavailable"
    ? REFERENCE_VIEW_OUTPUT_UNAVAILABLE
    : answer.status === "expired" ? REFERENCE_VIEW_OUTPUT_EXPIRED : null;
  try {
    await releaseReferenceViewRecoveryClaim(claimJobId, { recovered: false, code, error: failure });
  } catch (error) {
    log.warn("images", "a reference view recovery claim could not be released; it lapses on its own", {
      jobId: claimJobId,
      error: errorText(error),
    });
  }
}

type FetchedOutput = Awaited<ReturnType<typeof recoverCivitaiOutput>>;

/**
 * The transport answers with a value. A throw is a defect, and a defect is
 * never evidence the output is gone, so it reads as a transient failure: the
 * offer stands.
 */
async function fetchPaidOutput(output: ReferenceViewPaidOutput): Promise<FetchedOutput> {
  try {
    return await recoverCivitaiOutput({ workflowId: output.workflowId, blobId: output.blobId });
  } catch (error) {
    return { ok: false, permanent: false, error: errorText(error) };
  }
}

/** Stamp the withdrawal; a failed stamp is logged, and the next attempt is refused the same way. */
async function withdrawOffer(output: ReferenceViewPaidOutput, ownerId: string): Promise<boolean> {
  try {
    return await withdrawReferenceViewOutputOffer(output.imageId, ownerId);
  } catch (error) {
    log.warn("images", "a reference view recovery offer could not be withdrawn", { imageId: output.imageId, error: errorText(error) });
    return false;
  }
}

const metaRecordSchema = z.record(z.string(), z.unknown());

/** The shape facts a failed render records even though nothing came back (`meta.render.shape`). */
const recordedShapeSchema = z.object({
  mode: z.enum(["provider_default", "target_ratio"]),
  requestedAspect: z.number().positive().nullable(),
  expectedAspect: z.number().positive().nullable(),
});

/**
 * What the failed render recorded about the shape it wanted, read at the trust
 * boundary, as the shaping request a live render of it would have made.
 *
 * Without a readable record the lane's own request stands — the view's 3:4
 * on its `variant` task, with nothing expected back, so the decoded image is
 * cropped toward 3:4 if it is not already there.
 */
function recordedShapeRequest(meta: unknown): ProviderOutputShapeRequest {
  const render = parseOr(metaRecordSchema, parseOr(metaRecordSchema, meta, {}).render, {});
  const task = parseOrNull(imageProfileTaskSchema, render.task) ?? "variant";
  const modelSlug = typeof render.modelSlug === "string" ? render.modelSlug : undefined;
  const shape = parseOrNull(recordedShapeSchema, render.shape);
  const base = { task, ...(modelSlug === undefined ? {} : { modelSlug }) };
  if (shape === null) return { ...base, targetRatio: IMAGE_TARGET_ASPECT, expectedAspect: null };
  if (shape.mode === "provider_default") return { ...base, targetRatio: null, expectedAspect: shape.expectedAspect };
  return { ...base, targetRatio: shape.requestedAspect ?? IMAGE_TARGET_ASPECT, expectedAspect: shape.expectedAspect };
}

/** The keys a recovered copy never carries: a failure it no longer has, a lease, and a withdrawn offer. */
const RECOVERY_RETIRED_META_KEYS: ReadonlySet<string> = new Set([...READY_RETIRED_META_KEYS, REFERENCE_VIEW_RECOVERY_UNAVAILABLE_KEY]);

/**
 * The copy's meta: the failed row's, minus the failure state, plus
 * `recoveredFrom` — the failed row, the workflow and the blob the bytes came
 * from.
 *
 * The crop the recovery performed is recorded where a render records its own:
 * `meta.render.shape`, whose returned size, crop and pre-crop size become the
 * copy's, so the copy reads as the render that should have landed. A failed
 * row that recorded no shape has nowhere honest to put it, and keeps it under
 * `recoveredFrom` instead.
 */
function recoveredMeta(meta: unknown, output: ReferenceViewPaidOutput, shaped: ShapedProviderOutput): Record<string, unknown> {
  const failed = parseOr(metaRecordSchema, meta, {});
  const kept = Object.fromEntries(Object.entries(failed).filter(([key]) => !RECOVERY_RETIRED_META_KEYS.has(key)));
  const render = parseOrNull(metaRecordSchema, failed.render);
  const shape = render === null ? null : parseOrNull(metaRecordSchema, render.shape);
  const shapeFacts = { returned: shaped.returned, crop: shaped.crop, providerSize: shaped.providerSize };
  return {
    ...kept,
    ...(render !== null && shape !== null ? { render: { ...render, shape: { ...shape, ...shapeFacts } } } : {}),
    recoveredFrom: {
      imageId: output.imageId,
      workflowId: output.workflowId,
      blobId: output.blobId,
      ...(shape === null ? { crop: shaped.crop, providerSize: shaped.providerSize } : {}),
    },
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
