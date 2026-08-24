# Image Generator and Image Lab model-testing boundaries

Status: active — Stages 1–6 built 2026-08-23 and corrected the same day; Stage 3's live validation runs need a deploy plus owner-approved provider spend

Outcome: The owner can select any registered image model, write the exact prompt to send, attach supported reference or structural images, change the controls that model actually exposes, and reproduce or vary the run without forcing the request through an unrelated Image Lab experiment; the Advanced Image Lab remains a stricter evidence bench whose specialized experiments keep their existing subject, fixture, prompt-ownership, and verdict rules.

**Proposed package/component:** `apps/web` admin Image Generator using the existing image registry, `@vesper/image-core`, and `@vesper/image-replicate`; targeted Image Lab UI cleanup shares only genuinely generic picker/capability components  
**Primary owner:** application Image Generator for freeform runs; Advanced Image Lab remains the owner of structured image experiments  
**Primary integration:** existing image-model registry, capability probing/planning, image asset registry, API job system, and shared provider render path  
**Provider/dependency:** existing Replicate transport through `@vesper/image-replicate`; no new provider in this work

> **Ruling:** this plan supersedes the earlier direction that proposed adding a neutral `model_trial` experiment to the Advanced Image Lab. `docs/developer-notes/image-lab-general-model-trials.spec.md` has been rewritten to match this plan and is the implementation authority for the Image Generator.

## 1. Goal

Separate two jobs that currently look similar but have different rules:

1. **Image Generator — freeform model exploration.** The owner chooses a registered model and directly explores what that model does with an authored prompt, ordinary reference images, structural images, normalized controls, and model-specific inputs that the registered capability record says exist.
2. **Advanced Image Lab — structured evidence.** Each experiment continues asking a predeclared Vesper question with its own subject, fixture, prompt ownership, provenance, and verdict semantics.

The Generator should make the common raw-model workflow straightforward:

```text
choose model
    |
    v
write exact prompt
    |
    v
attach zero or more supported inputs
    |
    v
change supported controls
    |
    v
generate -> inspect request/result -> duplicate -> change one thing -> generate again
```

The owner should not have to choose `control_probe`, manufacture a character/chat association, accept production profile resolution, or satisfy another experiment's evidence rules merely to answer "what does this registered model do if I send it this?"

The quality bar is that the new tool is a **new admin surface, not a new image stack**. It should reuse Vesper's registered model facts, capability records, provider transport, image preparation, jobs, provider health accounting, and asset storage. Adding a new model should normally make the Generator understand that model through its registry/capability record rather than through another model-specific React/server branch.

The Advanced Image Lab should become clearer at the same time: controls that are not real experimental variables should not be presented as though they are, production baselines should not imply that the Model picker overrides production, and generic image-source limitations should be repaired by shared picker work rather than by weakening experiment contracts.

---

## 2. Core architectural rule

**The Image Generator and Advanced Image Lab are sibling admin tools over the same image infrastructure. The Generator explores provider/model behavior; the Lab produces structured evidence about Vesper image behavior. Neither is implemented as a special case of the other.**

```text
                         apps/web admin surfaces
                     /                           \
                    v                             v
           Image Generator                 Advanced Image Lab
          freeform requests                evidence contracts
                    \                             /
                     \                           /
                      v                         v
                 application image/model services
                           |
             +-------------+-------------+
             |                           |
             v                           v
     @vesper/image-core          @vesper/image-replicate
     semantic contracts          Replicate schema/transport
             ^                           |
             +---------------------------+
                           |
                           v
                       Replicate
```

The dependency rules are:

- `apps/web` may depend on the shared image packages and application-owned registry/storage/job services.
- `@vesper/image-core` owns provider-neutral image semantics and must not import application or provider code.
- `@vesper/image-replicate` may consume the provider-neutral contracts it already uses, but provider field discovery and Replicate API behavior stay there rather than moving into the application.
- Image Generator code must not import Image Lab experiment runners to reach the provider.
- Image Lab experiment code must not import Generator run semantics merely to gain a generic model call.
- Generic UI/service pieces may be shared only after they have a coherent meaning outside either product surface: model picker, owned-image picker, capability-driven control editor, request inspector.
- Existing package-boundary and deep-import checks continue to apply. This work does not create an exception because two admin tools need the same lower-level function.

If the existing application render seam cannot execute a selected registered model without importing an Image Lab runner or duplicating Replicate payload knowledge, that is an architectural failure to repair in the shared image path before the Generator grows additional features.

---

## 3. What the new component owns

**The Image Generator owns the freeform run.** That is the coherent body of behavior that does not belong to an experiment or a production image lane.

It owns:

- the admin-only Generator page and run history;
- explicit registered-model selection, with no production-profile fallback masquerading as a model choice;
- the whole admin-authored prompt for a freeform run;
- selection of ordinary primary references supported by the chosen model;
- selection of dedicated structural/reference inputs exposed by that model's capability record;
- capability-driven normalized control values chosen for this run;
- provider-specific advanced values chosen for this run when the provider schema describes them and they are not fields owned by the render path;
- pre-spend validation that the selected model/version and explicitly requested inputs can actually be represented;
- a durable run record that says what was requested, what Vesper actually sent, what provider version ran, what came back, and why a failed run stopped;
- duplicate/run-variant behavior that preserves the original request, including the seed when one was explicit;
- comparison/inspection affordances that help the owner change one meaningful variable at a time;
- a future "open captured production render in Generator" workflow when exact request capture is proven complete enough to make replay honest.

These belong to the Generator because they describe an **operator-authored provider request**, not a scientific claim about a Vesper experiment and not a player-facing production profile.

The Generator does not need to know that an ordinary reference image belongs to a character or a chat unless the owner selected that image through a source that supplies such metadata. The image itself and the requested input binding are sufficient to run the model.

---

## 4. What remains outside the component

**The application image-model registry continues to own:**

- which image models are registered;
- labels, selected versions, reviewed model facts, and model resolution;
- the distinction between an operator-added registered model and an unregistered arbitrary provider path.

The Generator does not create a second model list.

**`@vesper/image-core` continues to own:**

- provider-neutral reference-role vocabulary where semantic roles are actually needed;
- normalized controls such as seed, guidance, steps, edit strength, dimensions/resolution, output count, and LoRA semantics already represented there;
- capability records and dedicated additional-image-input contracts;
- provider-neutral prompt/reference/control planning decisions that are common to production and admin tooling;
- shared failure vocabulary where an existing image-layer owner already has the right reason.

