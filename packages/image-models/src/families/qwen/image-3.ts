import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { negativePromptFeature, promptFeature, seedFeature } from "../../features";
import { QWEN_IMAGE_FAMILY } from "./shared";

/**
 * `alibaba/qwen-image-3/text-to-image` on fal — prompt-only Qwen Image 3.
 *
 * Intentionally its OWN adapter. fal publishes generation and editing as
 * separate endpoints with different image-input contracts, so collapsing them
 * into one definition would make future endpoint-specific findings impossible
 * to express without slug checks elsewhere.
 *
 * Provider field names, 1K/2K size choices and fal's safety field remain owned
 * by the registry capability record; this first adapter states only the
 * provider-neutral semantic controls Vesper has reviewed.
 */
export const qwenImage3TextToImage: ImageModelAdapter = defineImageModel({
  family: QWEN_IMAGE_FAMILY,
  features: [promptFeature(), seedFeature(), negativePromptFeature()],
});
