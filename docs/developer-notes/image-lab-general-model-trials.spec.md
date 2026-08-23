# Image Lab general model trials — implementation spec

Status: companion to `image-lab-general-model-trials.plan.md`

This spec owns the technical shape of the neutral Image Lab model-trial path and the concrete corrections discovered while documenting the existing bench. Product scope, delivery order, and open questions stay in `image-lab-general-model-trials.plan.md`.

## Current implementation facts

The Image Lab currently has eight specialized experiment kinds. None is a neutral selected-model runner:

- `control_probe` requires a reviewed structural fixture;
- controlled portrait/scene recipes require identity plus a fixture;
- `two_character_scene` requires a chat and two bound identities;
- `finishing_pass` requires a prior finishable experiment;
- `staged_scene` requires a character, identity reference, and registry staging;
- baselines resolve the active production profile instead of forcing the selected lab model.

The registry-backed Model picker improves selection correctness but does not change those experiment contracts.

Two existing seams are important to the implementation:

1. `ImageLabSettings` already carries normalized `controls` and a lab-only provider-shaped `controlInput` bag.
2. `ImageModelAdvancedCapabilities` already carries `additionalImageInputs`, and the render planner already understands dedicated structural-image fields. The current Replicate probe does not populate that array.

## `model_trial` contract

Add `model_trial` to `imageLabExperimentKinds` and every exhaustive kind switch.

A valid `model_trial` request has:

- an explicitly selected registered model path;
- an admin-authored instruction/prompt;
- zero through `IMAGE_LAB_MAX_INPUTS` ordered inputs using the existing `ImageReferenceRole` vocabulary;
- optional `ImageLabSettings`;
- no required character, chat, control fixture, source experiment, or staging.

The selected model must resolve to a registered row and an exact provider version before provider spend.

The kind initially has no verdict vocabulary. `imageLabVerdictOptions("model_trial")` returns `null`.

`model_trial` does not reinterpret an input role as a character binding. Per-input `characterId` stays exclusive to `two_character_scene` unless a later contract explicitly expands subject binding.

## Request validation

The create schema should enforce only contradictions that are client bugs. Runtime facts that can change between create and execution remain runner checks so the failed attempt is recorded on the experiment row.

Create-time rules:

- model selection is required for `model_trial`; there is no silent production/default fallback;
- no `sourceExperimentId`, `finishingVariant`, or `staging`;
- no top-level control pointer is required merely because an input uses a structural role;
- no per-input `characterId`;
- ordered positions remain contiguous and equal to array order.

Runner-time rules:

- selected model still resolves owner-independently through the registry;
- exact provider version still exists;
- every referenced owned image is readable;
- required trial references fit the selected model/policy;
- mapped controls and provider-specific inputs do not overwrite render-owned fields.

## Runner algorithm

Add a dedicated runner rather than routing the kind through `runBaseline` or `runControlProbe`.

The runner should:

1. Parse stored ordered inputs and settings.
2. Resolve and pin the selected registered model using the existing lab resolver.
3. Read ordered input bytes owner-scoped.
4. Build a permissive lab reference policy from the supplied roles without introducing production task requirements.
5. Route references using the same capability-based primary-versus-dedicated structural-input decision used by the shared render planner.
6. Map normalized controls against the selected model's probed bindings.
7. Merge validated lab-only provider inputs after normalized controls while refusing collisions with render-owned fields.
8. Record the effective prompt, version pin, reference outcome, and applied/dropped controls before provider execution where the current lab provenance contract requires it.
9. Execute through the existing model render wrapper with the explicit version pin.
10. Store the result as hidden `lab_output` and settle through existing lab helpers.

The runner must not construct Replicate field names such as `reference_image`, `depth_image`, or `pose_image` itself.

## Reference routing

The neutral trial reuses `ImageReferenceRole` and the capability layer's structural-role distinction.

For an ordinary content reference, the selected model's primary reference field and arity remain authoritative.

For a structural role (`pose`, `depth`, `edge`, `mask`, `control`):

- when the active model capability record declares a dedicated additional image input for that role, route the bytes to that provider field;
- otherwise route it as a numbered primary reference, subject to primary reference capacity.

This preserves Qwen Image Edit 2511's proven numbered-control behavior while allowing a renderer such as the Vesper SDXL deployment to use separate ControlNet inputs.

Required trial references never disappear silently. If the requested experiment cannot fit, it refuses before spend. A later UI may allow an input to be explicitly optional, but optionality must be recorded rather than inferred from role.

## Replicate probe: dedicated image inputs

Extend `deriveAdvancedCapabilities` in `@vesper/image-replicate` to populate `additionalImageInputs` from URI-typed provider inputs that are not the selected primary reference field.

Alias resolution happens at probe time only. Initial role hints should remain conservative:

- `depth_image` → `depth`;
- `pose_image` → `pose`;
- `mask` / `mask_image` → `mask`;
- `control_image` → `control`;
- edge/Canny aliases → `edge` only when deliberately recognized.

For each derived entry, record the provider field, arity, required status, declared max-items where present, and accepted media/format information where the schema exposes it.

Do not classify every URI field heuristically. Unknown URI inputs remain unbound until an explicit alias/rule is added; guessing a semantic role at render time would recreate the ambiguity the capability layer exists to remove.

After this probe change, re-probe the Vesper SDXL renderer so its pinned capability record contains dedicated `depth_image` and `pose_image` bindings.

