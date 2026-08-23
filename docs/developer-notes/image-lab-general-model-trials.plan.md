# Image Lab general model trials

Status: draft

Outcome: The owner can run any registered image model with a chosen prompt and references in the Image Lab so that a new renderer can be tested without forcing it through an unrelated specialized experiment.

**Proposed package/component:** `apps/web` Image Lab with existing `@vesper/image-core` capability planning  
**Primary owner:** application Image Lab  
**Primary integration:** image-model registry and shared image render path  
**Provider/dependency:** existing Replicate transport through `@vesper/image-replicate`

## 1. Goal

Add a neutral Image Lab experiment for exercising a registered renderer directly while preserving the existing specialized experiment kinds as narrowly defined evidence instruments.

The first useful shape is deliberately small: select a pinned registered model, author a prompt, optionally attach role-tagged references, run it, and retain the same model/version/input/output provenance the lab already records.

The result should feel like an extension of the existing Image Lab rather than a second model-testing system.

---

## 2. Core architectural rule

Specialized experiment kinds stay specialized. A general model trial does not weaken their subject, fixture, prompt-ownership, or verdict rules.

The neutral trial uses existing provider-neutral image roles and capability records. Provider field names remain a probe-time concern, not logic embedded in the Image Lab runner.

```text
Image Lab UI/service
        │
        ▼
registered model + role-tagged references
        │
        ▼
@vesper/image-core capability/reference planning
        │
        ▼
existing application render wrapper
        │
        ▼
@vesper/image-replicate transport
```

The application may depend on both image packages. `@vesper/image-core` and `@vesper/image-replicate` remain peers and do not import each other.

---

## 3. What the new component owns

The Image Lab owns:

- the neutral `model_trial` experiment contract and UI;
- the admin-authored prompt and selected role-tagged inputs;
- the decision to require a reproducible model/version before spending;
- lab-only advanced-input controls and their recorded values;
- the experiment record, output asset, and inspection workflow;
- repeatable comparison affordances that duplicate one experiment and change one variable.

These belong in the lab because they describe an admin experiment, not production image behavior.

---

## 4. What remains outside the component

The application image registry continues to own model rows and model resolution.

`@vesper/image-core` continues to own:

- reference-role vocabulary;
- capability records;
- control/reference routing decisions;
- normalized render controls;
- provider-neutral prompt preparation and planning rules.

`@vesper/image-replicate` continues to own:

- Replicate schema probing;
- provider field discovery;
- file/data-URL transport;
- payload construction;
- prediction execution and response normalization.

Existing Image Lab kinds continue to own their own evidence questions. This work does not turn baselines, control probes, finishing passes, or staged scenes into generic runners.

---

## 5. Existing system integration

The new experiment joins the current Image Lab creation and `lab_image` execution path.

```text
/settings/image-lab
        │
        ▼
existing experiment create route
        │
        ▼
image_lab_experiments
        │
        ▼
lab_image job
        │
        ▼
kind dispatch
        │
        ▼
model_trial runner
        │
        ▼
shared model/capability/render path
        │
        ▼
existing hidden lab_output storage
```

A new route is not required. A new database table is not required. A new job type is not required. A new package is not required. A new UI surface is not required; the existing New experiment form gains one kind-specific branch.

The experiment-kind vocabulary expands, but the database column already stores kind as text and does not require a schema migration solely for the new value.

---

## 6. Data and contract changes

The existing Image Lab experiment shape is sufficient for the neutral trial:

- `modelSlug` identifies the selected registered model;
- `instruction` holds the admin-authored prompt;
- `inputs` holds ordered role-tagged image ids;
- `settings.controls` holds normalized controls;
- `settings.controlInput` holds lab-only provider-specific input values;
- existing requested/executed version, prompt, prediction, outcome, and result fields retain provenance.

The experiment-kind union gains `model_trial`.

For this kind, the selected model is required rather than inferred from a production profile. Character, chat, control fixture, source experiment, and staging pointers are not prerequisites.

The trial has no verdict vocabulary initially because it is an inspection/smoke-test instrument rather than a predeclared hypothesis.

---

## 7. Model / provider / implementation strategy

Replicate remains the provider because the registered image-model system already resolves and executes Replicate models. The neutral trial is provider-neutral at the Image Lab contract boundary: it describes model identity, prompt, roles, and controls rather than provider field names.

Exact provider version resolution remains mandatory for lab evidence. A selected row that cannot be pinned refuses before spend.

Provider-specific fields such as an SDXL renderer's `recipe` remain provider-specific settings. They do not become new normalized Vesper controls merely because one renderer exposes them.

---

## 8. Starting configuration

The first implementation has no model-family-specific default beyond the selected model's own registered/default behavior.

- Prompt: admin-authored.
- References: none by default.
- Seed: unset unless the admin selects one and the model exposes a mapped seed control.
- Provider-specific inputs: absent unless explicitly supplied.
- Output: one image through the existing single-image lab path.

Change one meaningful variable at a time during controlled comparisons. A duplicated experiment should preserve the original model, prompt, references, and settings until the admin changes one of them.

