import { defineImageModel, type ImageModelAdapter } from "../../composer";
import { outputFormatFeature, safetyToggleFeature } from "../../features";
import { SEEDREAM_FAMILY, seedreamCoreFeatures } from "./shared";

/**
 * `bytedance/seedream-4.5` accepts up to 14 ordered references and a safety
 * relaxation toggle. It has no output-format input: the downloader handles
 * conversion after the provider returns its image. Its explicit single-output
 * pins live in the probed row and remain part of the existing wire payload.
 */
export const seedream45: ImageModelAdapter = defineImageModel({
  family: SEEDREAM_FAMILY,
  features: [...seedreamCoreFeatures(), safetyToggleFeature()],
});

/**
 * `bytedance/seedream-5-lite` accepts the same reference convention but offers
 * PNG/JPEG output control and no safety toggle. Its 2K/3K size tiers, output
 * encoding and single-output pins remain active-version facts in the probed
 * row. Measured 40–60-second renders fit the lane budget without a hint.
 */
export const seedream5Lite: ImageModelAdapter = defineImageModel({
  family: SEEDREAM_FAMILY,
  features: [...seedreamCoreFeatures(), outputFormatFeature()],
});
