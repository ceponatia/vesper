import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { imageProfileTaskSchema, type ImageProfileTask } from "@vesper/image-core";
import { imageModelProvider } from "@vesper/image-models";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr, parseOrNull } from "@/lib/parse";
import { recoverCivitaiOutput } from "../ai";
import { db, images } from "../db";
import {
  mergeMetaSql,
  READY_RETIRED_META_KEYS,
  SHARP_DECODE_LIMITS,
  WEBP_QUALITY,
  type ImageKind,
  type ImageRow,
} from "./asset-storage";
import { shapeProviderOutput, type ProviderOutputShapeRequest, type ShapedProviderOutput } from "./provider-output-shape";

/**
 * **A PAID OUTPUT** — an image a provider rendered and billed that never reached
 * Vesper, and the one set of rules every surface recovers it by.
 *
 * A Civitai render can succeed and be billed while its output download fails or
 * its process dies mid-download. The render's row then records the workflow,
 * the output it never delivered and the model under `meta.render`
 * (`predictionId`, `undeliveredOutputId`, `modelSlug`) — written with the
 * failure, or before the download started (`recordPendingRenderOutput`). This
 * module owns what that record means and how its output is fetched again:
 *
 * - **The offer** ({@link paidOutputOffer}): a `failed` row whose `meta.render`
 *   records both ids on a Civitai model, and carries no
 *   {@link PAID_OUTPUT_UNAVAILABLE_KEY}, offers its output. What kind of row it
 *   is, and what the owner may do with the offer, is the caller's business.
 * - **The withdrawal** ({@link withdrawPaidOutputOffer}): once the provider has
 *   shown the output can never be fetched, the row is stamped and the offer
 *   ends for good.
 * - **The fetch** ({@link recoverPaidOutput}): read-only from the stored ids,
 *   never a new workflow or a charge; then the decode rule; then the output's
 *   shape, exactly as the live render would have cropped it. Its answer says
 *   whether a failure is `permanent` — the caller withdraws the offer — or
 *   transient, and the offer stands.
 * - **The recovered row's meta** ({@link recoveredOutputMeta}).
 *
 * Nothing here writes an image file or settles a lane's own record: each
 * surface stores the bytes and commits under its own rules.
 */

/**
 * The meta key that withdraws a recovery offer: an ISO timestamp stamped on the
 * failed render's row once the provider has shown its output can never be
 * fetched. Retention's own clock (`failedAt`) is left alone.
 */
export const PAID_OUTPUT_UNAVAILABLE_KEY = "recoveryUnavailableAt";

/** The ids a paid output is fetched again by. */
export interface PaidOutputIds {
  /** The provider workflow that rendered and billed it. */
  readonly workflowId: string;
  /** The output that workflow produced. */
  readonly blobId: string;
}

/** A paid output a failed render could not deliver, as its row offers it. */
export interface PaidOutput extends PaidOutputIds {
  /** The failed render's own images row — the offer. */
  readonly imageId: string;
}

/**
 * What a failed render's row offers: a paid output still to be fetched, an
 * output the provider has shown is gone for good (`withdrawn`), or nothing — a
 * failure that never had a paid output, such as a moderated render, or a
 * render on a model whose outputs cannot be fetched again.
 */
export type PaidOutputOffer =
  | { readonly state: "on_offer"; readonly output: PaidOutput }
  | { readonly state: "withdrawn" }
  | { readonly state: "none" };

const metaRecordSchema = z.record(z.string(), z.unknown());

/**
 * What a render's `meta.render` records when the provider rendered and billed
 * an output Vesper does not have. Parsed at the trust boundary; anything less
 * is a failure with nothing to recover.
 */
const undeliveredRenderSchema = z.object({
  predictionId: z.string().min(1),
  undeliveredOutputId: z.string().min(1),
  modelSlug: z.string().min(1),
});

/**
 * The paid output a render record (`meta.render`, or any record of the same
 * shape) names, or null: both ids, on a model whose provider can fetch an
 * output again from them — Civitai alone. Never throws.
 */
