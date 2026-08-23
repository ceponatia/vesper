# Image Lab limitations

The Advanced Image Lab is a collection of specialized experiment instruments, not a general-purpose image-model playground. Each experiment kind has its own subject, inputs, prompt ownership, and evidence rules. That gives the lab strong records, but it also leaves several current constraints.

## No neutral selected-model trial

No experiment kind means simply “run this registered model with this prompt and these optional references.”

- `control_probe` requires a reviewed control fixture.
- `controlled_portrait` and `controlled_scene` require identity plus a control fixture.
- `two_character_scene` requires a chat and two bound identities.
- `finishing_pass` requires a prior finishable experiment.
- `staged_scene` requires a character, an identity reference, and registry-owned staging wording.
- `baseline_portrait` and `baseline_scene` reproduce production profile selection rather than forcing the selected lab model.

A lab-only renderer can therefore be selectable in the Model picker while still having no experiment whose contract matches a simple prompt-plus-reference smoke test.

## Baseline model selection follows production

The registry-backed Model picker is visible for baseline experiments, but the baseline runner resolves the active production profile and records the model that profile actually selects. The picker is not a model override for `baseline_portrait` or `baseline_scene`.

## Dedicated structural image inputs are not probe-derived

The capability contract can represent structural images that have provider fields of their own through `advancedCapabilities.additionalImageInputs`, and the render planner can route those images separately from the primary reference field.

The Replicate capability probe currently records scalar controls and `knownInputFields`, but it does not populate `additionalImageInputs`. A registered model with separate `depth_image` or `pose_image` inputs therefore has no probe-derived binding that tells the generic planner those roles use dedicated provider fields.

## General controls and provider-specific inputs are not exposed in the form

`ImageLabSettings` supports normalized render controls and a raw provider-shaped `controlInput` bag. The experiment form does not expose a general editor for either layer. Curated LoRA controls on finishing and staged experiments are the main exception.

A model-specific input such as the Vesper SDXL renderer's `recipe` field can exist in the provider schema and still be unavailable from the Image Lab UI.

## Controlled Mode is recorded metadata

Controlled experiments can record one of four modes: `identity_priority`, `controlled_composition`, `balanced`, or `style_priority`. The current controlled runner and recipe builder do not read the stored mode to change the render request. The value is therefore metadata, not an active experimental variable.

## Repeatability controls are limited

The form has no general seed control and no clone/rerun-with-one-change workflow. Even when a selected model exposes a seed input, an admin cannot use the normal Image Lab form to hold that seed constant across a visual A/B comparison.

## Some recipe roles have no picker

- `controlled_portrait` permits an optional `object` reference, but the form has no item-image source for that role.
- `staged_scene` permits an optional `location` reference, but the form has no chat-independent location-image source.

## Fixture extraction is portrait-oriented in the UI

The extraction service accepts owned source image ids, while the fixtures panel chooses a character and then one of that character's portrait renders. Scene images, lab outputs, and other owned images are not generally selectable as extraction sources from the current panel.

## Fixture-upload copy is narrower than the upload contract

The hand-authored upload path accepts pose, depth, and edge fixtures, but the panel labels that section and action as an uploaded “skeleton.” The underlying kind selector and server support all three.

## Scene baseline is not exact scene-state replay

`baseline_scene` uses the newest available chat-look reference and may add the newest chat-place reference. It does not reproduce every wardrobe/cache-key decision of the full player-facing scene lane. It is a production-profile/configuration baseline rather than a byte-for-byte replay of a past scene render.

The working-tier owner for changes to these constraints is `image-lab-general-model-trials.plan.md`.
