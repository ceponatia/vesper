import { z } from "zod";

/**
 * PURE. One prediction's outcome inside a Generator run.
 *
 * Every model Vesper registers renders exactly ONE image per prediction — no
 * version in the Qwen family declares a native image-set input, and the shared
 * compile refuses `outputCount` on this path for every lane — so a run asked for
 * N images is N sequential predictions from one compiled plan. The run row's own
 * columns can only describe a single output (`result_image_id`,
 * `prediction_id`), so the per-prediction account lives in the run's meta bag
 * under `outputs`, beside `attempt`, `result` and `providerAttempts`.
 *
 * Read LENIENTLY, exactly as those three are: the elements come out of a jsonb
 * bag a newer deploy may have written more into, and one malformed element must
 * cost its own tile rather than the run's whole account of itself.
 *
 * Shared rather than restated at each end: the runner writes these records, the
 * delete sweep reads them to find the sibling images a run's `result_image_id`
 * does not name, and both the run detail and the run list render them.
 */
export const imageGeneratorRunOutputSchema = z.object({
  /** 1-based, in the order the predictions ran — the numbering every Generator record uses. */
  index: z.number().int().min(1).catch(0),
  /** The stored `generator_output` image, when this prediction produced one. */
  imageId: z.string().min(1).nullable().catch(null).default(null),
  /** Why this one produced nothing — a dotted generator code, or a verbatim shared-layer one. */
  failureCode: z.string().min(1).nullable().catch(null).default(null),
  /** The provider prediction behind it; null when the request was refused before one existed. */
  predictionId: z.string().min(1).nullable().catch(null).default(null),
});
export type ImageGeneratorRunOutput = z.infer<typeof imageGeneratorRunOutputSchema>;

/**
 * The per-prediction records inside a stored `outputs` array, element by
 * element. Anything that is not an array of readable objects reads as no
 * outputs at all — which is exactly what every run written before the fan-out
 * existed holds, and what a bag too damaged to describe itself deserves.
 */
export function imageGeneratorRunOutputs(raw: unknown): ImageGeneratorRunOutput[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = imageGeneratorRunOutputSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The images a run actually stored, in prediction order. */
export function imageGeneratorRunOutputImageIds(outputs: readonly ImageGeneratorRunOutput[]): string[] {
  return outputs.flatMap((output) => (output.imageId === null ? [] : [output.imageId]));
}

/**
 * One run's per-prediction records as the WIRE carries them: inside the loose
 * `result` bag, which is where the run service folds the stored `meta.outputs`
 * array so a fan-out reaches the client without a new wire member. This is the
 * single place that knows the transport, so promoting `outputs` to a field of
 * its own is a one-function change.
 */
export function imageGeneratorRunOutputsOf(run: { result: Record<string, unknown> | null }): ImageGeneratorRunOutput[] {
  return imageGeneratorRunOutputs(run.result?.["outputs"]);
}
