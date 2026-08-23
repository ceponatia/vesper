# Generating and reviewing control fixtures

Control fixtures are hidden `lab_control` assets used by experiments that ask whether a model obeys structural guidance. The lab currently supports [pose](pose-fixture.md), [depth](depth-fixture.md), and [edge](edge-fixture.md).

A fixture is not considered experimental evidence merely because it exists. It must have durable provenance and a recorded human review before a control experiment may use it.

## Generate from an existing render

In the **Control fixtures** panel:

1. Pick a character.
2. Pick one of that character's available portrait renders as the source.
3. Select one or more fixture kinds: pose, depth, and/or edge.
4. Optionally add an origin note describing what the fixtures are for.
5. Choose **Extract from image**.

The API can accept up to four distinct source image ids and all three distinct fixture kinds in one request. The current UI submits one source render at a time.

### What happens by kind

- **Pose** — paid Replicate call to the pinned OpenPose preprocessor.
- **Depth** — paid Replicate call to the pinned Depth Anything v2 preprocessor; the grayscale depth output is stored.
- **Edge** — local Sharp/Sobel computation; no provider call.

Each kind is processed independently. If one requested extraction fails, the other kinds still run and their outcomes are recorded.

The source image must be an owned, ready image whose bytes can be read. Successful fixture bytes are decoded before storage, then saved as hidden `lab_control` images with metadata describing kind, generator, source image, and origin note.

## Upload a hand-authored fixture

The panel also accepts an image file for any of the three fixture kinds. Although the current UI heading/button says “Upload a skeleton,” the kind selector and server support pose, depth, and edge uploads.

For an upload:

1. Choose the image file.
2. Choose its fixture kind.
3. If the fixture was drawn/derived from the currently selected render, leave the source link enabled. Otherwise unlink it.
4. Add an optional origin note describing how or why it was made.
5. Upload.

The server always records the generator as `hand_authored`; provenance is not accepted from the client.

The upload travels as a base64 data URL. The UI derives its maximum byte size from the same `3,000,000`-character request cap used by the server so it can reject oversized files before reading them.

## Review the fixture

A newly generated/uploaded fixture is `unreviewed`.

1. Open/enlarge the fixture and visually inspect it.
2. If it is usable, choose **Mark reviewed**.
3. Enter a required note describing what was verified.
4. Save the review.

The server stamps `reviewedAt` using its own clock and stores the review note separately from the origin note. A control experiment refuses `control_unreviewed` before spending if this review is absent.

Delete fixtures that are materially wrong rather than reviewing them with a caveat. A bad fixture and a model that ignores a good fixture can look identical in the output.

## Source-image contamination rule

When a fixture records `sourceImageId`, an experiment using that fixture may not also send the source image among its ordered references.

Example: a pose skeleton is extracted from portrait A. If a probe sends portrait A plus that skeleton, the resulting image may match the skeleton simply by copying portrait A's pose. The lab therefore refuses the experiment as `control_source_sent` before provider spend.

Use a different identity image whose pose differs from the fixture's target when testing whether the control actually changes structure.

## Deleting fixtures

Deleting a fixture removes the hidden control asset. Historical experiments are not erased. Their stored ordered inputs, prompt, model/version provenance, outcome, and verdict remain the record of what happened, while the direct control pointer may be nulled by the database relationship.

## Current UI limitation

The extraction service accepts any owned source image id, but the fixture panel's source picker is currently character/portrait-oriented. Scene images, arbitrary lab outputs, and other owned images are not generally selectable from this UI even though the backend extraction contract is broader. See [Known gaps](known-gaps-and-recommendations.md).