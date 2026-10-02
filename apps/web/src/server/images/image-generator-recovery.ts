import { and, eq } from "drizzle-orm";
import type { ImageGeneratorRun } from "@/contracts/images/image-generator";
import { imageGeneratorRunOutputs } from "@/contracts/images/image-generator-outputs";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { log, logDiagnostics } from "@/server/log";
import { db, imageGeneratorRuns } from "../db";
import { createImageAsset, imageMeta, saveImageBuffer } from "./asset-storage";
import { deleteOwnedImage } from "./asset-deletion";
import {
  generatorRunMeta,
  imageGeneratorOutputOffer,
  ownedGeneratorRun,
  toWireImageGeneratorRun,
  type ImageGeneratorRunRow,
} from "./image-generator-store";
import {
  recordedShapeRequest,
  recoverPaidOutput,
  type PaidOutputLaneShape,
} from "./paid-output";

/**
 * **RECOVERING A PAID BENCH OUTPUT** — the image one Image Generator pass
 * already rendered and billed, fetched again and installed with no new
 * prediction (#686, the bench slice of #682's design).
 *
 * A Civitai prediction inside a bench run can succeed and be billed while its
 * output download fails. Unlike a reference view, a failed bench pass never
 * gets an `images` row of its own — the settle loop only ever creates one for
 * a pass that returned bytes — so the whole offer lives on the RUN's own
 * `meta.outputs[]` record: `predictionId`, `undeliveredOutputId` and the run's
 * `modelSlug` are what {@link imageGeneratorOutputOffer} (`image-generator-store.ts`)
 * reads back as a fetchable Civitai render, and `recoveryUnavailableAt` on
 * that SAME record is this lane's own withdrawal stamp — the per-output
 * counterpart of `paid-output.ts`'s `PAID_OUTPUT_UNAVAILABLE_KEY`.
 *
 * The owner ruling for this slice is **amend the run**: a recovered output
 * fills that run's own output record, a run that had stored nothing becomes
 * `succeeded`, and the original failure is kept in a run-level recovery
 * record rather than erased. No new run row, no new workflow, no admission or
 * budget charge — recovery only re-downloads a render Vesper already paid for.
 *
 * 1. **Check**, outside any lock: the owned run, not `pending`/`running`
 *    (`busy`), the output at the given index still eligible
 *    ({@link imageGeneratorOutputOffer}) and not withdrawn (`expired`).
 * 2. **Fetch**, outside any lock — the shared paid-output step
 *    (`recoverPaidOutput`, `paid-output.ts`): read-only from the stored
 *    workflow and blob, then the decode rule, then the run's own output
 *    shape. A permanent answer withdraws this one output's offer
 *    (`expired`); any other failure leaves it standing (`unavailable`).
 * 3. **Store** the shaped bytes as a new hidden `generator_output` row,
 *    through the bench's own write path (`saveImageBuffer`).
 * 4. **Install**, under the run row locked (`SELECT … FOR UPDATE`): re-check
 *    the output still has no image, patch its record, append a run-level
 *    recovery entry that keeps the original failure, and — only when the run
 *    had stored nothing at all — flip the run itself to `succeeded`. A race
 *    lost to another recovery, or a run deleted mid-flight, discards this
 *    run's own copy through the owned deleter.
 *
 * Every refusal is a value and nothing here throws: an unexpected failure is
 * answered `unavailable`, which leaves the offer as it was. A copy left
 * `pending` by a crash between steps 3 and 4 is reclaimed by the image
 * sweep's own unleased-row rule (`asset-maintenance.ts`), the same as any
 * other direct `createImageAsset` caller that does not beat a lease.
 */

const SCOPE = "image_generator";

/** A failed output's paid render was installed with no new prediction. */
export const IMAGE_GENERATOR_OUTPUT_RECOVERED = `${SCOPE}.output_recovered`;

/** A failed output's paid render can never be fetched or stored; its offer was withdrawn. */
export const IMAGE_GENERATOR_OUTPUT_EXPIRED = `${SCOPE}.output_expired`;

/** A failed output's paid render could not be recovered this time; its offer stands. */
export const IMAGE_GENERATOR_OUTPUT_UNAVAILABLE = `${SCOPE}.output_unavailable`;

/**
 * What the bench's own render asks for, as far as recovery needs it when the
 * failed pass recorded no shape of its own: the bench's one hardcoded profile
 * task (`imageGeneratorProfile`, `image-generator-request.ts`), and the
 * model's own shape — never cropped, because the raw bench never reshapes a
 * model's answer.
 */
const BENCH_OUTPUT_LANE_SHAPE: PaidOutputLaneShape = { task: "item", targetRatio: null, expectedAspect: null };

export interface RecoverImageGeneratorOutputInput {
  runId: string;
  ownerId: string;
  /** The output's own 1-based `index`, as the wire and the stored record both carry it. */
  index: number;
  /** Where the recovery's diagnostics are also said. They always reach the process log. */
  sink?: DiagnosticSink;
}

