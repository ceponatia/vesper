# Depth fixture

A depth fixture is a hidden `lab_control` image whose `controlKind` is `depth`. It represents relative scene depth for models that can use a depth map as structural guidance.

## Automatic extraction

Depth extraction uses the pinned Replicate model `chenxwh/depth-anything-v2` at version:

`b239ea33cff32bb7abb5db39ffe9a09c14cbc2894331d1ef66fe096eed88ebd4`

The extractor selects the provider's `grey_depth` output. The colorized depth visualization is intentionally not used as the fixture sent to a model.

Depth extraction is paid provider work and uses the lab preprocessor timeout. Returned bytes must decode as an image before a `lab_control` asset is written; invalid output settles as `preprocessor_output_invalid` rather than leaving a broken fixture tile.

## Hand-authored depth fixtures

The upload path can store a depth map as `hand_authored`. The selected kind, optional source-image link, and origin note become the fixture's durable metadata.

## Review requirement

A depth fixture must be reviewed before an experiment may rely on it — [Generating and reviewing control fixtures](generating-control-fixtures.md) owns the rule. Review is what makes an `ignores_control` result distinguishable from a bad or uninspected depth map.