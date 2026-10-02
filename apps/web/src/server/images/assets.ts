import { describeProviderError, withPaidRenderOutputRecorder, type PaidRenderOutput, type PaidRenderOutputRecorder } from "../ai";
import { JOB_HEARTBEAT_INTERVAL_MS } from "../db";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import {
  type ImageRow,
  type CreateImageAssetOptions,
  createImageAsset,
  saveImageBuffer,
  failImage,
  recordPendingRenderOutput,
  refreshRenderLease,
} from "./asset-storage";
import { kickImageSweep } from "./asset-maintenance";

/**
 * What a lane's generate step hands back: bytes to save, or the text a failed
 * row records — either way with an optional meta contribution the pipeline
 * merges into the row (the attempt provenance under `render`, on failures too,
 * because a failed prediction's id is what an operator traces).
 */
export type ImageProduceResult =
  | { ok: true; image: Buffer; meta?: Record<string, unknown> }
  | { ok: false; error: string; meta?: Record<string, unknown> };

/**
 * A produce failure that THROWS — a lane's ruled throw shape: the shell's warn
 * diagnostic and the error-carrying `onThrown` event line — and still hands the
 * pipeline the attempt's meta, which the failed row records exactly as a
 * returned failure's would (the attempt provenance under `render`). Without it
 * a thrown render's row keeps no attempt record, and any paid output's ids
 * recorded before its download outlive a failure that already proved the
 * output unrecoverable.
 */
export class ImageProduceError extends Error {
  readonly meta: Record<string, unknown> | undefined;

  constructor(message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = "ImageProduceError";
    this.meta = meta;
  }
}

/** `ready` ⇒ the file landed and the row says so; `failed` ⇒ the row carries the reason. */
export type ImagePipelineStatus = "ready" | "failed";

export interface ImagePipelineOutcome {
  imageId: string;
  status: ImagePipelineStatus;
  /** When generation started (after the reserve) — the lanes' `durationMs` baseline. */
  startedMs: number;
}

export interface ImagePipelineThrown {
  imageId: string;
  /** `describeProviderError`'s text — already written to the row. */
  message: string;
  startedMs: number;
}

export interface ImagePipelineOptions {
  /** The row reserved before anything is generated. */
  asset: CreateImageAssetOptions;
  /** Non-null ⇒ fail the reserved row with this text and stop: no generation, no hooks. */
  failedPrecondition?: string | null;
  /** Runs once the row exists, before the generation clock starts. */
  afterReserve?: (asset: ImageRow) => Promise<void>;
  /** The generation step, handed its own reserved row. Anything it throws is caught here. */
  produce: (asset: ImageRow) => Promise<ImageProduceResult>;
  /** Runs only when the file landed and the row reads `ready`. */
  onReady?: (asset: ImageRow) => Promise<void>;
  /** Produce returned (saved or failed) — the lane's event log. */
  onSettled?: (outcome: ImagePipelineOutcome) => void;
  /** Produce threw — the row is already failed with `message`. */
  onThrown?: (outcome: ImagePipelineThrown) => void;
  /** Warn diagnostic recorded when produce throws; `imageId` joins any context supplied. */
  failureDiagnostic?: { code: string; context?: Record<string, unknown> };
  sink?: DiagnosticSink;
}

export interface ImagePipelineResult {
  imageId: string;
  status: ImagePipelineStatus;
}