**`@vesper/image-replicate` continues to own:**

- Replicate model/version schema probing;
- alias discovery from provider field names into normalized controls;
- discovery of primary versus dedicated image inputs;
- Replicate payload construction and reserved-field handling;
- upload/file/data-URL transport;
- prediction execution and response normalization.

**The Advanced Image Lab continues to own:**

- `control_probe` and fixture review/evidence rules;
- controlled portrait/scene recipes;
- two-character subject binding and cast verdicts;
- finishing-pass evidence;
- staged-scene prompt ownership and LoRA-specific evidence;
- production-profile baseline semantics;
- experiment verdicts and experiment-specific provenance requirements.

The Generator does not add `model_trial` to that vocabulary.

**Production image lanes continue to own:**

- character/chat/state resolution;
- production profile selection;
- prompt compilation from Vesper state;
- wardrobe/location/identity selection policy;
- player-facing image lifecycle.

The Generator never reconstructs those truths merely because it is capable of calling the same renderer.

**Existing application infrastructure continues to own:**

- authorization;
- database and owner scoping;
- image assets/files;
- API jobs and concurrency limits;
- provider health/backpressure;
- quota policy;
- provider credentials.

This section is the primary guard against turning an admin playground into a parallel image platform.

---

## 5. Existing system integration

The Generator joins the existing registered-model and image-render stack, but it gets its own application route, job identity, persistence record, and UI because a Generator run is not an Image Lab experiment.

```text
/settings/image-generator
        |
        v
admin Image Generator API
        |
        v
persist generator run + queue image-generator job
        |
        v
resolve registered model + exact version
        |
        v
read/prepare selected owned image inputs
        |
        v
@vesper/image-core capability/control/reference planning
        |
        v
existing application registered-model render seam
        |
        v
@vesper/image-replicate
        |
        v
Replicate prediction
        |
        v
hidden generator output + settled run record
```

The existing model registry, model capability record, asset registry, job runner, provider-health lane, and Replicate transport remain authoritative.

This proposal **does require**:

- a new admin UI surface under Settings for Image Generator;
- a new admin API surface for Generator runs/history;
- a durable Generator-run record rather than storing runs as `image_lab_experiments`;
- a Generator image job type through the existing API job system so long provider calls retain the same concurrency/provider-health behavior as other image jobs;
- a hidden association/kind for Generator-created output assets so they do not appear as player-facing Gallery/portrait content merely because the owner used an admin tool.

This proposal **does not require**:

- a new image provider;
- a second model registry;
- a new provider client;
- a new standalone package merely to host the Generator;
- a second normalized-control vocabulary;
- a new production render profile;
- a new player-facing image lane;
- an Image Lab experiment kind.

The exact database and hidden-asset names belong in the implementation spec, but the ownership ruling does not: Generator runs are persisted separately from Lab experiments.

---

## 6. Data and contract changes

### Generator run

Add a durable provider-neutral Generator-run concept representing one immutable render attempt. Conceptually it carries:

- owner;
- run id and timestamps;
- status;
- selected registered model slug;
- exact requested/resolved provider version;
- whole authored prompt;
- ordered primary-reference image ids;
- any semantic labels recorded for those references when supplied;
- dedicated image-input selections, including their capability role/binding identity;
- normalized controls explicitly selected by the owner;
- provider-specific advanced input values safe to persist;
- the effective applied/dropped/refused-control and reference plan;
- provider prediction id;
- provider-echoed executed version when available;
- output asset id;
- stable failure reason and diagnostics.

One run id identifies one attempt. A variant creates a new run rather than mutating or rerunning a settled row in place.

### Generator image inputs

The Generator distinguishes two provider-neutral input shapes:

1. **Primary references** — ordered images sent through the model's ordinary primary reference binding. These do not require the owner to pretend every arbitrary source is a character identity. An optional semantic purpose may be recorded when useful, but provider routing comes from the selected model's primary-reference capability.
2. **Dedicated image inputs** — structural or other image fields represented by the model's capability record, such as pose, depth, edge, mask, or control. Their provider field is discovered at probe time and never typed into application logic.

This distinction lets a Qwen-style multi-reference model keep numbered primary images while an SDXL/ControlNet renderer sends a depth map to `depth_image` without teaching the Generator those provider field names.

### Capability description for advanced provider inputs

`ImageModelAdvancedCapabilities` already represents normalized controls, `knownInputFields`, and dedicated `additionalImageInputs`. The provider probe needs enough retained schema description for the Generator to render safe controls for known provider-specific fields that are **not** promoted into Vesper semantics.

The retained descriptor should be capable of representing, where Replicate declares it:

- field name;
- primitive type;
- required status;
- default;
- enum values;
- numeric minimum/maximum;
- short provider description;
- whether the field is already claimed by the prompt/reference/aspect/dimension/dedicated-image/render path.

The implementation spec may choose the exact contract name. It must not turn every Replicate input into a normalized `ImageRenderControls` field.

### Existing contracts reused

Reuse rather than duplicate:

- registered `ImageModel` and version facts;
- existing normalized control bindings;
- `additionalImageInputs`;
- image reference preparation;
- asset ids and owner-scoped reads;
- existing provider result/provenance shapes where they are already generic.

No character, chat, fixture, experiment verdict, staging, or production-profile pointer is required for a freeform Generator run.

---

## 7. Model / provider / implementation strategy

Replicate remains the only provider in the first implementation because Vesper already has a registered-model system, capability probe, payload builder, prediction client, provider health lane, and custom/community-model version behavior for it.

The Generator is **provider-neutral at its application contract boundary** but should not pretend provider plurality exists before a second image provider is actually integrated. The abstraction describes registered model identity, exact version, prompt, primary references, dedicated image inputs, normalized controls, and described advanced inputs. Replicate field names remain below that boundary.

Every Generator run must resolve the selected registered row to the exact provider version that will be sent **before spend** and record it. For models that can be selected by a moving official slug, the run still records the concrete version resolved for that attempt. An operator comparison is not reproducible if "same model" can silently mean different weights.

The first validation targets should be models already useful to current Vesper work:

- the registered Vesper SDXL renderer, because it exposes the current gaps around provider-specific `recipe` and dedicated structural image inputs;
- Qwen Image Edit 2511, because its numbered primary references prove the Generator must not assume every control-shaped image has its own provider field;
- at least one prompt-only registered model, to prove the surface does not accidentally require an image merely because the Generator was first validated on editors.

