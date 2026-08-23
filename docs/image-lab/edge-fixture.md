# Edge fixture

An edge fixture is a hidden `lab_control` image whose `controlKind` is `edge`. It is a high-contrast line map representing strong boundaries in the source image.

## Automatic extraction

Edge extraction is local and costs no provider call. `computeImageLabEdgeMap` uses Sharp to:

1. convert the source to grayscale;
2. apply horizontal and vertical Sobel kernels in both polarities;
3. add the four responses;
4. threshold the result at `48` to white lines on black.

Both kernel polarities are used because Sharp's convolution clamps negative responses to zero; using one polarity alone would detect only one direction of an edge.

A failed local transform is recorded as `preprocessor_output_invalid`. Because no provider was called, an edge extraction does not report provider health success or failure.

## Hand-authored edge fixtures

The upload path can store an externally made edge map with generator `hand_authored`. As with other fixture kinds, it may record which source image it was drawn over and an origin note.

## Review requirement

Edge fixtures must be human-reviewed before a control experiment can use them. Review requires a note.

## Current renderer support

A fixture existing in the lab does not mean every registered model has a dedicated edge input. Models without a dedicated binding may receive structural controls as numbered references when the recipe and model support that path. The current Vesper-owned SDXL renderer explicitly defers its edge/Canny ControlNet path, so an edge fixture should not be assumed usable there merely because the lab can generate one.

See [Generating and reviewing control fixtures](generating-control-fixtures.md).