---

## 9. State / identity / source-of-truth strategy

The selected image assets are the trial's input truth. The experiment does not independently reconstruct character, wardrobe, chat, or simulation state.

When an input is labeled `identity`, `pose`, `depth`, `location`, or another existing role, that role is the semantic truth the planner consumes. Provider-specific routing is derived from the registered model's capability record.

A neutral trial does not claim that an arbitrary identity image belongs to a particular character unless a later feature deliberately adds subject metadata. Character association is not required to run the trial.

---

## 10. Storage and association

No new storage system is introduced.

The trial reuses:

- `image_lab_experiments` for the durable experiment record;
- hidden `lab_output` assets for results;
- existing image ids for references;
- requested/executed provider version and prediction provenance already recorded by the lab.

The result remains hidden from player-facing image surfaces.

---

## 11. Current limitations that must remain limitations

The first implementation works within these limits:

- registered models only;
- exact provider version required;
- at most the Image Lab contract's existing eight ordered inputs;
- one output image through the existing lab result shape;
- no generic multi-output/image-set workflow;
- no automatic character/chat state compilation;
- no verdict vocabulary for the neutral trial;
- provider-specific advanced inputs remain admin-only.

This work deliberately expands dedicated structural-image routing only by populating and consuming the capability structure that already exists. It does not add a second generic image-input abstraction.

---

## 12. Specialized behavior

### Neutral model trial

Runs the selected model with the authored prompt and optional role-tagged references without imposing a production profile or another experiment kind's required subject.

### Advanced model inputs

Shows normalized controls that the selected model's capability record exposes. Model-specific fields that do not deserve a shared semantic control remain lab-only provider inputs and are recorded with the experiment.

### Reproducible variant

Duplicates a completed experiment with its model, prompt, inputs, settings, and explicit seed preserved so one field can be changed for an A/B comparison.

---

## 13. Failure and degradation behavior

- Missing/unreadable required selected input: refuse before provider spend and settle the experiment with a recorded reason.
- Selected model absent from the registry: refuse before spend.
- Exact version unavailable: refuse before spend.
- Text-to-image request on a model that cannot generate without a reference: refuse before spend.
- Required role/control cannot be routed or fit: refuse rather than silently change the experiment.
- Optional reference exceeds the permitted capacity: record the drop only when the trial explicitly treats it as optional; required trial inputs never disappear silently.
- Provider-specific input is invalid for the selected model: reject it before spend when the probed schema gives enough information to do so; otherwise record the provider failure honestly.
- Provider prediction failure: use the existing lab render-failure settlement and health reporting.

---

## 14. Web UI integration

The existing New experiment form gains `model_trial`.

The kind shows:

- the existing registry-backed Model picker, with no Default option that silently selects an unrelated production model;
- the admin prompt field;
- an ordered reference editor using the existing role vocabulary;
- normalized control fields only when the selected model advertises their bindings;
- an Advanced model inputs area for lab-only provider fields;
- a submit summary showing the effective model and inputs before spend.

Baseline kinds display their model as production-resolved rather than presenting the registry picker as an override.

Controlled Mode is not presented as an active experimental variable unless it gains a deterministic request-level effect.

---

## 15. Normal production path

This plan adds admin tooling, not a player-facing production path.

```text
admin opens Image Lab
        │
        ▼
creates model_trial
        │
        ▼
existing Image Lab route + job
        │
        ▼
registered model/capability planning
        │
        ▼
existing provider transport
        │
        ▼
hidden lab_output + experiment record
```

No ordinary image lane consumes `model_trial` output automatically.

---

## 16. Shared abstractions versus implementation-specific controls

Shared Vesper abstractions remain semantic:

- reference roles such as identity, pose, depth, edge, location, and style;
- normalized controls such as seed, guidance, steps, edit strength, and dimensions when the capability layer recognizes them;
- provider-independent model/version and capacity facts.

Renderer-specific switches such as an SDXL deployment's recipe id remain provider-specific inputs unless more than one implementation needs the same semantic concept or Vesper itself needs to reason about it.

---

## 17. Multi-entity / complex-case behavior

Zero references and one ordinary reference are the first proof.

Multiple ordinary references and dedicated structural controls are separate validation cases because they exercise capacity, ordering, and provider-field routing.

Two named character identities remain the responsibility of `two_character_scene`, whose subject-binding and cast verdict rules are intentionally stricter than a neutral model trial.

---

## 18. Prompting / policy / rule interaction

The admin-authored prompt is authoritative for `model_trial`.

The neutral trial does not wrap that prompt in a production prompt strategy or staging registry wording. Shared model-dialect preparation that every render receives may still apply at the normal render boundary.

State-derived character/wardrobe facts are not synthesized. Negative prompts and other normalized prompt controls are sent only when the selected model's recorded capability supports them.

Provider-specific advanced inputs cannot overwrite fields owned by the render path, such as the prompt, primary reference field, or aspect/dimension fields.

---

## 19. Development stages

### Stage 0 — Establish the baseline

Status: complete — 2026-08-23 — current experiment contracts and the missing neutral trial are documented.

