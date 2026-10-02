import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { IMAGE_TARGET_ASPECT } from "@vesper/image-core";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { log, logDiagnostics } from "@/server/log";
import { db, images } from "../db";
import {
  imageMeta,
  mergeMetaSql,
  READY_RETIRED_META_KEYS,
  RENDER_LEASE_META_KEY,
  writeWebpAtomic,
  type ImageKind,
  type ImageRow,
  type WrittenImageInfo,
} from "./asset-storage";
import { holdRenderLease } from "./assets";
import {
  PAID_OUTPUT_UNAVAILABLE_KEY,
  paidOutputOffer,
  recordedShapeRequest,
  recoveredOutputMeta,
  recoverPaidOutput,
  type PaidOutput,
  type PaidOutputLaneShape,
} from "./paid-output";
import type { ShapedProviderOutput } from "./provider-output-shape";
import { absoluteImagePath } from "./paths";

/**
 * **RECOVERING A PAID OUTPUT IN PLACE** — a failed portrait variant, avatar or
 * scene (a selfie included) whose render was billed but never delivered,
 * fetched again and stored on its own row, with no new render.
 *
 * The failed row records the workflow and the output under `meta.render`
 * (`paidOutputOffer`, `paid-output.ts`): with the failure itself, or before the
 * download started when the process died mid-download. Recovery turns that row
 * into the render it should have been — `ready`, with the output's bytes at its
 * own path — for nothing: no admission, no budget charge, no job, and never a
 * new workflow. Reference views keep their own recovery
 * (`reference-view-recovery.ts`), because their attempt rows, not their images
 * rows, are what the sheet reads.
 *
 * **The claim** is the row itself. A guarded `failed → pending` transition that
 * re-checks the offer in its own WHERE takes it, stamps a render lease, and
 * names this run with a claim token (`meta.recoveryClaim`). From there the row
 * reads as a live render to everything else: the sweep leaves it alone while
 * the lease beats, retention never sees a `failed` row, the studio and the chat
 * poll it like a render in progress, and a second recovery answers `busy`. The
 * row keeps its `error` and `failedAt` through the claim, so a recovery that
 * gives the row back leaves retention's clock exactly where it was. Every write
 * that ends the claim is guarded on the token, so only this run can end it:
 *
 * - **Recovered:** `→ ready`, with the file facts, the output's shape recorded
 *   where a render records its own, `recoveredFrom`, and the failure, lease,
 *   withdrawal and claim keys retired. The token guard also accepts a row the
 *   sweep reclaimed under this run (its lease went quiet on a database
 *   hiccup), exactly as a late landing saves onto a reclaimed row.
 * - **Transient failure:** `→ failed`, lease and claim retired; the original
 *   `error` and `failedAt` stand and the offer stands.
 * - **Permanent failure** (the provider shows the output is gone, or the bytes
 *   can never be decoded): `→ failed` with `recoveryUnavailableAt`; the offer
 *   is withdrawn.
 * - **The process dies:** the lease goes quiet and the sweep reclaims the row
 *   after `JOB_STALE_MS`, keeping `meta.render`, so the offer stands.
 * - **The owner deletes the row mid-recovery:** the answer is `not_found`, and
 *   a file already written is an orphan the sweep removes. Retention never
 *   deletes a claimed row: its purge is guarded on `failed`
 *   (`purgeRetiredFailedRows`).
 *
 * Nothing moves a pointer on recovery (owner ruling 2026-10-02): a recovered
 * avatar is a ready candidate the owner promotes with the existing action, a
 * recovered scene or selfie appears where its anchor message is, and no lane's
 * `onReady` runs.
 *
 * Every answer is a value and nothing here throws.
 */

/** The one live spelling of the recovery's diagnostic scope. */
const SCOPE = "images.output_recovery";

/** A failed row's paid output was stored on it, with no new render. */
export const IMAGE_OUTPUT_RECOVERED = `${SCOPE}.recovered`;

/** A failed row's paid output can never be fetched or stored; its offer was withdrawn. */
export const IMAGE_OUTPUT_EXPIRED = `${SCOPE}.expired`;

/** A failed row's paid output could not be recovered this time; its offer stands. */
export const IMAGE_OUTPUT_UNAVAILABLE = `${SCOPE}.unavailable`;