/**
 * The one reserve → generate → save-or-fail → log sequence every image lane runs
 * (audit C1). Six copies of it had
 * already drifted in ways nobody decided — one lane recorded a failure
 * diagnostic and its neighbour didn't — so the ordering, and with it the
 * row-before-file invariant (docs/images/asset-registry.md), lives here and nowhere else:
 *
 *   reserve → afterReserve → precondition → produce → save-or-fail → onReady → log
 *
 * The shell owns execution, never the answer: each lane keeps its own return
 * type, event payload and diagnostics, and every hook below exists because a
 * lane needs it.
 *
 * - **`failedPrecondition`** — the "row exists, nothing was attempted" shape.
 *   avatar/entity/variants reserve the row BEFORE they know the character or
 *   entity is missing, then fail it with no event log and no diagnostic. Lanes
 *   whose precondition is cheaper than a row (the chat look/place anchors: demo
 *   mode, no provider key) return before calling in at all — the shell supports
 *   both orderings because it never moves the reserve relative to a lane's own
 *   checks.
 * - **`afterReserve`** — work that belongs to the row rather than to the
 *   generation, and so must not be on the clock: the scene lane's
 *   `image_references` rows.
 * - **`produce`** — the provider call. Bytes, or a structured failure for a
 *   provider that reports one instead of throwing (the scene chain exhausting
 *   every rung; a reference edit returning `ok: false`). Whatever it throws is
 *   caught here and `describeProviderError` writes the row's failure text, so no
 *   lane repeats that. Either arm may carry `meta`, merged into the row in the
 *   save or fail update — the render-provenance channel. A THROWN produce has
 *   none to offer unless it throws an {@link ImageProduceError}, whose `meta`
 *   the failed row records the same way.
 * - **`onReady`** — the pointer writes that are only correct once the file
 *   exists: `characters.avatar_image_id`, an entity's `image_id` + reclaim, the
 *   look anchor's keep-latest purge.
 * - **`onSettled` / `onThrown`** — the per-lane event log, injected by the
 *   caller (ruled: the event log stays per-lane, and a lane without one gains
 *   none). Two hooks rather than one because avatar and entity log a DIFFERENT
 *   payload when the provider threw (`error`, no `demo`/`durationMs`) than when
 *   it settled, while variants and scene log the same line either way.
 * - **`failureDiagnostic`** — the warn diagnostic for a THROWN generation
 *   failure; the failing row's `imageId` joins whatever context is supplied, and
 *   supplying none leaves the diagnostic context-free (the chat look/place
 *   shape). A lane whose generation failure is a RETURNED failure pushes its own
 *   diagnostic at that branch, because only the lane can tell a precondition it
 *   cannot satisfy (variants with no reference avatar — diagnostic-free, exactly
 *   like entity's not-found) from a generation that actually failed.
 *
 * **Lane differences preserved, not normalized:** avatar/entity/variants/scene
 * return the asset id even when the row failed, while the chat anchors return
 * null; variants stamps `durationMs` on its failure event and avatar/entity do
 * not; the chat anchors log no event at all; only the scene lane keeps a
 * diagnostic COLLECTOR (its provider chain's fallback record), and it drains
 * that itself around this call, as its `finally` always did.
 *
 * **The one ruled normalization** (ruled 2026-07-30 — a
 * deliberate resilience improvement, not behaviour-neutral cleanup): a
 * generation failure now records a warn diagnostic in every lane.
 * `images.avatar.generate_failed` and `images.variant.generate_failed` joined
 * the entity lane's long-standing `images.entity.generate_failed`.
 *
 * **The render lease.** From the moment generation starts until it settles, the
 * shell beats a lease into its own row ({@link holdRenderLease}), which is how
 * the sweep tells a render still running — a Civitai queue wait, every rung of a
 * scene chain — from one whose process died (docs/images/asset-registry.md
 * §The sweep).
 *
 * **A paid output's ids.** `produce` runs with a paid-output recorder installed
 * on this row ({@link paidOutputRecorderForRow}): a provider lane that has a
 * succeeded, billed output records its workflow and output ids here before it
 * downloads, so a render whose process dies mid-download leaves a row that
 * offers the output for recovery instead of nothing.
 */
export async function runImagePipeline(opts: ImagePipelineOptions): Promise<ImagePipelineResult> {
  // Periodic maintenance rides the work it maintains:
  // fire-and-forget, throttled by asset-maintenance, and deliberately
  // BEFORE the generation — a render that dies mid-flight is precisely the row a
  // later sweep has to reclaim, so the kick must not depend on reaching the end.
  kickImageSweep();
  const asset = await createImageAsset(opts.asset);
  await opts.afterReserve?.(asset);

  const precondition = opts.failedPrecondition ?? null;
  if (precondition !== null) {
    await failImage(asset.id, precondition);
    return { imageId: asset.id, status: "failed" };
  }

  const releaseLease = await holdRenderLease(asset.id);
  const startedMs = Date.now();
  try {
    const produced = await withPaidRenderOutputRecorder(paidOutputRecorderForRow(asset.id), () => opts.produce(asset));
    if (!produced.ok) {
      await failImage(asset.id, produced.error, produced.meta);
      opts.onSettled?.({ imageId: asset.id, status: "failed", startedMs });
      return { imageId: asset.id, status: "failed" };
    }
    const saved = await saveImageBuffer(asset.id, produced.image, opts.sink, produced.meta);
    const status: ImagePipelineStatus = saved?.status === "ready" ? "ready" : "failed";
    if (status === "ready") await opts.onReady?.(asset);
    opts.onSettled?.({ imageId: asset.id, status, startedMs });
    return { imageId: asset.id, status };
  } catch (err) {
    const message = describeProviderError(err);
    await failImage(asset.id, message, err instanceof ImageProduceError ? err.meta : undefined);
    const failure = opts.failureDiagnostic;
    if (failure) {
      opts.sink?.push(
        diag(
          "warn",
          failure.code,
          message.slice(0, 300),
          failure.context ? { context: { ...failure.context, imageId: asset.id } } : undefined,
        ),
      );
    }
    opts.onThrown?.({ imageId: asset.id, message, startedMs });
    return { imageId: asset.id, status: "failed" };
  } finally {
    releaseLease();
  }
}