Do not add another provider or an arbitrary Replicate slug text box as part of this work. Register the model first, probe it once, then test it through the Generator.

---

## 8. Starting configuration

These are starting behaviors for the Generator, not model-quality defaults:

| Setting | Initial behavior |
| --- | --- |
| Model | Required explicit registered-model selection; no silent production/default choice |
| Prompt | Whole admin-authored prompt; required when the selected model requires a prompt |
| Primary references | None initially; add only when the model supports them |
| Dedicated structural inputs | None initially; show only capability-declared inputs |
| Seed | Unset; expose only when the active capability record binds a seed field |
| Guidance / steps / edit strength | Unset; provider/model default unless explicitly changed |
| Output shape | The model's own shape unless the owner picks one the version declares; nothing is cropped |
| Dimensions / resolution | No Generator-specific hardcoded value; expose the normalized choice the model supports |
| Provider-specific inputs | Omitted unless explicitly set; known/probed fields only in the first implementation |
| Output count | One image even when the model can return several; multi-output is a later complex case |
| Safety/provider switches | Existing registered/provider behavior; the Generator does not invent a bypass |

The comparison rule is: **duplicate a settled run, preserve every resolved value, and change one meaningful variable at a time.** A model's provider default is not converted into a Vesper default merely because one test happened to work well.

---

## 9. State / identity / source-of-truth strategy

A freeform Generator run does not reconstruct Vesper character/chat/world state.

Its authoritative inputs are exactly what the owner selected:

```text
registered model + resolved exact version
             |
admin-authored prompt
             |
selected image assets / bindings
             |
explicit controls and advanced values
             v
       Image Generator run
```

An existing image chosen as a reference remains authoritative as pixels. Its character/chat/entity linkage may be useful picker context, but the Generator does not infer additional wardrobe, identity-pack, location, or simulation facts from that association and append them to the request.

If a later "Open in Image Generator" feature starts from a production render, the authoritative source is a **captured render request/provenance record from that original render**, not a reconstruction from whatever the character/chat/profile looks like later. If current `images.meta.render` does not capture enough information to replay honestly, production rendering must capture the missing request facts at render time rather than asking the Generator to guess them later.

This is also why `baseline_scene` remains a production-profile/configuration baseline rather than becoming an exact historic-scene replay mechanism.

---

## 10. Storage and association

Generator runs need durable history because model exploration without exact provenance quickly becomes anecdotal and because duplicate/run-variant depends on being able to reconstruct the original request.

Use the existing database and image asset registry, but add a Generator-owned run record instead of reusing `image_lab_experiments`.

The association is conceptually:

```text
image generator run
      |
      +-- selected registered model + exact version
      +-- ordered existing/uploaded source image ids
      +-- effective controls / advanced values
      +-- prediction provenance
      |
      v
hidden generator output image
```

Generator outputs remain internal/admin assets. They must not appear in the player-facing Gallery, character portrait strip, public-entity widening, cloning, or other ordinary image surfaces solely because they are stored in `images`. The implementation should extend the existing hidden/internal asset policy rather than add a separate filesystem/storage service.

When the Generator later supports direct uploads that exist only to feed experiments, the implementation spec must make an explicit retention/quota ruling for those uploaded source images. Do not automatically classify uploads as quota-free merely because Generator outputs are hidden; source uploads are user-supplied storage and have different retention economics from derived internal output.

Persist enough provenance to answer:

- which exact model/version ran;
- which source image ids were read;
- which dedicated/primary input each source occupied;
- which controls were requested and actually applied;
- which advanced provider values were sent;
- which values were refused/dropped and why;
- which provider prediction produced the result;
- whether the result is a duplicate/variant of another run.

Never persist credentials, signed temporary upload URLs, or resolved secret-bearing provider locators when an internal id is the authoritative reference.

---

## 11. Current limitations that must remain limitations

The first implementation deliberately works within several limits rather than turning a model playground into a redesign of every image contract.

- **Registered models only.** The Generator is not an arbitrary provider endpoint console.
- **Replicate only.** Provider-neutral contracts should remain honest, but a second provider is a separate integration.
- **Exact-version provenance required.** If a selected row cannot be resolved reproducibly, refuse before spend rather than generating untraceable evidence.
- **One output image per run initially.** Existing output capability may say a model supports more, but multi-output storage/comparison is a separate complex case.
- **No automatic character/chat state compilation.** That remains production-lane behavior.
- **No Image Lab verdict semantics.** A Generator result is inspected or compared; it is not automatically evidence for `honours_control`, identity fidelity, staged-scene success, or another Lab verdict.
- **No undocumented provider-key free-for-all in the first implementation.** Advanced inputs come from probed/known schema fields. An explicit unsafe/unverified raw-key mode, if ever wanted, requires a later owner ruling.
- **No silent capacity trimming of explicitly selected inputs.** If the model cannot fit what the owner explicitly asked to send, refuse or require the owner to remove an input.
- **No generic contract expansion solely because one SDXL renderer exposes a field.** `recipe`, sampler-like switches, and similar controls stay provider/model-specific until Vesper has a semantic reason to normalize them.
- **A conservative application cap on total freeform image inputs is acceptable for the first implementation** even when a provider advertises more, provided the UI states the cap and dedicated fields do not incorrectly consume primary-reference capacity. Raise it only after the complex cases are tested.

This project deliberately **does** expand one existing common capability: provider probing must populate dedicated image-input facts that `ImageModelAdvancedCapabilities.additionalImageInputs` already knows how to represent. It also adds provider-schema descriptors for otherwise-unmapped known inputs so the admin UI can expose them without hardcoding each renderer.

---

## 12. Specialized behavior

### Model-driven Generator form

The selected registered model drives the form. The owner sees only capabilities the active probed version actually declares.

A prompt-only model can run with no image input. An edit model whose primary image is required makes that requirement visible before submit. A model with a seed binding gets a Seed control; one without it does not. A renderer with a known `recipe` field can expose that field under Advanced Model Inputs without making `recipe` a Vesper-wide concept.

The UI is generated from normalized capability bindings plus retained provider-field descriptors, not from `if (modelSlug === ...)` branches.

### Primary references

Primary references are an ordered list using the model's existing primary-reference field and arity/capacity facts. They are raw model inputs, not automatically character identities.

The Generator may record an optional semantic purpose for inspection and future prompt helpers, but no semantic label may cause the tool to rewrite the owner's whole prompt unless the owner explicitly invokes such a helper. The default Generator request preserves the authored prompt.

