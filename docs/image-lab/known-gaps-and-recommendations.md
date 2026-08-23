# Known gaps and implementation recommendations

This document describes gaps in the Image Lab as it exists on `main` as of 2026-08-23, including the registry-backed Model picker added in #170. These are implementation observations, not claims about the original design intent.

The picker fix is useful: registered models are now selectable by name, unpinnable rows are visibly disabled, and `Other` retains the escape hatch for an alternate path spelling. It fixes model-selection **UX**. It does not change the contracts of the experiment kinds below.

## P0: there is no general selected-model trial

Claude's summary is correct at the experiment-contract level. The current kinds each carry a specialized contract:

- `control_probe` requires a declared, reviewed fixture at run time;
- `controlled_portrait` and `controlled_scene` require identity + fixture;
- `two_character_scene` requires a chat and two bound identities;
- `finishing_pass` requires a prior finishable experiment;
- `staged_scene` requires a character, identity reference, and registry staging and replaces admin prompt authorship with registry wording;
- `baseline_portrait` and `baseline_scene` are production-profile comparisons, not selected-model runs.

There is therefore no honest way to say **“run this registered model/version with this prompt and zero or more references.”**

That blocks the simplest Image Lab test of the new `ceponatia/sdxl-character-render`: prompt + one identity reference. The renderer is registered lab-only specifically so it can be exercised before promotion, but the Image Lab has no experiment whose semantics match that request.

### Recommendation: add a new `model_trial` kind

Do **not** relax or repurpose `baseline_portrait`. Its current behavior is coherent: a baseline resolves the production profile and records the model production actually chose. Turning it into a sometimes-production/sometimes-forced-model path would make old and new rows with the same kind mean different things.

A `model_trial` should have a deliberately small contract:

- **model: required**, selected from the registry and resolved to an exact pinned provider version;
- **prompt: admin-authored**, sent as authored except for model-level transport preparation shared by all renders;
- **ordered inputs: 0–8**, each with an existing reference role; no fixture, chat, character, source-experiment, or staging requirement;
- **settings: allowed**, including normalized controls and a lab-only provider-input escape hatch;
- **subject metadata: optional at most**, never a prerequisite for running the model;
- **no verdict vocabulary initially**. It is a smoke/inspection instrument, not evidence for a predetermined claim.

Zero references makes it a text-to-image smoke test when `model.canGenerate` permits it. One `identity` reference makes it the missing “reference + prompt” test. Structural roles can be supported using the role-aware transport described below.

## P0: use the role-aware transport, not the current probe's anonymous-buffer shortcut

The current `control_probe` direct renderer passes a plain `Buffer[]` to `runRegistryImageModel`. That is adequate for a model whose controls are ordinary numbered references, but it cannot express a renderer with separate `reference_image`, `depth_image`, and `pose_image` fields.

Vesper already has the correct lower-level machinery:

- `planIntentReferences` can separate primary references from structural controls that have a dedicated provider input;
- `renderWithModel` accepts primary references **and** `controlReferences` with concrete provider field/arity bindings;
- `runRegistryImageModel` transports both sets and writes dedicated controls to their own provider fields.

The general model trial should reuse those pieces without pretending it is a production profile. A lab-specific planning seam can apply a permissive reference policy, preserve caller order, route structural roles through `controlReferenceTransport`, map normalized controls, and then call `renderWithModel` with the exact version pin.

This gives the lab provider-neutral behavior while keeping provider field-name discovery out of experiment code. The important architectural rule is that `model_trial` should be a neutral renderer exercise path, while the existing recipe kinds remain evidence about production-shaped requests.

## P0/P1: the capability probe does not currently populate dedicated image inputs

The capability contract supports `advancedCapabilities.additionalImageInputs`, and the render planner knows how to use it. However, the current Replicate probe's `deriveAdvancedCapabilities` populates normalized scalar controls and `knownInputFields` only; it does not populate `additionalImageInputs`.

That matters immediately for the Vesper SDXL renderer. Its schema exposes:

- `reference_image` — identity/PuLID anchor;
- `depth_image` — preprocessed depth control;
- `pose_image` — preprocessed OpenPose control.

The probe correctly prefers `reference_image` as the primary reference field, but without `additionalImageInputs`, the planner has no recorded fact telling it that depth and pose belong in dedicated fields.

### Recommendation

Extend probe-time capability derivation—not render-time guessing—with a conservative alias table for extra URI inputs. For example:

- `depth_image` → role hint `depth`;
- `pose_image` → `pose`;
- `mask` / `mask_image` → `mask`;
- `control_image` → `control`;
- future explicit edge/canny aliases → `edge` only when deliberately added.

Record field, arity, required status, max-items, and accepted formats from that exact provider version. This follows the capability layer's existing rule: aliases are resolved once at probe time and render code only consumes recorded bindings.

Re-probe the SDXL row after this change so its version-specific capability record contains the dedicated inputs.

## P1: provider-specific inputs exist in the contract but not in the form

`ImageLabSettings` already has two layers:

- normalized `controls`;
- raw provider-shaped `controlInput`, explicitly documented as a lab-only escape hatch.

