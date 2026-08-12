import { referenceCapacity, type ImageModel } from "../models/image-models";
import type { SceneReferenceMode, SceneVisualReference } from "../references/scene-reference";

/**
 * Provider-capability seam for image rendering (scene-images.spec.md §4,
 * re-based on the registry 2026-08-05).
 *
 * Before the registry this module carried a hardcoded matrix of provider ids
 * (`venice_edit`, `replicate_multi_edit`, …) whose capabilities were constants.
 * Capabilities now live on the model row, so the ids that remain describe **how
 * many references an attempt uses**, not which vendor serves it. One model runs
 * the whole chain; the chain is its degradation ladder.
 *
 * `demo` survives because it is not a model at all — it is the monogram path
 * that runs with no provider configured.
 */
export const sceneAttemptIds = ["demo", "multi_edit", "edit", "generate"] as const;
export type SceneAttemptId = (typeof sceneAttemptIds)[number];

export interface SceneRenderRequest {
  references: SceneVisualReference[];
  demo: boolean;
  mode?: SceneReferenceMode;
  /** The resolved registry model; absent in demo mode or when none is registered. */
  model?: ImageModel | null;
}

/**
 * Order the attempts one render may make, best first.
 *
 * A selected model never falls across to a DIFFERENT model: a failure stays
 * visible and retryable rather than producing an image that looks nothing like
 * the character (owner ruling 2026-07-29). What it may do is use fewer
 * references — dropping the location reference costs fidelity, where refusing
 * costs the image entirely.
 *
 * The `generate` rung is only reachable for a model that can run bare, and only
 * when no usable reference exists. An edit-only model with no reference yields
 * an empty chain, which the caller reports as a refusal.
 */
export function routeSceneAttempts(request: SceneRenderRequest): SceneAttemptId[] {
  if (request.demo) return ["demo"];
  if (!request.model) return [];

  const available = request.references.filter((reference) => Boolean(reference.imageId)).length;
  const { max } = referenceCapacity(request.model);
  const usable = Math.min(available, max);

  const chain: SceneAttemptId[] = [];
  if (usable >= 2 && request.mode === "multi") chain.push("multi_edit");
  if (usable >= 1) chain.push("edit");
  if (chain.length === 0 && request.model.canGenerate) chain.push("generate");
  return chain;
}

/** How many reference buffers an attempt consumes. */
export function attemptReferenceCount(attempt: SceneAttemptId, model: ImageModel | null | undefined): number {
  if (!model || attempt === "demo" || attempt === "generate") return 0;
  const { max } = referenceCapacity(model);
  return attempt === "multi_edit" ? max : 1;
}
