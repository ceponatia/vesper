import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { aspectRatioFeature, negativePromptFeature, promptFeature, seedFeature } from "../../features";
import { QWEN_IMAGE_FAMILY } from "./shared";

/**
 * `alibaba/qwen-image-3` — Alibaba's unified Qwen Image 3 endpoint on Replicate.
 *
 * This first adapter is intentionally thin: it states only the semantic controls
 * the live schema already exposes and leaves prompt tuning / execution quirks for
 * measured follow-up work. Reference arity and provider field names remain owned
 * by the probed registry row, not duplicated here.
 */
export const qwenImage3: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [promptFeature(), aspectRatioFeature(), seedFeature(), negativePromptFeature()],
});
