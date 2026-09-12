import {
  aspectRatioFeature,
  multiReferenceFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
  type ImageFeature,
} from "../../features";

/**
 * The FLUX.2 klein family: Black Forest Labs' klein checkpoints Vesper is
 * onboarding on Replicate for bench-only evaluation (#562).
 *
 * klein ships as three DISTINCT endpoint variants per parameter size (4B and
 * 9B) rather than one schema with optional fields: a distilled checkpoint
 * with a fixed accelerated sampling path, a base checkpoint that trades that
 * fast path for a guidance control, and a base-lora checkpoint that trades
 * both for an external LoRA loader. The captured OpenAPI schemas
 * (https://github.com/ceponatia/vesper/issues/566#issuecomment-5646491048,
 * re-checked live for the three 4B endpoints on 2026-09-12) back each of
 * those differences; merging the three into one composition would advertise
 * a control a given endpoint's schema does not declare — base-only guidance
 * or fast mode on the LoRA endpoint, LoRA on the two endpoints with no
 * loading input.
 *
 * 4B and 9B are PARAMETER-COUNT twins: for a given variant, the endpoint
 * schema and therefore the composed feature set are identical between the
 * two sizes. `registry.ts` maps both slugs for a variant to the SAME composed
 * adapter object in `./klein.ts` rather than duplicating the definition.
 * Registering a 9B slug here is code support only — it does not register,
 * enable, or authorize a 9B database row; that remains #564's decision, and
 * no 9B row exists.
 *
 * No adapter in this family composes a `preparePrompt` hook. klein is a
 * bench-only onboarding with no source-backed prompt finding, and sharing the
 * word FLUX with the production `flux-dev`/`flux-2-dev`/`flux-2-pro` models
 * and their `flux_dev_positive_replacement` dialect is not evidence the two
 * need the same rewrite — that dialect stays exactly where it is, unchanged
 * by this family.
 */
export const FLUX2_KLEIN_FAMILY = "flux-2-klein";

/**
 * What every klein endpoint expresses regardless of variant: an authored
 * prompt, several role-bearing references, a requested output shape, and a
 * seed. None of the three captured schemas declares a negative-prompt input,
 * so no klein variant composes `negativePromptFeature`.
 */
export function kleinCoreFeatures(): ImageFeature[] {
  return [promptFeature(), multiReferenceFeature(), aspectRatioFeature(), seedFeature()];
}

/**
 * What every klein endpoint expresses at the output boundary: a requested
 * encoding, an output-quality/size trade, and a disableable safety checker.
 * Identical across all three captured schemas.
 */
export function kleinOutputFeatures(): ImageFeature[] {
  return [outputFormatFeature(), outputQualityFeature(), safetyToggleFeature()];
}