/** The kinds recovered in place. A reference view has its own recovery and answers `ineligible` here. */
export const RECOVERABLE_IMAGE_KINDS = ["avatar", "portrait_variant", "scene"] as const satisfies readonly ImageKind[];

type RecoverableImageKind = (typeof RECOVERABLE_IMAGE_KINDS)[number];

function isRecoverableKind(kind: ImageKind): kind is RecoverableImageKind {
  return (RECOVERABLE_IMAGE_KINDS as readonly ImageKind[]).includes(kind);
}

/**
 * What each lane's live render asks for, which a recovery crops toward when the
 * failed row recorded no shape of its own (a render whose process died
 * mid-download records only its ids). Each lane renders at Vesper's 3:4 target
 * (`IMAGE_TARGET_ASPECT`) on its own profile task, with nothing expected back.
 */
const LANE_SHAPES: Readonly<Record<RecoverableImageKind, PaidOutputLaneShape>> = {
  avatar: { task: "portrait", targetRatio: IMAGE_TARGET_ASPECT, expectedAspect: null },
  portrait_variant: { task: "variant", targetRatio: IMAGE_TARGET_ASPECT, expectedAspect: null },
  scene: { task: "scene", targetRatio: IMAGE_TARGET_ASPECT, expectedAspect: null },
};

/** The meta key naming the recovery run that holds a claimed row. */
export const RECOVERY_CLAIM_META_KEY = "recoveryClaim";

/**
 * Whether a row offers its paid output for in-place recovery right now: a kind
 * recovered in place, and a `failed` row whose output is on offer. The DTO's
 * `recoverable` flag. Never throws.
 */
export function imageOutputRecoverable(row: Pick<ImageRow, "id" | "kind" | "status" | "meta">): boolean {
  return isRecoverableKind(row.kind) && paidOutputOffer(row).state === "on_offer";
}

/**
 * Why a recovery did not store anything. `busy` — a render or another recovery
 * holds the row; `ineligible` — the row is not a failed render of a kind
 * recovered in place with a paid output to offer; `expired` — the provider has
 * shown the output is gone for good; `unavailable` — this attempt failed and the
 * offer stands.
 */
export type ImageOutputRecoveryRefusal = "not_found" | "ineligible" | "busy" | "expired" | "unavailable";

export type RecoverImageOutputResult =
  | { status: "recovered"; image: ImageRow }
  | { status: ImageOutputRecoveryRefusal };

export interface RecoverImageOutputInput {
  imageId: string;
  ownerId: string;
  /** Where the recovery's diagnostics are also said. They always reach the process log. */
  sink?: DiagnosticSink;
}

/** Recover one failed row's paid output onto the row itself. Never throws. */
export async function recoverImageOutput(input: RecoverImageOutputInput): Promise<RecoverImageOutputResult> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    return await recover(input, sink);
  } catch (error) {
    // Only the reads and the claim itself reach here: a run that holds the
    // claim answers for itself and gives the row back.
    reportUnavailable(sink, { imageId: input.imageId }, "error", errorText(error));
    return { status: "unavailable" };
  } finally {
    logDiagnostics(SCOPE, collected.items, { imageId: input.imageId });
  }
}

/** What the row offers right now, or why it offers nothing to this request. */
type OfferRead =
  | { readonly ok: true; readonly kind: RecoverableImageKind; readonly output: PaidOutput }
  | { readonly ok: false; readonly refusal: ImageOutputRecoveryRefusal };

function readOffer(row: ImageRow | undefined): OfferRead {
  if (row === undefined) return { ok: false, refusal: "not_found" };
  if (!isRecoverableKind(row.kind)) return { ok: false, refusal: "ineligible" };
  if (row.status === "pending") return { ok: false, refusal: "busy" };
  if (row.status !== "failed") return { ok: false, refusal: "ineligible" };
  const offer = paidOutputOffer(row);
  if (offer.state === "withdrawn") return { ok: false, refusal: "expired" };
  if (offer.state === "none") return { ok: false, refusal: "ineligible" };
  return { ok: true, kind: row.kind, output: offer.output };
}

async function readOwnedRow(imageId: string, ownerId: string): Promise<ImageRow | undefined> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  return row;
}

