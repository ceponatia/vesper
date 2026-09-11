import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { aspectRatioFeature, negativePromptFeature, promptFeature, seedFeature } from "../../features";
import { QWEN_IMAGE_FAMILY } from "./shared";

/**
 * `alibaba/qwen-image-3-pro` — the higher-quality unified Qwen Image 3 endpoint.
 *
 * Kept as its OWN adapter rather than aliasing {@link qwenImage3}: the first
 * version happens to compose the same small capability set, but quality-policy,
 * prompt dialect, and execution-hint findings can diverge later without turning
 * one model's evidence into the other's behavior.
 */
export const qwenImage3Pro: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [promptFeature(), aspectRatioFeature(), seedFeature(), negativePromptFeature()],
});
