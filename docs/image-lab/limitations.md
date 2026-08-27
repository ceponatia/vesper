# Image Lab limitations

The Advanced Image Lab is a collection of specialized experiment instruments, not a general-purpose image-model playground. Each experiment kind has its own subject, inputs, prompt ownership, and evidence rules. That gives the lab strong records, but it also leaves several current constraints.

Raw prompt-and-model testing is deliberately out of the lab's scope: that job belongs to the separate admin [Image Generator](../image-generator/README.md), which runs any registered model with a whole authored prompt, capability-bound controls, and duplicate/seed workflows the lab does not offer. The constraints below are about the lab itself.

## Every experiment kind carries evidence rules

No lab experiment kind means simply “run this registered model with this prompt and these optional references” — that request is an Image Generator run.

- `control_probe` requires a reviewed control fixture.
- `controlled_portrait` and `controlled_scene` require identity plus a control fixture.
- `two_character_scene` requires a chat and two bound identities.
- `finishing_pass` requires a prior finishable experiment.
- `staged_scene` requires a character, an identity reference, and registry-owned staging wording, and describes the subject from that character's visual state unless the operator picks the name-only ablation.
- `baseline_portrait` and `baseline_scene` reproduce production profile selection.

## Baseline model selection follows production

`baseline_portrait` and `baseline_scene` offer no model choice: the create form's Model slot is read-only copy, the form sends no model slug, and the runner records and executes whatever model the active production profile selects. A baseline is a production reproduction, never a selected-model smoke test.

## General controls and provider-specific inputs are not exposed in the form

`ImageLabSettings` supports normalized render controls and a raw provider-shaped `controlInput` bag. The experiment form does not expose a general editor for either layer; curated LoRA controls on finishing and staged experiments are the main exception. A model-specific input such as the Vesper SDXL renderer's `recipe` field can exist in the provider schema and still be unavailable from the Image Lab UI — the Image Generator's capability-driven form is where bound controls and probed provider inputs are editable.

## Controlled Mode is recorded metadata

Controlled experiments can store one of four modes: `identity_priority`, `controlled_composition`, `balanced`, or `style_priority`. No runner or recipe builder reads the stored mode to change a render request, so the create form does not offer it; historic stored values remain visible on the experiment detail view.

## A staged parity prompt can outgrow the edit prompt limit

Describing the subject adds roughly 500–700 characters to a staged prompt, so a character with a rich sheet can push one past the 1,500-character edit limit. A bench prompt has little the budgeter can shrink, so the clamp cuts the tail — the mood, lighting, and quality sentences — before it cuts anything the staging depends on. Production clamps a chat scene identically, so the parity claim still holds; the practical effect is that the most detailed characters buy the least room for style wording. The name-only ablation is unaffected.

## Repeatability controls are limited

The lab form has no seed control and no clone/rerun-with-one-change workflow. Even when a selected model exposes a seed input, an admin cannot hold that seed constant across a lab A/B comparison. Those affordances live on the Image Generator: an explicit seed control where the model binds one, and duplicate runs with recorded lineage.

## Scene baseline is not exact scene-state replay

`baseline_scene` uses the newest available chat-look reference and may add the newest chat-place reference. It does not reproduce every wardrobe/cache-key decision of the full player-facing scene lane. It is a production-profile/configuration baseline rather than a byte-for-byte replay of a past scene render.