async function recover(input: RecoverImageOutputInput, sink: DiagnosticSink): Promise<RecoverImageOutputResult> {
  const read = readOffer(await readOwnedRow(input.imageId, input.ownerId));
  if (!read.ok) return { status: read.refusal };
  const token = newId();
  const claimed = await claimRow(input.ownerId, read.output, token, new Date());
  if (claimed === null) {
    // The row moved between the read and the claim: answer for what it is now.
    // A row that still reads as an offer lost the claim to another request.
    const now = readOffer(await readOwnedRow(input.imageId, input.ownerId));
    return { status: now.ok ? "busy" : now.refusal };
  }
  const context = { imageId: claimed.id, kind: read.kind, workflowId: read.output.workflowId };
  const releaseLease = await holdRenderLease(claimed.id);
  try {
    return await recoverUnderClaim(input, claimed, read.kind, read.output, token, context, sink);
  } catch (error) {
    // A defect, or the disk or the database failing after the bytes decoded:
    // transient, so the row goes back with its offer standing.
    reportUnavailable(sink, context, "error", errorText(error));
    await endClaim(claimed.id, input.ownerId, token, "transient");
    return { status: "unavailable" };
  } finally {
    releaseLease();
  }
}

/** Everything after the claim: fetch, decode, shape, write, install. */
async function recoverUnderClaim(
  input: RecoverImageOutputInput,
  claimed: ImageRow,
  kind: RecoverableImageKind,
  output: PaidOutput,
  token: string,
  context: Record<string, unknown>,
  sink: DiagnosticSink,
): Promise<RecoverImageOutputResult> {
  const recovered = await recoverPaidOutput({
    workflowId: output.workflowId,
    blobId: output.blobId,
    shape: recordedShapeRequest(claimed.meta, LANE_SHAPES[kind]),
    sink,
  });
  if (!recovered.ok) {
    if (recovered.permanent) {
      const withdrawn = await endClaim(claimed.id, input.ownerId, token, "withdrawn");
      sink.push(
        diag("warn", IMAGE_OUTPUT_EXPIRED, "a failed image's paid output can never be recovered; its recovery offer is withdrawn", {
          path: SCOPE,
          context: { ...context, withdrawn, error: recovered.error.slice(0, 300) },
        }),
      );
      return { status: "expired" };
    }
    reportUnavailable(sink, context, "fetch", recovered.error);
    await endClaim(claimed.id, input.ownerId, token, "transient");
    return { status: "unavailable" };
  }

  // The one webp writer every stored image goes through, at the row's own path.
  const written = await writeWebpAtomic(absoluteImagePath(claimed), recovered.shaped.image);
  const installed = await installRecovered(claimed, input.ownerId, token, output, recovered.shaped, written);
  if (installed !== null) {
    sink.push(
      diag("info", IMAGE_OUTPUT_RECOVERED, "a failed image's paid output was recovered onto its own row, with no new render", {
        path: SCOPE,
        context,
      }),
    );
    return { status: "recovered", image: installed };
  }

  // The claim was lost while the bytes were in flight. Answer for the row as it
  // reads now: gone, landed after all, or held by another recovery.
  const now = await readOwnedRow(input.imageId, input.ownerId);
  if (now === undefined) return { status: "not_found" };
  if (now.status === "ready") return { status: "recovered", image: now };
  reportUnavailable(sink, context, "claim", "the recovery's claim on the row was lost before it could install");
  return { status: now.status === "pending" ? "busy" : "unavailable" };
}

/**
 * Take a failed row for one recovery: `failed → pending` with a fresh render
 * lease and this run's claim token, guarded in its own WHERE on the owner, a
 * kind recovered in place, `failed`, the same workflow and output ids, and no
 * withdrawal stamp. The row's other keys — `error` and `failedAt` included —
 * stay as they were. Null when the row no longer matches.
 */
async function claimRow(ownerId: string, output: PaidOutput, token: string, now: Date): Promise<ImageRow | null> {
  const [row] = await db()
    .update(images)
    .set({
      status: "pending",
      meta: mergeMetaSql({ [RENDER_LEASE_META_KEY]: now.getTime(), [RECOVERY_CLAIM_META_KEY]: token }),
    })
    .where(and(
      eq(images.id, output.imageId),
      eq(images.ownerId, ownerId),
      inArray(images.kind, [...RECOVERABLE_IMAGE_KINDS]),
      eq(images.status, "failed"),
      sql`(${images.meta} -> 'render' ->> 'predictionId') = ${output.workflowId}`,
      sql`(${images.meta} -> 'render' ->> 'undeliveredOutputId') = ${output.blobId}`,
      sql`coalesce(jsonb_typeof(${images.meta} -> ${PAID_OUTPUT_UNAVAILABLE_KEY}::text), 'null') = 'null'`,
    ))
    .returning();
  return row ?? null;
}