export function undeliveredRenderOutput(render: unknown): (PaidOutputIds & { readonly modelSlug: string }) | null {
  const parsed = parseOrNull(undeliveredRenderSchema, render);
  if (parsed === null || imageModelProvider(parsed.modelSlug) !== "civitai") return null;
  return { workflowId: parsed.predictionId, blobId: parsed.undeliveredOutputId, modelSlug: parsed.modelSlug };
}

/**
 * The one reading of a render's row as a recovery offer. Only a `failed` row
 * offers anything, only a Civitai render can be fetched again from its
 * workflow, and a stamped row has been withdrawn. Never throws.
 */
export function paidOutputOffer(asset: Pick<ImageRow, "id" | "status" | "meta">): PaidOutputOffer {
  if (asset.status !== "failed") return { state: "none" };
  const meta = parseOr(metaRecordSchema, asset.meta, {});
  const stamp = meta[PAID_OUTPUT_UNAVAILABLE_KEY];
  if (stamp !== undefined && stamp !== null) return { state: "withdrawn" };
  const output = undeliveredRenderOutput(meta.render);
  if (output === null) return { state: "none" };
  return { state: "on_offer", output: { imageId: asset.id, workflowId: output.workflowId, blobId: output.blobId } };
}

/**
 * Withdraw a failed render's recovery offer: stamp
 * {@link PAID_OUTPUT_UNAVAILABLE_KEY} into its meta once the provider has shown
 * the output can never be fetched, so nothing offers it again. A SQL-side merge
 * scoped to the owner, to the caller's kind and to a row that is still
 * `failed`, so it writes that one key and nothing else, and leaves retention's
 * `failedAt` clock where it was. True when the row took the stamp.
 */
export async function withdrawPaidOutputOffer(
  input: { imageId: string; ownerId: string; kind: ImageKind },
  at: Date = new Date(),
): Promise<boolean> {
  const stamped = await db()
    .update(images)
    .set({ meta: mergeMetaSql({ [PAID_OUTPUT_UNAVAILABLE_KEY]: at.toISOString() }) })
    .where(and(
      eq(images.id, input.imageId),
      eq(images.ownerId, input.ownerId),
      eq(images.kind, input.kind),
      eq(images.status, "failed"),
    ))
    .returning({ id: images.id });
  return stamped.length > 0;
}

/**
 * The shape a lane's live render asks for, as far as recovery needs it: what a
 * recovery crops toward when the failed row recorded no shape — a render whose
 * process died before it settled records only its ids.
 */
export interface PaidOutputLaneShape {
  /** The lane's profile task; it decides only whether a too-tall trim anchors to the top. */
  readonly task: ImageProfileTask;
  /** The ratio the lane renders at, or null for the model's own shape — which is never cropped. */
  readonly targetRatio: number | null;
  /** The ratio the lane expects back, or null when nothing can say. */
  readonly expectedAspect: number | null;
}

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
 * Without a readable record the lane's own request stands (`lane`): its task,
 * its ratio, and what it expects back. A recorded task and model win over the
 * lane's, as they are what the render actually ran.
 */
export function recordedShapeRequest(meta: unknown, lane: PaidOutputLaneShape): ProviderOutputShapeRequest {
  const render = parseOr(metaRecordSchema, parseOr(metaRecordSchema, meta, {}).render, {});
  const task = parseOrNull(imageProfileTaskSchema, render.task) ?? lane.task;
  const modelSlug = typeof render.modelSlug === "string" ? render.modelSlug : undefined;
  const shape = parseOrNull(recordedShapeSchema, render.shape);
  const base = { task, ...(modelSlug === undefined ? {} : { modelSlug }) };
  if (shape === null) return { ...base, targetRatio: lane.targetRatio, expectedAspect: lane.expectedAspect };
  if (shape.mode === "provider_default") return { ...base, targetRatio: null, expectedAspect: shape.expectedAspect };
  return { ...base, targetRatio: shape.requestedAspect ?? lane.targetRatio, expectedAspect: shape.expectedAspect };
}

/**
 * What one recovery of a paid output came to: the bytes, shaped as the live
 * render would have stored them; or a failure that is `permanent` — the
 * provider has shown the output can never be fetched, or it serves bytes that
 * can never be decoded, so the caller withdraws the offer — or transient, and
 * the offer stands.
 */