export type ImageGeneratorRecoveryResult =
  | { status: "recovered"; run: ImageGeneratorRun }
  | { status: "not_found" }
  | { status: "ineligible" }
  | { status: "busy" }
  | { status: "expired" }
  | { status: "unavailable" };

/** Recover one failed pass's paid output. Never throws. */
export async function recoverImageGeneratorOutput(
  input: RecoverImageGeneratorOutputInput,
): Promise<ImageGeneratorRecoveryResult> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    return await recover(input, sink);
  } catch (error) {
    // Only the reads before the fetch, or the fetch itself, reach here — the
    // install step answers for itself inside its own transaction.
    log.warn("images", "an image generator output recovery failed unexpectedly; its offer stands", {
      runId: input.runId,
      index: input.index,
      error: errorText(error),
    });
    return { status: "unavailable" };
  } finally {
    logDiagnostics(SCOPE, collected.items, { runId: input.runId });
  }
}

async function recover(input: RecoverImageGeneratorOutputInput, sink: DiagnosticSink): Promise<ImageGeneratorRecoveryResult> {
  const row = await ownedGeneratorRun(input.runId, input.ownerId);
  if (row === null) return { status: "not_found" };
  if (row.status === "pending" || row.status === "running") return { status: "busy" };

  const outputs = imageGeneratorRunOutputs(imageMeta(row.meta)["outputs"]);
  const target = outputs.find((output) => output.index === input.index);
  if (target === undefined) return { status: "not_found" };

  const offer = imageGeneratorOutputOffer(row, target);
  if (offer === null) return { status: "ineligible" };
  if (target.recoveryUnavailableAt !== null) return { status: "expired" };

  // Outside every lock: a slow blob can take minutes, and nothing about the
  // download is the row's business until its bytes are in hand.
  const shape = recordedShapeRequest({ render: imageMeta(row.meta)["attempt"] }, BENCH_OUTPUT_LANE_SHAPE);
  const recovered = await recoverPaidOutput({ workflowId: offer.workflowId, blobId: offer.blobId, shape, sink });
  if (!recovered.ok) {
    if (recovered.permanent) return withdraw(row, input.index, sink, recovered.error);
    reportUnavailable(sink, row.id, input.index, "fetch", recovered.error);
    return { status: "unavailable" };
  }

  const copy = await createImageAsset({
    ownerId: input.ownerId,
    kind: "generator_output",
    meta: {
      hidden: true,
      imageGeneratorRunId: row.id,
      recoveredFrom: { index: input.index, workflowId: offer.workflowId, blobId: offer.blobId },
    },
  });
  // The one webp writer every stored image goes through — the bench's own
  // write path, exactly as the ordinary render loop uses it.
  const written = await saveImageBuffer(copy.id, recovered.shaped.image, sink);
  if (written === null || written.status !== "ready") {
    reportUnavailable(sink, row.id, input.index, "store", "the recovered output could not be written locally");
    await discardCopy(copy.id, input.ownerId);
    return { status: "unavailable" };
  }

  return install(row, input, written.id, offer, sink);
}

/** What one install's re-check decided, before the copy is reconciled and the final answer is read back. */
type InstallOutcome = { installed: true } | { installed: false; finalStatus: "recovered" | "not_found" };

/**
 * Install the recovered copy under the run row locked. Re-reads everything
 * inside the lock — the run still exists, the output still has no image —
 * because the slow fetch above ran with nothing held. A race lost to another
 * recovery still answers `recovered` (the output now has an image, whoever
 * installed it); a run deleted mid-flight answers `not_found`. Either way
 * this run's own unused copy is discarded, never left pointing at nothing.
 */
