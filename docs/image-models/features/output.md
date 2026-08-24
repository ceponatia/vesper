# Output features

Source: [`packages/image-models/src/features/output.ts`](../../../packages/image-models/src/features/output.ts).

This module defines `outputFormat` and `outputQuality`.

## `outputFormat`

`outputFormatFeature()` contributes capability id `outputFormat`.

**Semantic:** the caller can request an output encoding instead of always accepting the endpoint's default.

**Binding:** `isBound(model)` is true when `model.outputFormat` is not `null`. The normalized model row already records whether an output-format input exists, so the feature can answer without inspecting provider field names.

**Current Qwen use:** all three registered Qwen adapters compose `outputFormat`.

## `outputQuality`

`outputQualityFeature()` contributes capability id `outputQuality`.

**Semantic:** the caller can select an output-quality setting that trades file size against encoded-image fidelity.

`outputQuality` intentionally has **no `isBound` hook**. There is no normalized output-quality control slot today; the setting rides model-specific pinned extras, and the only lower-level evidence lives in raw provider input descriptors. A semantic feature is not allowed to inspect those descriptors by matching provider field names, because that would duplicate the probe's job.

Composing `outputQuality` therefore records a family convention. The application/provider mapping remains responsible for whether and how that convention reaches the active endpoint.

**Current Qwen use:** all three registered Qwen adapters compose `outputQuality`.

[Back to features](README.md).