export type PaidOutputRecovery =
  | { readonly ok: true; readonly shaped: ShapedProviderOutput }
  | { readonly ok: false; readonly permanent: boolean; readonly error: string };

/**
 * Fetch a paid output again and make it storable, never paying for it twice:
 *
 * 1. **Fetch**, read-only, from the stored workflow and output
 *    (`recoverCivitaiOutput`) — never a new workflow or a charge. Its own
 *    `permanent` answer stands; a throw is a defect, and a defect is never
 *    evidence the output is gone, so it reads as transient.
 * 2. **The decode rule.** Bytes sharp cannot decode, or cannot encode as the
 *    stored webp, are the provider's stored output and fail the same way on
 *    every fetch, so they are permanent too.
 * 3. **Shape** the provider's original exactly as the render would have
 *    (`shapeProviderOutput`), from `shape` — normally
 *    {@link recordedShapeRequest} over the failed row's meta.
 *
 * Anything that fails after this — the disk, the database — is the caller's,
 * and transient.
 */
export async function recoverPaidOutput(input: {
  workflowId: string;
  blobId: string;
  shape: ProviderOutputShapeRequest;
  sink?: DiagnosticSink;
}): Promise<PaidOutputRecovery> {
  let fetched: Awaited<ReturnType<typeof recoverCivitaiOutput>>;
  try {
    fetched = await recoverCivitaiOutput({ workflowId: input.workflowId, blobId: input.blobId });
  } catch (error) {
    fetched = { ok: false, permanent: false, error: errorText(error) };
  }
  if (!fetched.ok) return { ok: false, permanent: fetched.permanent, error: fetched.error };
  const undecodable = await undecodableReason(fetched.image);
  if (undecodable !== null) {
    return { ok: false, permanent: true, error: `the fetched output cannot be decoded and stored: ${undecodable}` };
  }
  return { ok: true, shaped: await shapeProviderOutput(fetched.image, input.shape, input.sink) };
}

/**
 * Why sharp cannot decode these bytes and encode them as the stored webp, or
 * null when it can: `writeWebpAtomic`'s own decode limits and encoder, run in
 * memory before anything is written.
 */
async function undecodableReason(bytes: Buffer): Promise<string | null> {
  try {
    await sharp(bytes, SHARP_DECODE_LIMITS).webp({ quality: WEBP_QUALITY }).toBuffer();
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** The keys a recovered row never carries: a failure it no longer has, a lease, and a withdrawn offer. */
const RECOVERY_RETIRED_META_KEYS: ReadonlySet<string> = new Set([...READY_RETIRED_META_KEYS, PAID_OUTPUT_UNAVAILABLE_KEY]);

/**
 * The recovered row's meta: the failed row's, minus the failure state, plus
 * `recoveredFrom` — the workflow and the output the bytes came from, and the
 * failed row when the recovery stored them on a NEW row (`from.imageId`).
 *
 * The crop the recovery performed is recorded where a render records its own:
 * `meta.render.shape`, whose returned size, crop and pre-crop size become the
 * recovered row's, so it reads as the render that should have landed. A failed
 * row that recorded no shape has nowhere honest to put it, and keeps it under
 * `recoveredFrom` instead.
 */
export function recoveredOutputMeta(
  meta: unknown,
  from: PaidOutputIds & { readonly imageId?: string },
  shaped: ShapedProviderOutput,
): Record<string, unknown> {
  const failed = parseOr(metaRecordSchema, meta, {});
  const kept = Object.fromEntries(Object.entries(failed).filter(([key]) => !RECOVERY_RETIRED_META_KEYS.has(key)));
  const render = parseOrNull(metaRecordSchema, failed.render);
  const shape = render === null ? null : parseOrNull(metaRecordSchema, render.shape);
  const shapeFacts = { returned: shaped.returned, crop: shaped.crop, providerSize: shaped.providerSize };
  return {
    ...kept,
    ...(render !== null && shape !== null ? { render: { ...render, shape: { ...shape, ...shapeFacts } } } : {}),
    recoveredFrom: {
      ...(from.imageId === undefined ? {} : { imageId: from.imageId }),
      workflowId: from.workflowId,
      blobId: from.blobId,
      ...(shape === null ? { crop: shaped.crop, providerSize: shaped.providerSize } : {}),
    },
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