async function install(
  row: ImageGeneratorRunRow,
  input: RecoverImageGeneratorOutputInput,
  copyId: string,
  offer: { workflowId: string; blobId: string },
  sink: DiagnosticSink,
): Promise<ImageGeneratorRecoveryResult> {
  const now = new Date();
  const outcome = await db().transaction(async (tx): Promise<InstallOutcome> => {
    const [locked] = await tx
      .select()
      .from(imageGeneratorRuns)
      .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)))
      .for("update");
    if (locked === undefined) return { installed: false, finalStatus: "not_found" };

    const outputs = imageGeneratorRunOutputs(imageMeta(locked.meta)["outputs"]);
    const position = outputs.findIndex((output) => output.index === input.index);
    const current = position === -1 ? undefined : outputs[position];
    if (current === undefined) return { installed: false, finalStatus: "not_found" };
    if (current.imageId !== null) {
      // Another recovery already won the race while this one was fetching;
      // the output is filled, whatever installed it.
      return { installed: false, finalStatus: "recovered" };
    }

    const patchedOutputs = outputs.map((output, i) =>
      i === position ? { ...output, imageId: copyId, failureCode: null, recoveredAt: now.toISOString() } : output);
    const recoveries = [
      ...previousRecoveries(locked.meta),
      {
        index: input.index,
        workflowId: offer.workflowId,
        blobId: offer.blobId,
        at: now.toISOString(),
        previous: {
          status: locked.status,
          failureCode: locked.failureCode,
          error: locked.error,
          finishedAt: locked.finishedAt?.toISOString() ?? null,
        },
      },
    ];
    // Only a run that had stored nothing at all changes status — a fan-out
    // that already succeeded through another pass stays exactly as it was,
    // per the ruling's immutability carve-out: a settled run is only ever
    // amended by recovering an output it already paid for.
    const columns: Partial<typeof imageGeneratorRuns.$inferInsert> = locked.resultImageId === null
      ? { resultImageId: copyId, status: "succeeded", failureCode: null, error: null }
      : {};

    await tx
      .update(imageGeneratorRuns)
      .set({ ...columns, meta: generatorRunMeta(locked, { outputs: patchedOutputs, recoveries }) })
      .where(eq(imageGeneratorRuns.id, locked.id));

    sink.push(
      diag("info", IMAGE_GENERATOR_OUTPUT_RECOVERED, "a failed output's paid render was recovered with no new prediction", {
        context: { runId: locked.id, index: input.index, workflowId: offer.workflowId },
      }),
    );
    return { installed: true };
  });

  if (!outcome.installed) await discardCopy(copyId, row.ownerId);
  if (!outcome.installed && outcome.finalStatus === "not_found") return { status: "not_found" };

  const finalRow = await ownedGeneratorRun(row.id, row.ownerId);
  if (finalRow === null) return { status: "not_found" };
  return { status: "recovered", run: toWireImageGeneratorRun(finalRow, sink) };
}

/** Every recovery this run has already taken, read leniently — a pure audit trail, never gated on. */
function previousRecoveries(meta: unknown): unknown[] {
  const raw = imageMeta(meta)["recoveries"];
  return Array.isArray(raw) ? raw : [];
}

/** The output is gone for good: stamp its withdrawal, say so, and answer `expired`. */
async function withdraw(
  row: ImageGeneratorRunRow,
  index: number,
  sink: DiagnosticSink,
  reason: string,
): Promise<ImageGeneratorRecoveryResult> {
  await stampOutputUnavailable(row, index);
  sink.push(
    diag("warn", IMAGE_GENERATOR_OUTPUT_EXPIRED, "a failed output's paid render can never be recovered; its offer is withdrawn", {
      context: { runId: row.id, index, error: reason.slice(0, 300) },
    }),
  );
  return { status: "expired" };
}

/**
 * Stamp `recoveryUnavailableAt` on one output record, guarded under the run
 * row locked exactly like {@link install}: a row that is gone, an output that
 * no longer matches, or one another recovery already filled is left alone —
 * there is nothing left to withdraw.
 */
async function stampOutputUnavailable(row: ImageGeneratorRunRow, index: number): Promise<void> {
  try {
    await db().transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(imageGeneratorRuns)
        .where(and(eq(imageGeneratorRuns.id, row.id), eq(imageGeneratorRuns.ownerId, row.ownerId)))
        .for("update");
      if (locked === undefined) return;

      const outputs = imageGeneratorRunOutputs(imageMeta(locked.meta)["outputs"]);
      const position = outputs.findIndex((output) => output.index === index);
      const current = position === -1 ? undefined : outputs[position];
      if (current === undefined || current.imageId !== null) return;

      const patched = outputs.map((output, i) =>
        i === position ? { ...output, recoveryUnavailableAt: new Date().toISOString() } : output);
      await tx
        .update(imageGeneratorRuns)
        .set({ meta: generatorRunMeta(locked, { outputs: patched }) })
        .where(eq(imageGeneratorRuns.id, locked.id));
    });
  } catch (error) {
    log.warn("images", "an image generator output's recovery offer could not be withdrawn", {
      runId: row.id,
      index,
      error: errorText(error),
    });
  }
}

/** The offer stands; this attempt did not recover it. */
function reportUnavailable(
  sink: DiagnosticSink,
  runId: string,
  index: number,
  stage: "fetch" | "store",
  error: string,
): void {
  sink.push(
    diag("warn", IMAGE_GENERATOR_OUTPUT_UNAVAILABLE, "a failed output's paid render could not be recovered this time; its offer stands", {
      context: { runId, index, stage, error: error.slice(0, 300) },
    }),
  );
}

/** Delete this run's uninstalled copy; a failure is logged, and the image sweep collects the row later. */
async function discardCopy(copyId: string, ownerId: string): Promise<void> {
  try {
    await deleteOwnedImage(copyId, ownerId, { kind: "generator_output" });
  } catch (error) {
    log.warn("images", "an unused recovered image generator output cleanup failed", {
      imageId: copyId,
      error: errorText(error),
    });
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