### Dedicated image inputs

When the model's capability record declares dedicated inputs such as pose, depth, edge, mask, or generic control, the form shows separate image slots for them. The provider field behind each slot is a capability-probe fact.

A model with no dedicated pose field can still accept a pose-like image as an ordinary numbered primary reference when that is how the model is designed; the Generator must not guess a dedicated provider field merely from the word "pose".

### General owned-image picker

The Generator needs an owner-scoped picker that is not limited to character portraits or one chat's scene outputs. It should be able to select eligible existing owned images such as:

- character renders;
- scene/chat renders;
- Image Lab outputs when appropriate;
- previous Generator outputs;
- other owner-accessible image assets that the source policy permits;
- later, direct uploaded Generator source images.

This picker should become a reusable application component/service. Image Lab may reuse it only for roles whose experiment contract truly accepts a generic source.

### Normalized controls

Normalized controls already understood by `@vesper/image-core` appear only when the selected active capability record binds them. The control mapper remains the only place a semantic Vesper control becomes a provider field.

An explicitly selected normalized value that cannot be represented at execution time is a refusal, not a silent drop that makes an A/B comparison dishonest.

### Advanced model inputs

The Advanced section exposes described provider-specific scalar/enum/boolean inputs that remain outside Vesper's normalized vocabulary.

The application must distinguish:

- fields the owner may edit;
- fields already owned by prompt/reference/aspect/dimension/dedicated-input plumbing;
- unknown/unprobed fields that are not accepted in the first implementation.

Advanced inputs cannot overwrite render-owned fields through a second path.

### Duplicate / run variant

A settled run can create a new draft/run with the same:

- model and exact version choice where still valid;
- prompt;
- primary references and ordering;
- dedicated image inputs;
- normalized controls;
- advanced values;
- explicit seed.

The owner changes one field and runs again. The original row/output remains immutable.

### Image Lab boundary cleanup

The new Generator does not eliminate the smaller Lab corrections discovered by the limitations audit:

- `baseline_portrait` and `baseline_scene` keep production-profile model resolution; their form should show that as read-only behavior rather than presenting a Model picker that looks like an override.
- Controlled Mode remains historical metadata until a deterministic request-level effect exists. Hide it from the active experiment form rather than implying that `identity_priority`, `controlled_composition`, `balanced`, or `style_priority` currently change a render.
- `controlled_portrait` may use the shared general picker to supply its already-permitted optional `object` reference.
- `staged_scene` may use the shared general picker for its already-permitted optional `location` reference instead of requiring a chat-derived location image.
- fixture extraction may use the shared general picker because the extraction service already accepts owned source image ids more broadly than the current character/portrait UI does.
- hand-authored fixture upload copy should say **control fixture**, with Pose / Depth / Edge choices, rather than calling every supported fixture a skeleton.
- `baseline_scene` documentation/UI should continue calling it a production-profile/configuration baseline, not exact replay.

These are Lab UX/semantic corrections. They do not change the evidence rules of the experiment kinds.

### Captured render replay

A later Generator feature may allow an owner to open a production image's **captured effective request** in the Generator and replay it exactly, then vary one field. This is the correct home for exact request replay because it is a debugging/model-exploration action rather than a baseline experiment.

It must use captured request provenance, not rebuild a historic render from current chat/wardrobe/cache/profile state.

---

## 13. Failure and degradation behavior

The Generator is admin tooling, so fail closed before spend whenever the selected request cannot be represented honestly.

- **Selected model missing from registry:** refuse before spend.
- **Exact provider version cannot be resolved:** refuse before spend and keep the failed run/diagnostic inspectable if a run row has already been created.
- **Model requires a primary reference and none is supplied:** refuse before spend.
- **Model cannot generate from text alone and the owner asks for prompt-only:** refuse before spend.
- **Selected image id is no longer owner-readable or its bytes are missing:** refuse before provider spend; do not substitute another image.
- **Selected primary references exceed capability or application capacity:** refuse and identify the capacity mismatch; do not silently trim explicit inputs.
- **Dedicated structural input has no active capability binding:** refuse that explicit input rather than guessing a provider key.
- **A normalized control is no longer bound on the active version:** refuse the explicit value and identify the changed capability instead of quietly running a different request.
- **Advanced provider value uses an unknown/unprobed field:** reject in the first implementation.
- **Advanced provider value collides with a render-owned field:** reject before spend.
- **Advanced value violates a declared enum/type/range:** reject before spend when the probe provides enough information; otherwise record the provider validation failure honestly.
- **Provider schema drift after registration:** version/capability mismatch should fail visibly and prompt a re-probe rather than adapting heuristically at render time.
- **Reference preparation fails:** settle the run failed through existing image-layer diagnostics; do not send unprepared bytes through a special Generator bypass.
- **Provider prediction fails:** settle the run failed, retain prediction/failure provenance, and report the provider outcome through the existing image provider-health lane.
- **Output storage fails after a successful provider response:** record that distinction; a successful provider call followed by local persistence failure must not be reported as provider outage.
- **Optional UI-only metadata unavailable:** omit it without changing the request. For example, losing an entity display label must not prevent an owner-readable image id from being sent.

The Generator does not automatically fall back to a production model, another renderer, or a different input strategy. A freeform test that silently changes the model/request is worse than a visible failure.

---

## 14. Web UI integration

A new admin/settings surface is necessary because the Generator and Lab communicate different mental models.

| Web feature | Existing mechanism | New behavior |
| --- | --- | --- |
| Settings navigation | Existing admin Settings surfaces | Add **Image Generator** as a sibling of Advanced Image Lab |
| Model selection | Registry-backed Image Lab/model selectors | Reuse a generic registry-backed picker; selection is required and is the model that actually runs |
| Prompt | Existing textarea components | Whole prompt owned by the admin; no experiment recipe wrapper |
| Primary references | Existing image/portrait/scene pickers are narrowly scoped | Add reusable general owned-image picker and ordered primary-reference rows |
| Dedicated image inputs | Capability records already have `additionalImageInputs` shape | Show model-declared dedicated slots such as pose/depth/mask/control |
| Normalized controls | `ImageRenderControls` + capability bindings exist | Render only active supported controls |
| Advanced model inputs | `knownInputFields` exists but current UI has no general editor | Capability/probe-driven scalar/enum editor excluding reserved render-owned fields |
| Run history | Image Lab list is experiment-specific | Separate Generator run/result history with request inspection |
| Variant workflow | No general clone/rerun-with-one-change workflow | Duplicate settled run with seed/request preserved |
| Image Lab baseline Model | Current form can imply selectable override | Replace with read-only production-profile resolution copy |
| Image Lab Controlled Mode | Stored but currently inert | Hide from active creation UI until wired to deterministic behavior |
| Image Lab extra sources | Portrait/chat-scene source restrictions | Reuse general picker for already-permitted object/location/extraction roles |
| Fixture upload copy | Calls the upload a skeleton | Rename to control fixture and show actual pose/depth/edge kind |