/**
 * A paid-output recorder for one render's row (`withPaidRenderOutputRecorder`):
 * a provider lane that has a succeeded, billed output in hand records its ids on
 * the row before it downloads ({@link recordPendingRenderOutput}), so a process
 * that dies mid-download leaves the row offering that output for recovery once
 * it is failed (docs/images/asset-registry.md §The sweep). The pipeline installs
 * one with no attempt around every `produce`; a lane that runs several attempts
 * on one row (the scene chain's rungs) installs one per attempt, naming it, so
 * a slow record lands only while the row still names that attempt.
 *
 * Best-effort like the lease heartbeat: a write that fails, or a row that
 * already left `pending` or moved to another attempt, is logged and the render
 * carries on. The lane bounds how long it waits for this, so a database that is
 * not answering never holds a paid download back.
 */
export function paidOutputRecorderForRow(imageId: string, attempt?: string): PaidRenderOutputRecorder {
  return (output) => recordPaidOutputOnRow(imageId, output, attempt);
}

async function recordPaidOutputOnRow(imageId: string, output: PaidRenderOutput, attempt: string | undefined): Promise<void> {
  try {
    const recorded = await recordPendingRenderOutput(imageId, {
      predictionId: output.predictionId,
      undeliveredOutputId: output.outputId,
      modelSlug: output.modelSlug,
    }, attempt);
    if (!recorded) {
      log.warn("images", "a paid output's ids reached a render row no longer pending on that attempt; not recorded", {
        imageId,
        predictionId: output.predictionId,
        ...(attempt === undefined ? {} : { attempt }),
      });
    }
  } catch (error) {
    log.warn("images", "a paid output's ids could not be recorded on its render row before the download", {
      imageId,
      predictionId: output.predictionId,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
}

/**
 * Hold the render lease on a reserved row for as long as its render runs: one
 * stamp now, then one every {@link JOB_HEARTBEAT_INTERVAL_MS} (30 s), against the
 * sweep's 15-minute silence bound (`JOB_STALE_MS`). Returns the release the pipeline's
 * `finally` calls once the render settles — saved, failed or thrown. An in-place
 * recovery of a paid output holds the same lease on the row it claimed
 * (`image-output-recovery.ts`), so the sweep treats it as the live render it is.
 *
 * This is the job heartbeat's shape (`launchInsertedJob` in `api/jobs.ts`), not
 * the timer the sweep refuses to be: it is scoped to one render's lifetime,
 * cleared in `finally`, unref'd so it never holds the process open, and each
 * beat is a guarded write that a row which already left `pending` ignores.
 * Best-effort like that heartbeat too: a failed write is swallowed, and a lease
 * the database stops taking simply ages until the sweep reclaims the row, as it
 * would for a render whose process died; if this render then lands after all,
 * the save takes the late-landing path (`saveImageBuffer`). Each beat is
 * independent, as there: one stuck on a dead connection or an exhausted pool
 * (the client sets no query timeout) never holds back the next, and beats that
 * overlap are harmless because each is the same guarded, idempotent write.
 */
export async function holdRenderLease(imageId: string): Promise<() => void> {
  const beat = async (): Promise<void> => {
    try {
      await refreshRenderLease(imageId, Date.now());
    } catch {
      // Heartbeats are best-effort. The lease expires if the database remains unavailable.
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), JOB_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
