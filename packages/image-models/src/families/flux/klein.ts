import { defineImageModel, type ImageModelAdapter } from "../../composer";
import {
  aspectRatioFeature,
  fastModeFeature,
  guidanceFeature,
  loraFeature,
  multiReferenceFeature,
  promptFeature,
  seedFeature,
} from "../../features";
import { FLUX2_KLEIN_FAMILY, kleinCoreFeatures, kleinOutputFeatures } from "./shared";

/**
 * The DISTILLED klein endpoint — `black-forest-labs/flux-2-klein-4b` and
 * `black-forest-labs/flux-2-klein-9b`.
 *
 * The captured schema exposes a fixed accelerated sampling path
 * (`fastMode`'s normalized control) and no guidance input at all — the
 * distillation trades the base checkpoint's steerable guidance for that fast
 * path by construction, not as an operator choice. Composing `fastMode` here
 * states only what the endpoint's schema accepts; no execution hint or
 * quality ruling is made in this file, and none is warranted until the
 * endpoint's actual timing has been measured.
 */
export const fluxKleinDistilled: ImageModelAdapter = defineImageModel({
  family: FLUX2_KLEIN_FAMILY,
  features: [...kleinCoreFeatures(), fastModeFeature(), ...kleinOutputFeatures()],
});

/**
 * Civitai's native DISTILLED Klein 4B generation lane.
 *
 * Civitai v2 selects the distilled 4B variant with `modelVersion: "4b"`, rather
 * than an immutable checkpoint revision, and accepts additional LoRA resources
 * on that same distilled lane. The Civitai transport therefore has its own
 * adapter rather than inheriting the Replicate distilled endpoint's `go_fast`
 * knob (which does not exist in Civitai's v2 input) or the Replicate Base-LoRA
 * endpoint's output/safety fields.
 *
 * Civitai v2's native `createImage` and `editImage` operations use the same 4B
 * variant and accept a LoRA map alongside zero, one, or two reference images.
 * The transport selects the operation from the reference count and carries the
 * images as data URLs. The provider documents that surface, but no account
 * entitlement or output-quality claim follows from that documentation.
 */
export const fluxKleinCivitaiDistilledLora: ImageModelAdapter = defineImageModel({
  family: FLUX2_KLEIN_FAMILY,
  features: [promptFeature(), multiReferenceFeature(), aspectRatioFeature(), seedFeature(), loraFeature()],
});

/**
 * The BASE klein endpoint — `black-forest-labs/flux-2-klein-4b-base` and
 * `black-forest-labs/flux-2-klein-9b-base`.
 *
 * The captured schema keeps the fast-sampling path AND adds a guidance
 * control the distilled endpoint's schema does not declare. The two are
 * genuinely different endpoints sharing a parameter count, not one schema
 * read two ways.
 */
export const fluxKleinBase: ImageModelAdapter = defineImageModel({
  family: FLUX2_KLEIN_FAMILY,
  features: [...kleinCoreFeatures(), fastModeFeature(), guidanceFeature(), ...kleinOutputFeatures()],
});

/**
 * The BASE-LORA klein endpoint — `black-forest-labs/flux-2-klein-4b-base-lora`
 * and `black-forest-labs/flux-2-klein-9b-base-lora`.
 *
 * The captured schema trades BOTH the fast-sampling path and the guidance
 * control for an external LoRA loader, declaring `lora_weights`/
 * `lora_scales` as a matched ARRAY pair — the shape
 * `resolveImageLoraBindingPair` (`@vesper/image-core`) recognizes alongside
 * the scalar pair every Qwen edit endpoint declares
 * (`docs/image-models/features/README.md` §LoRA). Composing `loraFeature`
 * here states only that this endpoint's schema can express one external
 * LoRA; whether the ACTIVE PROBED version actually exposes a usable pair is
 * `isBound`'s question, answered from the registered row, never from this
 * composition.
 */
export const fluxKleinBaseLora: ImageModelAdapter = defineImageModel({
  family: FLUX2_KLEIN_FAMILY,
  features: [...kleinCoreFeatures(), loraFeature(), ...kleinOutputFeatures()],
});
