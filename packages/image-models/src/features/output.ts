import type { ImageModel } from "@vesper/image-core";
import type { ImageFeature } from "./image-feature";

/**
 * The caller can choose the output ENCODING.
 *
 * The record's `outputFormat` column is null on models with no such input and
 * is omitted from the payload when it is, so the column answers this directly.
 */
export function outputFormatFeature(): ImageFeature {
  return {
    id: "outputFormat",
    semantic: "Accepts a requested output encoding rather than always returning its own.",
    isBound: (model: ImageModel) => model.outputFormat !== null,
  };
}

/**
 * The caller can trade file size against fidelity in the returned image.
 *
 * **No `isBound`.** This has no normalized control slot: it rides a model row's
 * pinned extras, and the only record of the field is the probe's raw input
 * descriptors — which a feature may not read, because reading them means
 * matching a provider field name, the precise thing the probe exists to stop
 * anyone doing (`./image-feature`). Composing this feature therefore states a
 * family convention ("these endpoints take an output-quality number") and
 * leaves the wire question where it belongs.
 */
export function outputQualityFeature(): ImageFeature {
  return {
    id: "outputQuality",
    semantic: "Accepts an output-quality setting trading file size against fidelity.",
  };
}
