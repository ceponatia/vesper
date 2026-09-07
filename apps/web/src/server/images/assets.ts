import { describeProviderError } from "../ai";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  type ImageRow,
  type CreateImageAssetOptions,
  createImageAsset,
  saveImageBuffer,
  failImage,
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
 *   save or fail update — the render-provenance channel; a THROWN produce has
 *   none to offer.
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

  const startedMs = Date.now();
  try {
    const produced = await opts.produce(asset);
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
    await failImage(asset.id, message);
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
  }
}
