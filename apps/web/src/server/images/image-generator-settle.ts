import { and, eq } from "drizzle-orm";
import { imageFailureHealthOutcome, type ImageRenderIntent } from "@vesper/image-core";
import { type ImageGeneratorFailureCode, imageGeneratorDiagnosticCode } from "@/contracts/images/image-generator";
import type { ImageGeneratorRunOutput } from "@/contracts/images/image-generator-outputs";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { classifyImageFailure } from "../ai";
import { db, imageGeneratorRuns } from "../db";
import { createImageAsset, deleteOwnedImage, deleteOwnedImages, saveImageBuffer } from "./assets";
import { generatorRenderer } from "./image-generator-render";
import {
  generatorRunMeta,
  IMAGE_GENERATOR_RUN_THREW,
  type ImageGeneratorRunPayload,
  type ImageGeneratorRunRow,
  settleGeneratorRunFailed,
} from "./image-generator-store";
import type { RenderImageIntentResult } from "./render-intent";

/** Everything the render step needs that the row cannot say for itself. */
export interface GeneratorFanOut {
  intent: ImageRenderIntent;
  /** How many predictions to run — one per image the operator asked for. */
  imageCount: number;
  finalPrompt: string;
  plannedPrimaryCount: number;
}

/**
 * The strict arm's refusal, decided from the request before any prediction
 * existed — never a provider failure, so it must never settle as one.
 */
function strictRenderRefusal(
  rendered: RenderImageIntentResult,
  slug: string,
): { code: ImageGeneratorFailureCode; message: string; result: Record<string, unknown> } | null {
  if (rendered.unsentReferences && rendered.unsentReferences.length > 0) {
    return {
      code: "capacity_exceeded",
      message: rendered.error ?? `${slug} cannot carry every selected reference`,
      result: { spent: false, unsentReferences: rendered.unsentReferences },
    };
  }
  if (rendered.providerInputViolations && rendered.providerInputViolations.length > 0) {
    return {
      code: "provider_input_rejected",
      message: rendered.error ?? `${slug} would reject this request`,
      result: { spent: false, providerInputViolations: rendered.providerInputViolations },
    };
  }
  return null;
}

/**
 * Render the run's images and settle against what came back.
 *
 * ONE compiled plan, N predictions, run one after another. Every registered
 * model returns exactly one image per prediction, so the only honest way to ask
 * for several is to ask several times — and the loop is deliberately sequential:
 * the bench's two-phase budget is built to wait out a cold queue, and four
 * simultaneous startup timeouts would read as an upstream in trouble when they
 * are one bench asking for four pictures.
 *
 * The outcomes stay DISTINCT, because they mean different things about money
 * and about the provider lane:
 *
 * - A STRICT pre-spend refusal (`unsentReferences` / `providerInputViolations`)
 *   never created a prediction. It carries no prediction id, reports nothing to
 *   the breaker, and settles under the refusal's own code — not `render_failed`,
 *   which would blame a provider that was never called. It is decided from the
 *   request, so the first pass answers for all of them and the rest are skipped.
 * - A run that stored at least one image SUCCEEDED, whatever the other passes
 *   did: the evidence exists and is on screen, and calling that run failed would
 *   hide images the operator has already been charged for. Which passes missed,
 *   and why, is what `meta.outputs` is for.
 * - Nothing stored settles failed — `output_store_failed` when the provider did
 *   render (charging the lane for a local disk would shed everyone's work over
 *   one write), otherwise `render_failed` with the classifier's health reading.
 *
 * Provider health hears `false` only when EVERY prediction failed. One
 * prediction that came back with pixels is proof the upstream is alive, and
 * reporting a lane failure beside it would trip a breaker on the strength of a
 * run that half worked.
 */
