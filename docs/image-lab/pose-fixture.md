# Pose fixture

A pose fixture is a hidden `lab_control` image whose `controlKind` is `pose`. It represents the body/joint arrangement a control-capable model should follow.

## Automatic extraction

Pose extraction uses the pinned Replicate model `fofr/controlnet-preprocessors` at version:

`f6584ef76cf07a2014ffe1e9bdb1a5cfa714f031883ab43f8d4b05506625988e`

The extractor enables `open_pose` and explicitly disables the other preprocessor switches. That matters because the upstream model defaults many preprocessors on; leaving them implicit would run and bill unrelated operations and make the returned array ambiguous.

Pose extraction is paid provider work. The preprocessor has a 120-second lab timeout to tolerate cold starts.

## Hand-authored pose fixtures

An admin can also upload a pose image. Uploads are always recorded with generator `hand_authored`; the client cannot claim that an uploaded image came from the pinned extractor.

When the drawing was made over a particular source render, that source image can be linked in fixture metadata. Experiments will then refuse to send the same source image alongside the fixture, preventing a false control-obedience result caused by copying the source.

## Review requirement

A pose fixture cannot be used by a control experiment until it is reviewed — [Generating and reviewing control fixtures](generating-control-fixtures.md) owns the review and source-contamination rules.