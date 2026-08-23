# Control probe

A `control_probe` asks the narrowest structural-control question in the lab: **does this exact pinned image model obey this reviewed control fixture at all?** It intentionally bypasses production render profiles so the experiment can test the provider/model directly.

## Required setup

- A reviewed pose, depth, or edge [control fixture](generating-control-fixtures.md).
- A registered model that can be resolved to an exact provider version.
- An instruction/prompt.
- Optionally, one identity reference. The probe may test structure without identity.

The selected fixture is required even though the create-request schema permits a row to be created without one. The runner treats a missing fixture as a recorded `control_invalid` failure rather than making the create endpoint erase the attempted experiment.

## Input order and prompt

The form orders an optional identity image first and the fixture second. The default probe instruction is generated from those positions so it can name the numbered image containing the control. An admin may edit the instruction; the runner sends the stored instruction **verbatim** and does not silently wrap it in a production prompt strategy.

The declared fixture must appear exactly once among the ordered inputs under `pose`, `depth`, `edge`, or the legacy generic `control` role.

## Model and version behavior

The probe uses the experiment's model slug. Blank in the UI currently means the default edit model. At run time the model must be present in the image-model registry and must resolve to an exact provider version. A floating version is refused as `image_lab.version_unpinned` before any provider spend.

Reference capacity is also checked before rendering. Unlike production-shaped controlled recipes, a probe refuses an over-capacity request rather than trimming it, because a probe whose record says a fixture was sent when the transport dropped it would be invalid evidence.

## Settings

The runner supports normalized image controls plus a raw provider-shaped `controlInput` overlay. The raw bag is deliberately a probe-only escape hatch; production-shaped recipe experiments refuse it.

**Current UI limitation:** the experiment form does not expose a general normalized-control editor or raw provider-input editor, so this capability is substantially more accessible through the API/service contract than through the admin form. See [Known gaps](known-gaps-and-recommendations.md).

## Fixture integrity gates

Before rendering the runner verifies that:

- the declared fixture is owned by the current admin and is a `lab_control` image;
- its stored metadata parses and its kind matches the experiment's declared kind;
- it is present exactly once in the send list under a control role;
- it has been reviewed;
- if it was extracted from a source render, that source render is **not** also being sent.

The last rule prevents false passes: a model could reproduce the source image's pose/depth by copying the source rather than obeying the extracted control map.

## Verdicts

A successful probe can be ruled:

- `honours_control`
- `ignores_control`
- `inconclusive`

A verdict requires a note. The note should state what in the output supports the ruling, especially when the result is ambiguous.

## Execution path

`apps/web/src/server/images/image-lab-control.ts` → `runControlProbe` → the shared lab renderer's direct mode → `runRegistryImageModel`.

The experiment records requested/executed version information, the final prompt, provider prediction id when available, result image, and the later human verdict.