/**
 * The guard every write that ends a claim carries: the row still names this
 * run's token, and is `pending` — or `failed`, when the sweep reclaimed it under
 * this run because its lease went quiet. A second recovery's claim replaces the
 * token, so this run can never end, or install over, another run's claim.
 */
function heldBy(token: string): SQL | undefined {
  return and(
    inArray(images.status, ["pending", "failed"]),
    sql`(${images.meta} ->> ${RECOVERY_CLAIM_META_KEY}::text) = ${token}`,
  );
}

/** The keys a recovered row never carries: a failure, a lease, a withdrawn offer, and a claim. */
const INSTALL_RETIRED_META_KEYS = [...READY_RETIRED_META_KEYS, PAID_OUTPUT_UNAVAILABLE_KEY, RECOVERY_CLAIM_META_KEY] as const;

/**
 * Install the recovered output: `→ ready` with its byte count, the recovered
 * meta (`recoveredOutputMeta`, in place, so no `recoveredFrom.imageId`) and the
 * file facts the write recorded — the file facts win a key collision, exactly
 * as `saveImageBuffer` lets them. Merged in SQL over the row as it reads now.
 * Null when this run no longer holds the claim.
 */
async function installRecovered(
  claimed: ImageRow,
  ownerId: string,
  token: string,
  output: PaidOutput,
  shaped: ShapedProviderOutput,
  written: WrittenImageInfo,
): Promise<ImageRow | null> {
  const claimedMeta = Object.fromEntries(
    Object.entries(imageMeta(claimed.meta)).filter(([key]) => key !== RECOVERY_CLAIM_META_KEY),
  );
  const patch = {
    ...recoveredOutputMeta(claimedMeta, { workflowId: output.workflowId, blobId: output.blobId }, shaped),
    width: written.width,
    height: written.height,
    bytes: written.bytes,
  };
  const [row] = await db()
    .update(images)
    .set({ status: "ready", bytes: written.bytes, meta: mergeMetaSql(patch, INSTALL_RETIRED_META_KEYS) })
    .where(and(eq(images.id, claimed.id), eq(images.ownerId, ownerId), heldBy(token)))
    .returning();
  return row ?? null;
}

/**
 * Give a claimed row back as `failed`: the lease and the claim retired, and —
 * for a permanent answer — the offer withdrawn with `recoveryUnavailableAt`.
 * The row's `error` and `failedAt` are untouched, so retention's clock does not
 * move. Best-effort: a row this cannot give back stops being beaten and the
 * sweep reclaims it within `JOB_STALE_MS`, keeping its offer. True when this
 * run's claim took the write.
 */
async function endClaim(imageId: string, ownerId: string, token: string, end: "transient" | "withdrawn"): Promise<boolean> {
  try {
    const ended = await db()
      .update(images)
      .set({
        status: "failed",
        meta: mergeMetaSql(
          end === "withdrawn" ? { [PAID_OUTPUT_UNAVAILABLE_KEY]: new Date().toISOString() } : {},
          [RENDER_LEASE_META_KEY, RECOVERY_CLAIM_META_KEY],
        ),
      })
      .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), heldBy(token)))
      .returning({ id: images.id });
    return ended.length > 0;
  } catch (error) {
    log.warn("images", "a recovery's claim on its row could not be given back; the sweep reclaims it", {
      imageId,
      error: errorText(error),
    });
    return false;
  }
}

/** The offer stands; this attempt did not recover it. */
function reportUnavailable(
  sink: DiagnosticSink,
  context: Record<string, unknown>,
  stage: "fetch" | "claim" | "error",
  error: string,
): void {
  sink.push(
    diag("warn", IMAGE_OUTPUT_UNAVAILABLE, "a failed image's paid output could not be recovered this time; its recovery offer stands", {
      path: SCOPE,
      context: { ...context, stage, error: error.slice(0, 300) },
    }),
  );
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
