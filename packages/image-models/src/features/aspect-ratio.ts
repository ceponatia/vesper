import type { ImageModel } from "@vesper/image-core";
import type { ImageFeature } from "./image-feature";

/**
 * The caller can ask for the output SHAPE.
 *
 * Semantic, not mechanical: some models take a ratio enum and some take pixel
 * pairs, and which key carries it is `imageAspectInputField`'s answer in
 * `@vesper/image-core`. What this feature claims is only that asking is
 * meaningful at all — a model offering no parseable shape takes its own default
 * whatever anyone asks for, and `chooseAspect` already degrades to that.
 */
export function aspectRatioFeature(): ImageFeature {
  return {
    id: "aspectRatio",
    semantic: "Honours a requested output shape rather than always producing its own default.",
    isBound: (model: ImageModel) => model.supportedAspects.length > 0,
  };
}