The Generator should show an **effective request summary before spend** once the model and inputs are selected: model/version availability, required inputs, primary-reference count/capacity, dedicated slots, and explicit controls. It should not dump raw internal JSON as the main UI.

After the run, an expandable inspector may show the safe persisted effective request/provenance in a developer-friendly form.

---

## 15. Normal production path

N/A — the Image Generator is an admin/operator tool and is not promoted into a player-facing production image lane. Existing avatar, portrait, character, scene, chat-look/place, and other production routes continue resolving state and profiles exactly as they do today.

The permanent **admin path** is:

```text
owner opens Image Generator
        |
        v
selects registered model + prompt + supported inputs
        |
        v
Generator API persists run / queues existing job system
        |
        v
shared registry + capability + preparation/render services
        |
        v
@vesper/image-replicate
        |
        v
hidden Generator output + durable run provenance
```

A future production-render replay integration points **from** an existing production image record **into** this admin tool. It does not redirect ordinary production rendering through the Generator.

---

## 16. Shared abstractions versus implementation-specific controls

The rule is unchanged: promote a concept into common Vesper image contracts when multiple implementations need the same semantic concept or Vesper itself needs to reason about it dynamically.

**Shared/provider-neutral concepts include:**

- registered model identity and exact version;
- primary reference arity/capacity;
- existing semantic reference roles where used;
- dedicated additional image inputs with semantic role hints;
- seed;
- negative prompt;
- guidance;
- inference steps;
- edit strength;
- output count;
- dimensions/resolution;
- coherent/sequential/thinking modes already normalized;
- LoRA weights/scale where the existing shared contract already defines them;
- provider-independent failure/provenance facts.

**Provider/model-specific concepts remain provider/model-specific:**

- an SDXL deployment's `recipe` id;
- a provider-specific sampler or scheduler exposed only by some models;
- one-off implementation toggles whose meaning Vesper does not use elsewhere;
- raw provider field names behind primary/dedicated image bindings.

The Generator may expose the second group under **Advanced Model Inputs** because it is a model playground. Exposure does not promote those settings into production profile vocabulary.

The new provider-input descriptor is metadata about what the provider version declares, not a second normalized-control system.

---

## 17. Multi-entity / complex-case behavior

The simple proof is intentionally narrower than the complete playground.

### Initial cases

Validate separately:

1. prompt-only text-to-image;
2. prompt plus one ordinary primary reference;
3. one explicit normalized scalar control such as seed;
4. one provider-specific advanced scalar/enum input.

### Secondary cases

Then validate:

- multiple primary references with stable ordering;
- primary references plus a dedicated pose image;
- primary references plus a dedicated depth image;
- a model that accepts structural guidance only through numbered primary references rather than dedicated fields;
- mixed dedicated inputs whose fields do not consume primary-reference capacity;
- an image-input model with a required reference;
- changing active model version/capability after an old run exists;
- selecting a previous Generator output as a new input;
- using Image Lab output as a Generator input without making the new run an experiment.

### Later complex cases

Keep separately gated until proven:

- provider-supported multi-output/image sets;
- very large reference counts;
- direct uploads and their retention/quota behavior;
- replaying captured production renders;
- comparison grids larger than a simple A/B pair;
- any explicit unsafe raw-key mode for undocumented provider fields.

Two-character identity **binding** remains an Image Lab concern when the question is which named identity landed on which subject. The Generator may send two arbitrary images to a model, but it does not inherit the Lab's cast-verdict semantics merely because the pixels depict two people.

---

## 18. Prompting / policy / rule interaction

For a freeform Generator run, the **admin-authored prompt is the whole positive prompt** unless the owner explicitly selects a helper that says otherwise.

The Generator does not:

- prepend production profile wording;
- compile character/chat state;
- add staging-registry prose;
- insert Image Lab numbered-role instructions behind the owner's back;
- rewrite a prompt merely because an image came from a character or chat;
- add model-family prose in the application UI based on a hardcoded slug.

Shared prompt fitting/transport behavior that every registered-model render requires may still run at the normal image boundary. Any transformation must remain inspectable in the effective request so the recorded prompt is the prompt the provider actually received, not just the textarea value.

Negative prompt remains a normalized control only when the active model exposes the binding. Model-specific prompt syntax belongs in model/provider strategy or explicit owner-authored text, not in the Generator's generic contract.

Provider safety constraints and registered configuration continue applying exactly as they do through the existing render client. This tool does not create a provider-safety bypass.

When exact production render replay is added, the captured original prompt/request is the starting truth. The Generator may let the owner edit it, but the duplicated run must clearly distinguish original captured values from changed values.

---

## 19. Development stages

### Stage 0 — Establish the baseline

complete — 2026-08-23

Documented the current Image Lab limitations and inspected the existing Lab form/runner, registered-model capability contract, Replicate probe, asset registry, and job/provider-health path.

Owner ruling: raw prompt/model testing is not another Image Lab experiment. The earlier `model_trial` direction in this plan is superseded by a separate Image Generator that reuses the same lower-level infrastructure.

Baseline constraints to preserve include:

- specialized Lab experiments have meaningful subject/fixture/prompt/verdict rules;
- baselines resolve production profiles;
- `additionalImageInputs` already exists in the shared capability contract but Replicate probing does not populate it;
- normalized controls and a known-input allowlist already exist;
- the current Lab UI does not generically expose those controls/advanced fields;
- existing asset/job/provider-health infrastructure already supports hidden admin image work.

**Production behavior changes:** none.

---

### Stage 1 — Establish contracts/boundaries

complete — 2026-08-23

Define the minimum Generator-owned contracts and application boundaries before building a rich UI.

Include:

