import { aspectRatioFeature, multiReferenceFeature, promptFeature, type ImageFeature } from "../../features";

/** The two Replicate Seedream endpoints share one checkpoint-family identity. */
export const SEEDREAM_FAMILY = "seedream";

/**
 * Both endpoints accept an authored prompt, an ordered multi-reference edit
 * list, and a requested output shape. Reference capacity and offered aspects
 * come from each active probed model row, not from this composition.
 */
export function seedreamCoreFeatures(): ImageFeature[] {
  return [promptFeature(), multiReferenceFeature(), aspectRatioFeature()];
}