export async function settleGeneratorRender(
  row: ImageGeneratorRunRow,
  request: GeneratorFanOut,
  columns: Partial<typeof imageGeneratorRuns.$inferInsert>,
  sink?: DiagnosticSink,
): Promise<ImageGeneratorRunPayload> {
  const { intent, imageCount, finalPrompt, plannedPrimaryCount } = request;
  const renderer = generatorRenderer();
  const outputs: ImageGeneratorRunOutput[] = [];
  const stored: string[] = [];
  /** Every prediction the run created, across every pass, oldest first. */
  const attempts: NonNullable<RenderImageIntentResult["attempts"]> = [];
  /** The pass whose facts the row's single-output columns describe — see below. */
  let firstRender: RenderImageIntentResult | null = null;
  let storedRender: RenderImageIntentResult | null = null;
  /** The provider answered with pixels at least once, whatever happened next. */
  let renderedAnything = false;
  let firstProviderError: string | null = null;

  for (let index = 1; index <= imageCount; index += 1) {
    // A pass may THROW rather than report: the transport, the asset row,
    // or the disk write can raise. Caught HERE and not only by the runner's
    // outer net, because `stored` lives in this frame — a throw that escaped
    // would settle the run failed while the images earlier passes already
    // wrote stayed behind as hidden rows no `meta.outputs` names, which is
    // exactly what run deletion and the consistency sweep read to find them.
    try {
      const rendered = await renderer({ mode: "intent", intent }, sink);
      firstRender ??= rendered;
      if (rendered.attempts) attempts.push(...rendered.attempts);

      const refusal = strictRenderRefusal(rendered, row.modelSlug);
      if (refusal) {
        // Nothing was spent, so nothing is reported to the breaker, and the
        // message names exactly which selected inputs could not be represented.
        // The remaining passes would be handed the same intent and refused
        // identically, so the run stops here rather than asking again.
        if (stored.length === 0 && outputs.length === 0) {
          return await settleGeneratorRunFailed(row, imageGeneratorDiagnosticCode(refusal.code), refusal.message, sink, {
            columns,
            meta: { result: refusal.result },
          });
        }
        outputs.push({ index, imageId: null, failureCode: imageGeneratorDiagnosticCode(refusal.code), predictionId: null });
        break;
      }

      if (!rendered.ok || !rendered.image) {
        const message = rendered.error ?? `${row.modelSlug} returned no image`;
        firstProviderError ??= message;
        outputs.push({
          index,
          imageId: null,
          failureCode: imageGeneratorDiagnosticCode("render_failed"),
          predictionId: rendered.predictionId ?? null,
        });
        continue;
      }
      renderedAnything = true;

      const asset = await createImageAsset({
        ownerId: row.ownerId,
        kind: "generator_output",
        prompt: finalPrompt,
        meta: { hidden: true, imageGeneratorRunId: row.id },
      });
      const saved = await saveImageBuffer(asset.id, rendered.image, sink);
      if (saved?.status !== "ready") {
        await deleteOwnedImage(asset.id, row.ownerId, { kind: "generator_output" });
        outputs.push({
          index,
          imageId: null,
          failureCode: imageGeneratorDiagnosticCode("output_store_failed"),
          predictionId: rendered.predictionId ?? null,
        });
        continue;
      }
      stored.push(saved.id);
      storedRender ??= rendered;
      outputs.push({ index, imageId: saved.id, failureCode: null, predictionId: rendered.predictionId ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Nothing stored yet: rethrow, so the runner settles `run_threw` with
      // the real message exactly as it did before fan-out existed. There is
      // no orphan to protect, and a code invented here would be worse
      // evidence than the one the thrown error carries.
      if (stored.length === 0) throw err;
      // Images already exist and were already paid for. Record this pass,
      // stop asking, and let the ordinary settle write `meta.outputs` — the
      // run keeps its evidence AND stays sweepable. The message rides a
      // diagnostic rather than the output record, which carries codes only.
      sink?.push(
        diag("error", IMAGE_GENERATOR_RUN_THREW, "a fan-out pass threw after earlier passes had stored images", {
          context: { runId: row.id, index, message },
        }),
      );
      outputs.push({ index, imageId: null, failureCode: IMAGE_GENERATOR_RUN_THREW, predictionId: null });
      break;
    }
  }

  // The row's single-output columns — `result_image_id`, `prediction_id`,
  // `executed_version_id` — and the `attempt`/`result` records all describe THE
  // SAME output: the first image the run stored, or the first pass when it
  // stored none. A row whose Result showed image one while its Prediction named
  // the fourth would be telling two stories about one render. Every other pass
  // is accounted for in `meta.outputs`, and on a one-image run the two are the
  // same pass, so nothing that reads this row today reads it differently.
  const representative = storedRender ?? firstRender;
  if (!representative) {
    // Unreachable: `imageCount` is at least one and every arm above either
    // returns or records a pass. Kept as a settled row rather than a throw,
    // because a runner that threw would leave a `running` record with nothing
    // on it (the whole point of this module).
    return await settleGeneratorRunFailed(
      row,
      imageGeneratorDiagnosticCode("render_failed"),
      `${row.modelSlug} was never asked for an image`,
      sink,
      { columns, meta: { outputs, result: { spent: false } } },
    );
  }

  const provenance = {
    predictionId: representative.predictionId ?? null,
    executedVersionId: representative.executedVersionId ?? null,
  };
  // Under `require_all` the transport refuses rather than trims, so this can
  // only fire for a caller that did not ask for the strict arm — kept as the
  // net that would make such a run readable rather than silently short.
  const trimmed =
    representative.sentReferenceCount !== undefined && representative.sentReferenceCount < plannedPrimaryCount
      ? { trimmedPrimaries: { planned: plannedPrimaryCount, sent: representative.sentReferenceCount } }
      : {};
  if ("trimmedPrimaries" in trimmed) {
    sink?.push(
      diag("warn", "image_generator.references_trimmed", "the transport sent fewer primary references than planned", {
        context: { runId: row.id, ...trimmed.trimmedPrimaries },
      }),
    );
  }
  // What actually came back, beside what was asked for: the returned pixel
  // size and whether Vesper reshaped the answer. Without both, a native-shape
  // run cannot show that it was left alone.
  const result = {
    spent: true,
    predictionId: representative.predictionId ?? null,
    executedVersionId: representative.executedVersionId ?? null,
    ...(representative.outputDimensions ? { outputDimensions: representative.outputDimensions } : {}),
    postprocess: { cropTarget: representative.shape?.cropTarget ?? null },
    ...(representative.shape ? { shapeSent: { field: representative.shape.field, value: representative.shape.value } } : {}),
  };
  // Every prediction this run created, oldest first — present only under an
  // execution policy, which on this lane is always, and now spanning every pass
  // of a fan-out. It sits BESIDE `attempt` and `result` rather than inside
  // either: `attempt` is what Vesper decided to send and `result` is what came
  // back from the representative pass, while this is the run's provider history,
  // where a retried pass has two predictions to account for.
  //
  // `outputs` is the third record and answers the question neither of the others
  // can once a run asks for more than one image: which pass produced which
  // stored image, and what stopped the ones that produced none.
  const attemptMeta = {
    ...(representative.attempt ? { attempt: representative.attempt } : {}),
    ...(attempts.length > 0 ? { providerAttempts: attempts } : {}),
    ...trimmed,
    outputs,
    result,
  };

  const firstStored = stored[0] ?? null;
  if (firstStored === null) {
    // The provider rendered and only the local write failed, so the lane is not
    // charged for this disk — and a mixed run counts as rendered, because a
    // provider that answered once is not the provider that failed.
    if (renderedAnything) {
      return await settleGeneratorRunFailed(
        row,
        imageGeneratorDiagnosticCode("output_store_failed"),
        "the provider rendered but no output could be written locally",
        sink,
        { columns: { ...columns, ...provenance }, meta: attemptMeta, providerOutcome: true },
      );
    }
    const message = firstProviderError ?? `${row.modelSlug} returned no image`;
    const renderFailure = classifyImageFailure(message);
    return await settleGeneratorRunFailed(row, imageGeneratorDiagnosticCode("render_failed"), message, sink, {
      columns: { ...columns, ...provenance },
      meta: { renderFailure, ...attemptMeta },
      providerOutcome: imageFailureHealthOutcome(renderFailure),
    });
  }

  const [settled] = await db()
    .update(imageGeneratorRuns)
    .set({
      ...columns,
      ...provenance,
      // The FIRST stored image, deliberately: this column is the run's thumbnail,
      // its lineage pointer and its FK-SET-NULL target, and a fan-out changes
      // none of that. The siblings are ordinary `generator_output` rows that
      // `meta.outputs` names.
      resultImageId: firstStored,
      status: "succeeded",
      failureCode: null,
      error: null,
      finishedAt: new Date(),
      meta: generatorRunMeta(row, attemptMeta),
    })
    .where(
      and(
        eq(imageGeneratorRuns.id, row.id),
        eq(imageGeneratorRuns.ownerId, row.ownerId),
        eq(imageGeneratorRuns.status, "running"),
      ),
    )
    .returning({ id: imageGeneratorRuns.id });

  // The run was deleted while its render was in flight — allowed on purpose,
  // so a deploy-stranded row can be cleared. The settle matched nothing, which
  // means the pointer making these outputs findable was never written; they are
  // already orphans and go through the same owned deleter the run's own delete
  // uses.
  if (!settled) {
    const removed = await deleteOwnedImages(stored, row.ownerId, { kind: "generator_output" });
    sink?.push(
      diag("info", "image_generator.output_orphaned", "the run was deleted mid-render; its outputs were discarded", {
        context: { runId: row.id, imageIds: stored, removed },
      }),
    );
    return { runId: row.id, status: "discarded", outputImagesRemoved: removed, providerOutcome: true, ...provenance };
  }
  return {
    runId: row.id,
    status: "succeeded",
    resultImageId: firstStored,
    outputImages: stored.length,
    providerOutcome: true,
    ...provenance,
  };
}
