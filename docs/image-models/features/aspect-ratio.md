# Aspect-ratio feature

Source: [`packages/image-models/src/features/aspect-ratio.ts`](../../../packages/image-models/src/features/aspect-ratio.ts).

`aspectRatioFeature()` contributes capability id `aspectRatio`.

## Semantic

The caller can request the output shape instead of always accepting the model's own default dimensions.

The feature is intentionally semantic rather than mechanical. One provider may accept an aspect-ratio enum while another accepts width/height dimensions; the normalized image layer decides how the requested shape maps to wire inputs.

## Binding

`isBound(model)` is true when `model.supportedAspects` contains at least one normalized aspect.

A model with no parseable supported aspect list is treated as unable to honor a requested shape through this feature. The broader render system may still degrade to that model's default and crop the downloaded result as appropriate; the feature does not invent a binding that the probe did not establish.

## Current Qwen composition

All three registered Qwen adapters compose `aspectRatio`:

- `qwen/qwen-image-edit-2511`
- `qwen/qwen-image-edit-plus-lora`
- `qwen/qwen-image-2512`

[Back to features](README.md).