The current experiment form does not expose a general editor for either layer. The main exception is curated LoRA controls on finishing/staged experiments.

This is why the SDXL renderer's `recipe` input is effectively inaccessible from the Image Lab UI. #170 now makes the renderer itself easy to select, but selecting the model does not give the form a way to send `recipe`, so lab runs still receive the renderer's default recipe.

### Recommendation

For `model_trial`, add an **Advanced model inputs** section:

1. Show normalized controls only when the selected model's probed capability record exposes them: seed, negative prompt, guidance, steps, edit strength, dimensions/resolution, etc.
2. Provide a provider-input editor for remaining lab-only keys. Validate keys against `advancedCapabilities.knownInputFields` when possible, flag reserved fields (`prompt`, primary reference, aspect), and make the final stored payload visible.
3. Keep raw provider input forbidden on production-shaped controlled recipes.

This would let an admin choose `recipe: "sdxl/identity-portrait-w065"` without adding SDXL recipe names to generic Vesper contracts.

## P1: the controlled Mode selector is currently inert

The form offers the four recorded modes `identity_priority`, `controlled_composition`, `balanced`, and `style_priority` and stores the selected value on the experiment. I found no current runner or recipe code that reads `row.mode` to change the render request. The value therefore labels an experiment without altering it.

### Recommendation

Either:

- remove/hide Mode until it has a concrete effect; or
- make modes explicit recipe/profile variants whose differences are inspectable and recorded (reference priority, identity control, style weighting, or another actual model-neutral knob).

Avoid translating the names into arbitrary provider numbers inside the runner. If a mode has no deterministic request-level difference, it should not be presented as an experimental variable.

## P1: baselines expose a false model affordance

The form shows the registry-backed Model picker on every kind. `runBaseline` explicitly resolves the production profile and overwrites the experiment's stored model slug with that profile's model. A model selected for `baseline_portrait` or `baseline_scene` therefore does not select the model that runs.

The #170 picker fix does not change this; it only makes the ignored choice safer to make.

### Recommendation

Hide the Model picker for baseline kinds. Replace it with read-only copy such as **“Model: resolved from the active production profile when the run starts.”** The detail screen can continue showing the model actually resolved.

## P1: experiments cannot easily hold all other variables constant

The settings contract supports seed when the model exposes a mapped seed input, but the form exposes no seed control and no general clone/rerun-with-one-change workflow. That makes visual A/B work unnecessarily vulnerable to stochastic differences.

### Recommendation

Once `model_trial` exists, expose the selected model's normalized `seed` control and add **Duplicate experiment** / **Run variant** from a completed experiment. Preserve model, version target, prompt, inputs, settings, and seed by default; let the admin change one field. This makes the lab behave like an experiment bench rather than a sequence of unrelated renders.

## P2: some recipe capabilities are not reachable from the UI

- `controlled_portrait` permits an optional `object` reference, but the form has no client-reachable item-image source and therefore offers outfit/style only.
- `staged_scene` permits an optional `location` reference, but the form has no chat-independent location-image source. The staged kind intentionally refuses a chat, so its current chat-scoped scene-image picker cannot be reused directly.

These are honest current limitations, but they should be documented as such rather than inferred from the recipe schema alone.

## P2: fixture extraction UI is narrower than the backend

The extraction API accepts owned image ids, but the fixtures panel selects a character and then one of that character's portrait renders. This makes it awkward to derive controls from scene renders, lab outputs, or other owned images.

### Recommendation

Replace or supplement the character-only picker with a general owned-image picker that can filter by source/type. Keep the source image id in fixture provenance exactly as today.

## P2: upload copy says “skeleton” for every fixture kind

The upload path supports pose, depth, and edge, but the panel heading/button says **Upload a skeleton**. Rename it to **Upload a control fixture** so a depth or edge upload does not look unsupported.

## P2: scene baseline is not full scene-state replay

`baseline_scene` uses the newest available chat-look reference and does not reproduce all wardrobe/cache-key selection behavior of the player-facing scene lane. It is a production-profile/configuration baseline, not an exact replay of every scene reference-selection decision.

If exact replay becomes important, the baseline should snapshot the production lane's resolved render intent rather than reconstructing a simplified one later.

## Suggested implementation order

1. Add `model_trial` with prompt + zero/one primary reference first. This immediately makes the lab useful for the new SDXL renderer's base and PuLID identity smoke tests.
2. Add provider-input UI so `recipe` and other model-specific lab inputs are controllable and recorded.
3. Populate `additionalImageInputs` during the capability probe and route pose/depth through the existing dedicated-control transport.
4. Expose normalized seed/model controls plus experiment duplication for controlled A/B work.
5. Remove false affordances: the baseline Model picker and inert Mode, unless Mode is wired to real recipe differences.
6. Broaden asset pickers and close the smaller optional-role/UI gaps.

The architectural goal should be: **specialized experiment kinds remain specialized evidence instruments; `model_trial` is the neutral escape hatch for exercising any registered renderer.** That keeps the lab extensible without weakening the integrity rules that make the existing experiments useful.