- durable Generator-run contract and immutable-attempt semantics;
- primary-reference versus dedicated-image-input request shape;
- safe persisted request/provenance shape;
- Generator API boundary and owner scoping;
- Generator job type through the existing image provider-health/concurrency system;
- hidden Generator output association through the existing asset registry;
- provider-input descriptor shape for known non-normalized fields;
- explicit reserved-field ownership rules;
- package/deep-import boundary tests;
- rewrite or retire `image-lab-general-model-trials.spec.md` so no implementation document still instructs agents to add `model_trial` to the Lab.

Do not build a new package unless this boundary work demonstrates a reusable package-sized body of behavior that cannot live cleanly in the application plus existing image packages.

**Production behavior changes:** none; contracts/admin infrastructure only.

---

### Stage 2 — Minimal functional implementation

built 2026-08-23 — awaiting Stage 3's live validation on the deployed app

Build the smallest complete Image Generator:

- new admin Settings page;
- required registered-model picker;
- whole prompt editor;
- zero or one ordinary primary reference selected from an existing owner-scoped image source;
- exact version resolution before spend;
- durable Generator run;
- existing job system and registered-model render seam;
- hidden output storage;
- result/history inspection showing selected model, exact version, prompt, input id, prediction id, output, and failure.

Do **not** build the generic advanced-control editor, structural inputs, uploads, side-by-side comparisons, or production replay yet.

The purpose is to prove that a separate Generator can reach the existing render infrastructure without importing an Image Lab runner or duplicating Replicate field mapping.

---

### Stage 3 — Validate the primary mechanism

blocked on a production deploy plus owner-approved provider spend

Use fixed prompts/assets and prove that the selected model is actually the model that runs. Automated validation is complete — the whole build is covered by pure and integration suites with the provider seam stubbed — so what remains is exactly the part that needs real money.

The manual checklist, in order, one run each:

1. the registered Vesper SDXL renderer as prompt-only text-to-image;
2. the same renderer with one ordinary reference;
3. the same renderer with a dedicated pose or depth image, **after** the re-probe below;
4. the same renderer with its provider-specific `recipe` set under Advanced Model Inputs;
5. Qwen Image Edit 2511 with ordered primary references;
6. one prompt-only registered model with no image requirement;
7. one run with the shape left blank, confirming the stored image is the model's own size and was not cropped to 3:4;
8. one exact captured-version replay, if a safe pair of versions exists on a registered model.

Each run should be checked for: the requested and executed version on the record, the effective request naming real provider field names, owner-scoped input reads, hidden output storage, provider health reporting, and no production-profile substitution.

Runs 3 and 4 depend on re-probing the Vesper SDXL renderer so its pinned capability record gains the dedicated structural bindings and the `recipe` descriptor. That is an admin action on the deployed app, not code.

If the Generator cannot express these through the existing registry/render seam, stop and repair the shared seam before adding model-specific controls.

---

### Stage 4 — Add the first multiplier

built 2026-08-23 — the SDXL `recipe` validation rides Stage 3's paid runs

Make model selection drive the scalar/control UI.

Extend Replicate probing/capability persistence so the active model version exposes:

- existing normalized control bindings;
- enough descriptor metadata for otherwise-unmapped known scalar/enum/boolean inputs;
- required/default/type/range/enum information where the provider schema declares it;
- which fields are reserved by prompt/reference/aspect/dimension/render plumbing.

Add Generator UI for:

- normalized controls only when bound;
- Advanced Model Inputs for safe known provider-specific fields;
- effective-request preview before spend.

Validate the Vesper SDXL renderer's provider-specific `recipe` without promoting `recipe` into common Vesper controls.

---

### Stage 5 — Add secondary capability

built 2026-08-23 — except direct source uploads (awaiting the retention/quota ruling) and the SDXL re-probe (post-deploy admin action)

Add the general image-input surface and fix the dedicated structural-input probe gap.

Include:

- Replicate derivation of `advancedCapabilities.additionalImageInputs` from conservatively recognized URI fields;
- role hints for deliberately recognized pose/depth/mask/control/edge aliases;
- re-probe the Vesper SDXL renderer so its pinned capability record contains the dedicated structural bindings it actually declares;
- Generator dedicated image slots driven from those capability records;
- reusable general owned-image picker;
- direct Generator source upload only after retention/quota semantics are explicitly settled;
- validation that Qwen-style numbered structural references still work through primary references rather than being falsely moved to a dedicated field.

Reuse the general picker back into the Image Lab where its existing contracts already permit generic sources:

- `controlled_portrait` optional object reference;
- `staged_scene` optional location reference;
- fixture extraction source selection.

Also correct fixture-upload copy from "skeleton" to "control fixture" with Pose / Depth / Edge kind wording.

---

### Stage 6 — Finishing / reliability

built 2026-08-23 — except the side-by-side A/B view; reproducibility proof rides Stage 3's runs

Make freeform exploration reproducible enough to replace ad hoc provider-console testing.

Add:

- explicit seed control where supported;
- Duplicate / Run variant preserving the original request and seed;
- clear original-versus-changed request diff;
- simple side-by-side A/B inspection;
- applied/refused/dropped control/reference inspection;
- stale-capability/version handling;
- provider failure versus local persistence failure distinction;
- retry/duplicate semantics that never mutate a settled run;
- safe provenance redaction for signed URLs/secrets/provider locators;
- integration tests proving concurrency and provider-health behavior matches the existing image lane.

Perform the remaining Image Lab affordance cleanup:

- baseline kinds show production-resolved model behavior instead of a misleading override picker;
- hide Controlled Mode from active creation until it has a deterministic render effect;
- keep historic Mode values readable;
- update baseline-scene copy/docs to say production-profile/configuration baseline rather than exact replay.

---

### Stage 6b — Correctness pass

complete — 2026-08-23

An independent review of the built Generator found six places where an operator-authored request could still be quietly changed, or where a legitimate model could not be run at all. All six are corrected and covered by automated tests; the spec records the rulings.

- A model that generates from a prompt and takes a required structural image (a pose or depth map) is now runnable. Selecting a structural image no longer turns the request into an edit, which had made that whole class of model impossible to use.
- The Generator asks for the model's own output shape. It no longer inherits the 3:4 portrait shape every player-facing image uses, and no longer crops a result toward it. An owner who wants a specific shape picks one the model actually offers.
- A reference image the owner explicitly selected is either sent or the run refuses. The provider is never paid for a render that quietly left one behind.
- One authoritative check runs over the finished request just before the provider is called, so a request the model's own schema would reject costs a refusal rather than a render.
- Every run writes down what was actually sent in the provider's own vocabulary, and the capability facts it ran under, before the money is spent — so re-testing a model later cannot make an old run's record misleading.
- Duplicating a run whose model has moved to a new version asks which version to run, and an exact replay is executed against the facts recorded at the time or refused honestly.

