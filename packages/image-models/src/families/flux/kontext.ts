import { defineImageModel, type ImageModelAdapter } from "../../composer";
import {
  aspectRatioFeature,
  guidanceFeature,
  outputFormatFeature,
  outputQualityFeature,
  promptFeature,
  safetyToggleFeature,
  seedFeature,
  sourceImageFeature,
  stepsFeature,
} from "../../features";

/**
 * FLUX.1 Kontext — Black Forest Labs' image-editing checkpoint. Its own
 * family: this is NOT the FLUX.2 klein family (`./shared.ts`'s
 * `FLUX2_KLEIN_FAMILY`) sharing a slug prefix, and klein's core/output feature
 * lists are not reused here — Kontext's captured schema is a genuinely
 * different endpoint, not a klein variant.
 */
export const FLUX1_KONTEXT_FAMILY = "flux-1-kontext";

/**
 * The DEV endpoint — `black-forest-labs/flux-kontext-dev`.
 *
 * Composed straight from the captured Input schema at version
 * `85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59` (#574):
 * `prompt`, one required `input_image` (an edit-only source, reference cap
 * 1), an `aspect_ratio` enum (plus the `match_input_image` sentinel), a
 * `seed`, `guidance` (0–10, default 2.5), `num_inference_steps` (4–50,
 * default 30), `output_format`, `output_quality`, and
 * `disable_safety_checker`. Nothing here is invented beyond that schema:
 *
 * - **No `multiReferenceFeature`.** Its semantic claim is several
 *   role-bearing references (`isBound` is `max > 1`); this endpoint declares
 *   exactly one, required, reference input, so `sourceImageFeature` — a
 *   different claim, not a capacity-1 reading of this one — is composed
 *   instead.
 * - **No `fastModeFeature`.** The captured schema declares no accelerated
 *   sampling control at all.
 * - **No `negativePromptFeature`.** The captured schema declares no
 *   negative-prompt input.
 * - **No `loraFeature`.** LoRA loading (`lora_weights`) belongs to the
 *   separate `black-forest-labs/flux-kontext-dev-lora` endpoint, which this
 *   adapter must not resolve.
 * - **No `preparePrompt` and no `executionHints`.** No prompt-rewriting
 *   finding and no measured timing back either hook for this endpoint.
 *
 * `black-forest-labs/flux-kontext-pro`, `black-forest-labs/flux-kontext-max`,
 * `black-forest-labs/flux-kontext-dev-lora`, and the production `flux-dev`
 * checkpoint are different endpoints with their own schemas; none of them is
 * this adapter, and the registry must resolve nothing for them here.
 */
export const fluxKontextDev: ImageModelAdapter = defineImageModel({
  family: FLUX1_KONTEXT_FAMILY,
  features: [
    promptFeature(),
    sourceImageFeature(),
    aspectRatioFeature(),
    seedFeature(),
    guidanceFeature(),
    stepsFeature(),
    outputFormatFeature(),
    outputQualityFeature(),
    safetyToggleFeature(),
  ],
});