Record the current lab behavior and the SDXL smoke-test gap without changing runtime behavior.

**Production behavior changes:** none.

---

### Stage 1 — Establish contracts/boundaries

Status: next

Add `model_trial` to the Image Lab contract and exhaustive runner/UI dispatch. Reuse the existing experiment row and job type.

**Production behavior changes:** none; admin lab only.

---

### Stage 2 — Minimal functional implementation

Status: queued

Run a selected pinned model with an admin prompt and zero or one ordinary reference, recording the existing provenance fields.

---

### Stage 3 — Validate the primary mechanism

Status: queued

Exercise the deployed Vesper SDXL renderer as text-to-image and prompt-plus-identity-reference. Verify that the selected model actually runs and the result is inspectable from the lab record.

---

### Stage 4 — Add the first multiplier

Status: queued

Expose lab-only advanced provider inputs so a renderer-specific recipe can be changed without adding that recipe vocabulary to shared image contracts.

---

### Stage 5 — Add secondary capability

Status: queued

Populate dedicated image-input capabilities during provider probing and validate pose/depth routing on the SDXL renderer.

---

### Stage 6 — Finishing / reliability

Status: queued

Expose seed where supported, add duplicate/run-variant behavior, and ensure the recorded trial makes every sent/dropped input and applied/dropped control inspectable.

---

### Stage 7 — First production integration

Status: void — the feature is an admin Image Lab instrument and does not require a player-facing production integration.

---

### Stage 8 — Complex cases

Status: queued

Validate multiple ordinary references, dedicated structural controls, capacity refusal, and the model-specific advanced-input edge cases that the first proof excludes.

---

### Stage 9 — Promotion decision

Status: void — `model_trial` remains lab tooling; individual model/profile promotion is decided by the plans and trials for those models.

---

## 20. Evaluation criteria

Success means:

- the selected registered model is the model that actually runs;
- exact requested/executed version provenance remains visible;
- prompt text and provider-specific inputs are inspectable after the run;
- one identity reference reaches the model in the correct primary field;
- dedicated pose/depth controls reach dedicated provider fields when the model declares them;
- required inputs never disappear silently to capacity trimming;
- seed-controlled duplicated experiments can differ in one chosen variable;
- existing specialized experiment behavior is unchanged;
- no provider field-name logic is added to the application runner.

---

## 21. First proof before substantial implementation

The cheapest proof is one new backend `model_trial` arm with no new advanced UI: select the already-registered Vesper SDXL renderer, send an authored prompt plus one identity reference, pin the version, and persist the output.

If that cannot be expressed cleanly through the existing model/capability/render seams, stop before building the richer control editor. The failure would show that the proposed neutral path is using the wrong abstraction.

---

## 22. Explicit non-goals

- Reusing `baseline_portrait` as a forced-model experiment.
- Weakening control-fixture review or subject-binding rules on specialized kinds.
- Adding a new image provider.
- Adding a new image-model registry or provider-specific registry.
- Adding a new database table for general trials.
- Teaching shared contracts every SDXL recipe id.
- Turning arbitrary provider JSON into player-facing configuration.
- Replacing the production render-intent/profile path.
- Solving two-character identity binding through the neutral trial.
- Making any newly tested model a production default as part of this work.

---

## 23. Risks and open questions

The main unresolved product/engineering choice is the advanced provider-input escape hatch. `control_probe` intentionally permits a raw provider bag for experimental inputs that may not exist in the normalized vocabulary, while the model registry also records `knownInputFields` for fail-closed configuration. The implementation needs an owner ruling on whether `model_trial` accepts only probed field names or also offers an explicitly unsafe/unverified raw-key mode for undocumented provider experiments.

A second question is whether the currently inert controlled Mode field is deleted from the UI or retained until a later experiment gives each mode a real request-level meaning. This plan recommends hiding it until it has an observable effect.

---

## 24. Definition of done

The work is complete when:

1. A registered pinnable model can run from the Image Lab without another experiment kind's subject requirements.
2. Prompt-only and prompt-plus-one-reference trials work where the selected model supports them.
3. Role-tagged structural inputs use recorded capability routing rather than application field-name guesses.
4. Renderer-specific advanced inputs are controllable and recorded without entering shared contracts unnecessarily.
5. An explicit seed can be preserved across a duplicated comparison when the model supports it.
6. Baseline model selection is presented as production-resolved rather than as an override.
7. Controlled Mode is either wired to a deterministic effect or no longer presented as one.
8. Existing specialized experiment kinds retain their current integrity gates and verdict meanings.
9. Lab outputs remain hidden and existing cost/provider-health accounting remains intact.
10. The current reference docs describe the resulting behavior without carrying this plan's future work.

---

## 25. Documentation requirements

Keep `docs/image-lab/` as the canonical current reference for the lab and keep future work in this working tier.

Update the Image Lab reference when each behavior becomes true. Record technical implementation decisions and stage status in `image-lab-general-model-trials.spec.md`. Record any model-specific trial verdict in that model/subsystem's own trial document rather than turning this plan into an experiment diary.