Also corrected while in the runner: two deliveries of the same queued run can no longer both pay for a render, and a settled run cannot be rewritten.

A second, adversarial review of the corrected code found five more, all fixed in the same stage:

- The pre-spend record described the wrong request on the handful of models Vesper applies reviewed quality corrections to. Those corrections are added on the way out, so the record — and the check that runs just before the provider call — now look at the request as the provider will receive it, and the record lists the whole request rather than only the controls the owner set.
- On a model whose declared shapes are its sizes, asking for a resolution tier always failed, naming a provider field the owner could neither see nor set. The form no longer offers the tier there — the shape picker is the same choice — and a request that still carries one is refused in plain words.
- A model registered before Vesper started recording per-field descriptions accepted raw provider values it could not check. Those are now refused until the model is re-probed.
- A duplicated run could carry an output shape the model declares but never actually uses, which the form showed as blank and the run then refused. The form now treats "declared" and "actually sent" as the same question everywhere.
- Deleting a run at the exact moment its render finished could leave the produced image behind with nothing pointing at it.

### Stage 7 — First production integration

void — the Image Generator is intentionally admin tooling and ordinary player-facing image generation must not route through it.

A future production image may expose an admin-only **Open in Image Generator** affordance, but that is a debugging handoff into the Generator, not a production rendering dependency.

---

### Stage 8 — Complex cases

queued

Validate the cases deliberately excluded from the first implementation:

- multiple ordinary primary references and model-specific capacity limits;
- primary plus multiple dedicated structural inputs;
- models with required dedicated inputs;
- previous Generator output as a source;
- Image Lab output as a source;
- provider-supported output sets if there is a concrete need;
- large input sets and preparation cost;
- conflicts between normalized controls and advanced provider fields;
- model re-probe/version drift against old run history;
- uploaded Generator source retention/quota after the policy is decided.

Then audit `images.meta.render` and the production render provenance to determine whether an exact captured request can be replayed. If complete enough, add **Open in Image Generator** from an owned production render. If not, first add missing capture at the production render boundary; do not reconstruct historic wardrobe/cache/reference choices from current state.

---

### Stage 9 — Promotion decision

queued

Decide whether the Image Generator is reliable enough to become the permanent operator surface for raw registered-model testing and whether the old `model_trial` proposal can be removed from all working documentation.

Compare the completed tool against the current ad hoc workflow on:

- time to run a new registered model;
- correctness of selected-model/version execution;
- ability to reach every supported model input without source edits;
- repeatability of A/B comparisons;
- provenance quality;
- absence of Image Lab semantic regressions;
- maintainability when another model with different fields is registered.

Promotion here means **permanent admin tooling**, not a player-facing default and not promotion of any particular image model to production.

---

## 20. Evaluation criteria

| Dimension | What is being evaluated |
| --- | --- |
| Boundary correctness | Can raw model exploration happen without creating/weakening an Image Lab experiment? |
| Selected-model correctness | Is the explicitly selected registered model/version the one that actually runs? |
| Capability fidelity | Does the UI expose controls/inputs only when the active model version declares them? |
| Reference correctness | Are primary references ordered/capacity-checked and dedicated structural inputs routed to capability-declared fields? |
| Prompt fidelity | Does the provider receive the owner's intended whole prompt without hidden experiment/production wording? |
| Reproducibility | Can a run be duplicated with exact model/version, prompt, images, controls, advanced values, and seed preserved? |
| Provenance | Can an owner later determine exactly what was requested, sent, executed, returned, or refused? |
| Failure honesty | Do unsupported/stale inputs refuse before spend rather than silently changing the test? |
| Image Lab integrity | Do specialized experiment prerequisites, prompt ownership, fixtures, verdicts, and production baseline semantics remain unchanged? |
| UI clarity | Does the tool make "model playground" versus "structured experiment" obvious without requiring knowledge of internal architecture? |
| Maintainability | Can a newly registered/probed model expose most of its usable form without model-slug-specific application code? |
| Provider health/cost | Do Generator calls use existing image concurrency/backpressure/accounting rather than bypassing them? |
| Storage safety | Are Generator assets owner-scoped, hidden from ordinary product surfaces, and retained/quota-accounted according to explicit policy? |

A strong acceptance test is registering/re-probing a model whose input schema differs from the initial SDXL/Qwen cases and confirming that the Generator adapts from capability data rather than requiring a new hardcoded form branch.

---

## 21. First proof before substantial implementation

Before building advanced controls, structural-image UI, uploads, comparison grids, or production replay, prove one deliberately tiny path:

> Create the separate Generator run/page boundary, select the already-registered Vesper SDXL renderer, send one authored prompt with zero or one ordinary reference through the existing registered-model render path, pin/record the exact version, and persist the hidden result in a Generator-owned run record.

Pass means:

- no `image_lab_experiments` row is created;
- no Image Lab runner is imported;
- no production profile silently replaces the selected model;
- no Replicate provider field name is constructed in the Generator application code;
- the exact request/result provenance is inspectable;
- existing image provider health/concurrency logic sees the call.

If that proof requires a model-specific application branch or bypasses the shared render/provider path, stop. The correct next task is repairing the shared abstraction, not layering a rich Generator UI on the wrong seam.

---

## 22. Explicit non-goals

- Adding `model_trial` to the Advanced Image Lab.
- Weakening control-fixture review, character binding, prompt ownership, production baseline, finishing-pass, staged-scene, or verdict rules so arbitrary model testing fits an existing experiment.
- Turning Image Lab experiments into a generic provider console.
- Routing player-facing production image generation through the Image Generator.
- Adding a second image-model registry.
- Supporting arbitrary unregistered Replicate model paths from the Generator.
- Adding another image provider.
- Creating a new provider client when `@vesper/image-replicate` already owns the transport.
- Promoting SDXL's `recipe` or another one-model field into shared `ImageRenderControls` without a cross-implementation semantic reason.
- Allowing arbitrary undocumented provider JSON in the first implementation.
- Solving every provider's multi-output/image-set behavior in the first implementation.
- Automatically compiling characters, wardrobe, chats, locations, visual state, or simulation state into freeform Generator prompts.
- Making `baseline_scene` an exact replay engine.
- Reconstructing old render requests from current state when exact request provenance was not captured originally.
- Making any model tested in the Generator a production default as part of this work.
- Redesigning the Gallery or portrait studio merely to host Generator history.
- Refactoring unrelated image code discovered during implementation; document adjacent work separately.