## Normalized controls and provider-specific inputs

The neutral trial supports both layers already present in `ImageLabSettings`.

### Normalized controls

The UI may expose a normalized control only when the selected model's active capability record has a binding for it. Relevant existing controls include seed, negative prompt, guidance, steps, edit strength, output count, dimensions/resolution, thinking/set modes, and LoRA controls.

The control mapper remains the only place a normalized control becomes a provider field.

### Provider-specific inputs

Renderer-specific fields such as the Vesper SDXL deployment's `recipe` remain in the lab-only provider-input bag rather than expanding shared Vesper vocabulary.

The UI should show the selected model's `knownInputFields` and reject or clearly distinguish reserved render-owned fields. `prompt`, the model's primary reference field, aspect/dimension fields owned by the renderer path, and dedicated structural fields supplied through reference routing cannot be overwritten through the provider-input bag.

The plan owns the remaining question of whether undocumented/unprobed keys are allowed through an explicit unsafe mode.

## Form behavior

For `model_trial`, the New experiment form shows:

- Model — registry-backed and required; no production-default choice;
- Prompt — editable, whole prompt;
- References — ordered rows, each with image picker + role;
- Normalized controls — capability-driven;
- Advanced model inputs — provider-specific key/value editor;
- Effective request summary — selected model, pin availability, roles, and any pre-spend warnings.

The form should not require a character merely to choose an identity reference. A general owned-image picker is the correct long-term source for model-trial references; reusing a character portrait picker as the only source would recreate the fixture-panel limitation.

## Baseline model affordance

`baseline_portrait` and `baseline_scene` continue resolving production profiles exactly as they do today.

The create form should not present the registry Model picker as an override for those kinds. Show read-only copy that the model is resolved from the active production profile when the run starts. The experiment detail continues showing the model actually used.

No runner change is required for this correction.

## Controlled Mode affordance

The stored modes are currently:

- `identity_priority`;
- `controlled_composition`;
- `balanced`;
- `style_priority`.

`runControlled` and `imageLabRecipeProfile` do not consume `row.mode`. Until a deterministic request-level effect exists, the form should not describe Mode as an active bias knob. The plan recommends hiding the field rather than inventing arbitrary provider-number mappings.

Stored historic mode values remain readable metadata.

## Repeatable comparison workflow

A completed neutral trial should support a Duplicate / Run variant action that pre-fills a new experiment with:

- selected model;
- prompt;
- ordered inputs and roles;
- normalized controls;
- provider-specific inputs;
- explicit seed when one exists.

The action creates a new experiment id and never reruns the settled row in place. This preserves the lab rule that one experiment id identifies one render attempt/output.

## Fixture-panel corrections outside `model_trial`

The current fixture extractor service accepts owned image ids more broadly than the UI exposes. The panel remains character/portrait scoped.

A general owned-image source picker can broaden extraction without changing fixture provenance: the selected image id continues to become `sourceImageId` on generated controls.

The hand-authored upload heading/action should say “control fixture” rather than “skeleton”; the same upload contract already accepts pose, depth, and edge kinds.

These are UI corrections, not new fixture semantics.

## Scene-baseline semantics

`baseline_scene` remains a production-profile/configuration baseline. It reads the newest chat-look and optional chat-place rather than replaying every historic wardrobe/cache-key selection decision.

Do not describe it as exact scene replay. Exact replay, if ever required, belongs to a separate captured-render-intent mechanism rather than silent expansion of baseline semantics.

## Persistence and provenance

Reuse the existing experiment row and hidden output storage.

A successful or failed `model_trial` records the same provenance that makes existing lab evidence inspectable:

- selected/resolved model slug;
- requested exact version;
- provider-echoed executed version when available;
- final prompt;
- ordered input roles and source image ids;
- reference-plan outcome, including drops/renumbering where applicable;
- applied/dropped normalized controls;
- provider-specific input values safe to persist;
- prediction id;
- result image id or recorded failure.

Never persist provider credentials, signed temporary upload URLs, or LoRA locators when the curated library id is the authoritative value.

## Failure vocabulary

Reuse existing layer-owned refusal codes whenever they accurately describe the stop:

- `image_lab.input_missing` for unreadable stored inputs;
- `image_lab.version_unpinned` for an unreproducible model selection;
- `image_lab.capacity_exceeded` when the trial's required reference set cannot fit;
- `image_lab.settings_unsupported` only for settings the kind deliberately forbids;
- `image_profile.*` for planner/profile-level reference/control refusals where the shared planner owns the reason;
- `image_lora.*` for curated LoRA resolution failures;
- `image_lab.render_failed` for provider execution failures.

If `model_trial` needs a new stable lab failure code, add it only for a failure that cannot be expressed honestly by an existing owner vocabulary.

## Implementation status

- General model-trial contract/runner: remaining.
- General reference picker: remaining.
- Capability-driven normalized control UI: remaining.
- Provider-specific advanced-input UI: remaining.
- Replicate `additionalImageInputs` derivation: remaining.
- SDXL dedicated pose/depth re-probe and validation: remaining.
- Duplicate/run-variant workflow: remaining.
- Baseline Model affordance cleanup: remaining.
- Controlled Mode affordance cleanup: remaining.
- Fixture source-picker/copy cleanup: remaining.

No runtime behavior is changed by the documentation PR that creates this spec.
