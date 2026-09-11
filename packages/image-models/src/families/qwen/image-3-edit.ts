import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { negativePromptFeature, promptFeature, seedFeature } from "../../features";
import { QWEN_IMAGE_FAMILY } from "./shared";

/**
 * `alibaba/qwen-image-3/edit` on fal — ordered 1–3-reference Qwen Image 3
 * instruction editing.
 *
 * Kept distinct from the text-to-image adapter even while this first pass has
 * the same normalized prompt/seed/negative feature set. The endpoints already
 * differ mechanically (references and operation), and later identity/prompt or
 * execution findings must be able to diverge without changing registry routing.
 */
export const qwenImage3Edit: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [promptFeature(), seedFeature(), negativePromptFeature()],
});