---

## 23. Risks and open questions

| Question | Why it matters | Resolution |
| --- | --- | --- |
| What exact persisted provider-input descriptor is sufficient for a safe generic advanced-input form? | Too little metadata recreates model-specific UI; too much makes core contracts mirror Replicate wholesale. | Stage 1 contract review against several registered model schemas, then implement the minimum fields listed in §6. |
| Should direct Generator uploads be ordinary quota-counted private assets or a separate admin-source kind with its own retention rule? | Existing hidden derived kinds are excluded from ordinary surfaces and quota; user-supplied sources have different storage economics. | Explicit owner ruling before Stage 5 upload support; existing owned images are sufficient before then. |
| How should a run preserve an exact version when an official registered slug tracks latest? | A duplicated comparison is invalid if the same displayed model silently changes weights. | Resolved 2026-08-23: every run pins and records a concrete version. A duplicate with no drift runs the current pin; a duplicate whose source pinned a different version makes the owner choose, and an exact replay is executed against the capability facts that run recorded or refused outright. |
| Are current `images.meta.render` records complete enough for exact production replay? | Determines whether "Open in Image Generator" can copy a captured request or whether production rendering must first capture more facts. | Stage 8 fixed audit over representative production image kinds; never reconstruct missing fields from current state. |
| Which URI-like provider fields should the Replicate probe bind into `additionalImageInputs` automatically? | Over-broad heuristics can route identity pixels into a depth/control field; under-broad rules leave legitimate structural inputs inaccessible. | Conservative explicit alias table with tests for pose/depth/mask/control/edge and no catch-all semantic guessing. |
| Should the Generator ever allow an explicit unsafe/unverified raw provider key? | Useful for undocumented experiments, but it bypasses the exact schema contract that keeps admin tests reproducible and fail-closed. | Exclude initially. Revisit only after the known-input editor is used in practice and a concrete blocked case exists. |
| What application cap should guard very large primary-reference sets? | A provider may advertise a high/unbounded count that is unpleasant for UI, upload preparation, latency, or cost. | Start conservative in the implementation spec and raise only after Stage 8 measurements. |
| Should semantic labels on ordinary primary references be required, optional, or omitted? | The Lab needs role semantics; raw provider exploration sometimes only needs "Image 1/Image 2" ordering. Requiring a false identity/style role would pollute provenance. | Initial Generator contract treats primary ordering as authoritative and semantic purpose as optional; revisit only if shared prompt helpers need it. |

The older companion spec's `model_trial` design is **not** an open question. The owner ruling in this plan supersedes it.

---

## 24. Definition of done

The work is complete when:

1. The owner can open a distinct Image Generator admin surface and run an explicitly selected registered image model without creating an Image Lab experiment.
2. The selected model resolves to a concrete provider version before spend, and requested/executed version provenance is inspectable afterward.
3. Prompt-only and prompt-plus-primary-reference runs work wherever the selected model capability permits them.
4. Supported normalized controls are exposed from capability bindings rather than hardcoded per model in the Generator.
5. Known provider-specific advanced inputs can be set without promoting them into shared Vesper controls, and reserved render-owned fields cannot be overwritten through the advanced editor.
6. Replicate probing populates dedicated structural image-input capabilities conservatively, and the Generator can route at least the Vesper SDXL renderer's dedicated pose/depth inputs without application field-name guesses.
7. Qwen-style structural guidance that belongs in numbered primary references remains supported and is not incorrectly forced into a dedicated input.
8. A general owner-scoped image picker exists and is reused for the Image Lab's already-permitted object/location/extraction sources without weakening experiment rules.
9. Generator runs/results are durable, owner-scoped, hidden from ordinary player-facing image surfaces, and use existing job/concurrency/provider-health infrastructure.
10. A completed run can be duplicated with its exact request and explicit seed preserved so one meaningful variable can be changed for an A/B comparison.
11. Explicitly requested inputs/controls never disappear silently because of capacity, stale capability data, or provider-field collisions.
12. Image Lab baselines no longer present their Model control as an override, inert Controlled Mode is no longer presented as an active knob, and fixture upload copy accurately describes pose/depth/edge control fixtures.
13. `baseline_scene` remains documented as a production-profile/configuration baseline; exact replay, if implemented, uses captured production request provenance through the Generator.
14. Existing Advanced Image Lab experiment contracts, verdicts, fixture gates, staged prompt ownership, and subject-binding behavior remain unchanged except for the explicit UI/source-picker corrections in this plan.
15. Adding or re-probing a materially different registered Replicate model normally changes the Generator's available inputs/controls from capability data rather than requiring another model-slug-specific application branch.
16. Working documentation no longer instructs agents to implement the superseded Image Lab `model_trial` direction.

---

## 25. Documentation requirements

This plan remains the working-tier owner for the limitations currently described by `docs/image-lab/limitations.md` until implementation is complete.

During implementation:

- rewrite `docs/developer-notes/image-lab-general-model-trials.spec.md` into an Image Generator implementation spec or retire it in favor of a newly named companion spec; do not leave the `model_trial` instructions active;
- add current reference documentation for the Image Generator once its contracts exist, preferably under a dedicated `docs/image-generator/` surface rather than making the Image Lab README describe two tools;
- update `docs/image-lab/` reference pages when baseline model affordance, Controlled Mode visibility, source pickers, fixture copy, and baseline-scene wording actually change;
- update `docs/images/providers.md` / model-capability documentation when provider-input descriptors and `additionalImageInputs` probing become current behavior;
- update `docs/images/asset-registry.md` when Generator source/output asset kinds or retention rules are introduced;
- update database/job documentation when the Generator run record/job type becomes current behavior;
- record fixed validation evidence for SDXL, Qwen numbered references, dedicated pose/depth routing, advanced provider inputs, and duplicate/seed reproducibility;
- document intentionally deferred multi-output, unsafe raw-key mode, upload retention, or exact production replay work rather than silently widening this plan during implementation;
- remove resolved items from `docs/image-lab/limitations.md` only after the corresponding runtime/UI behavior is true.

Record architectural rulings and reasons rather than a chronological implementation diary. In particular, preserve the reason for the main boundary: **the Image Generator exists so raw model exploration does not weaken the Advanced Image Lab's evidence contracts, while both continue sharing one registered-model/capability/provider stack.**