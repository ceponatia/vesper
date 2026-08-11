# Image model capabilities — technical spec

Status: companion to
[image-model-capabilities.plan.md](image-model-capabilities.plan.md)

Shipped foundation this extends:
[image-model-registry.plan.md](finished/image-model-registry.plan.md) and
[image-model-registry.spec.md](finished/image-model-registry.spec.md).

## Scope

This spec extends the Replicate image-model registry. It does not replace the
registry, restore a provider abstraction for Venice, or introduce fallback
between different image models.

The implementation adds four concepts:

1. richer mechanical and reviewed semantic capabilities on a registered model;
2. task-specific profiles beneath a model;
3. one normalized render intent shared by every image-producing lane;
4. shared adapters for references, controls, dimensions, outputs, versions, and
   LoRAs.

The first migration and profile seed must be behavior-preserving. Existing model
ids and slugs remain valid stored selections and resolve to a default profile for
the requested task.

## Implementation status

Everything below is design unless this table says otherwise. "Every lane" means
all seven player-facing render lanes call it on every render.

| Section                             | Status                          |
| ----------------------------------- | ------------------------------- |
| Extensions to `image_models`        | shipped 2026-08-05 (mig 0100)   |
| Advanced capability contract        | shipped; probe fills nothing    |
| `image_model_profiles`              | shipped 2026-08-05 (mig 0100)   |
| Profile task eligibility            | shipped 2026-08-05              |
| Reference policy                    | shipped 2026-08-11 (slice 3)    |
| Normalized controls                 | shipped 2026-08-05              |
| `image_loras`                       | not started                     |
| Image sets                          | not started                     |
| Profile resolution                  | shipped 2026-08-07, every lane  |
| Normalized render intent            | shipped 2026-08-07              |
| Prompt strategies                   | 4 of 7 arms (compose landed)    |
| Reference preparation and transport | control binding only (slice 9)  |
| Control mapping                     | shipped 2026-08-07, every lane  |
| Dimension negotiation               | not started                     |
| Replicate prediction shell          | timeouts only; single-output    |
| Version candidate and promotion     | not started                     |
| Model-specific seeded profiles      | not started                     |
| Admin UI                            | not started                     |

## Current anchors

The implementation is spread across these seams:

- `src/contracts/images/image-models.ts` — model record, surface filtering,
  reference capacity, and aspect selection;
- `src/contracts/images/image-model-capabilities.ts` — reviewed capability
  vocabulary and the advanced-capability contract;
- `src/contracts/images/image-model-profiles.ts` — profile record, normalized
  controls, eligibility, and the pure resolver;
- `src/server/ai/replicate-probe.ts` — save-time OpenAPI probe;
- `src/server/ai/replicate.ts` — input construction, the reserved-field set,
  reference transport, prediction polling, output download, and file cleanup;
- `src/server/ai/image-control-mapping.ts` — normalized controls onto one
  version's declared fields, plus provider-override validation;
- `src/server/ai/image-providers.ts` — scene attempt ordering and capability
  checks;
- `src/server/images/models.ts` — registry resolution, shape negotiation, and
  crop normalization;
- `src/server/images/model-profiles.ts` — profile loading and task resolution;
- `src/server/images/render-profile.ts` — the profile compile step
  (`compileProfileRenderPlan`), the prompt-strategy dispatch over both reference
  vocabularies, and the version-pin rule;
- `src/contracts/images/render-intent.ts` — the intent vocabulary, the
  required-role check, and capacity selection;
- `src/server/images/render-intent.ts` — `planImageRender` and
  `renderImageIntent`, the entry point every render lane calls;
- `src/server/images/quality-presets.ts` — the reviewed-quality seam that
  rewrites a model's constants and prompt dialect at the render boundary;
- `src/server/images/scene.ts` — scene degradation ladder and the current
  three-reference cap, now carrying reference roles through each rung;
- `src/server/images/variants.ts`, `entity.ts`, `chat-look.ts`, `avatar.ts` and
  `character-scene.ts` — the lanes, each resolving its own task's profile and
  emitting an intent.

`resolveSurfaceModel`, `loadImageModelsForSurface` and the pure
`resolveImageModel` were **deleted** with the lane migration, along with the two
default-model slug constants they fell back to. Two resolvers answering "which
model runs this job" is how a picker and a render come to disagree.

The registry fields remain useful. In particular, `referenceField`,
`referenceArity`, `referenceTransport`, `maxReferences`, `aspectMode`,
`supportedAspects`, `outputFormat`, and `extraInput` continue to serve the basic
request path.

## Design invariants

The following rules are normative:

- A selected profile resolves to exactly one registered model and one active
  Replicate version.
- A prediction never falls across to a different model after a failure.
- An input key is sent only when the active pinned version declares it.
- Required identity references are retained ahead of optional references.
- A profile may narrow a model’s capabilities but may not claim capabilities the
  model does not expose.
- Existing single-image callers continue to receive one image.
- Multi-output workflows use an explicit image-set path.
- Provider output is normalized before durable storage.
- `Cancel-After` and the local polling deadline use the same resolved timeout.
- Safety-mode enforcement remains system-owned and cannot be overridden by a
  profile.
- Model and profile configuration is administrator-only.
- Unknown or deleted stored selections degrade at resolution time to a valid
  default. A failure during the selected model’s run remains visible.

## Data model

### Extensions to `image_models`

**Shipped 2026-08-05** in `drizzle/0100_daffy_mystique.sql`, which also rates the
six seeded models. These fields are the registry table's, but they are specified
here rather than in the registry spec because the capabilities work owns them.

The fields:

- `probedVersionId` — nullable text. The exact version whose schema produced the
  stored mechanical capabilities. For a pinned slug, this must equal the pinned
  version.
- `editKind` — reviewed enum: `none`, `instruction_edit`,
  `multi_reference_compose`, `img2img`, or `unknown`.
- `identityPreservation` — reviewed enum: `strong`, `moderate`, `weak`, or
  `unknown`.
- `operatorWarning` — nullable text displayed in admin configuration and model
  or profile pickers. Wan moderation is the initial use.
- `advancedCapabilities` — validated jsonb containing optional bindings and
  constraints not represented by the current normalized columns.
- `updatedAt` — timestamp used when showing capability and version changes.

The reviewed fields are never overwritten by a normal re-probe — the admin PATCH
route accepts them and deliberately excludes them from the re-probe write set. A
candidate version flow may copy them forward but must not silently improve or
downgrade a quality judgment.

`advancedCapabilities` is version-specific provider data. It is replaced
atomically when the active version changes. It is also deliberately not settable
through the admin route: the probe cannot derive control bindings yet, so a write
path would only ever blank it.

`probedVersionId` is written by the create route and by an explicit re-probe. The
six seeded rows carry null, because the seed predates the column — a controlled
comparison therefore refuses them until an admin re-probes.

### Advanced capability contract

**Shipped 2026-08-05** as `src/contracts/images/image-model-capabilities.ts`. The
probe does not populate it, so every row holds `{}` and every optional control is
dropped with a `no_binding` reason at mapping time — which is exactly current
render behavior.

The shape:

```ts
export interface ImageInputBinding {
  field: string;
  type: "string" | "integer" | "number" | "boolean" | "enum";
  required?: boolean;
  minimum?: number;
  maximum?: number;
  enumValues?: string[];
}

export interface ImageUriBinding {
  field: string;
  arity: "single" | "array";
  required: boolean;
  maxItems?: number;
  acceptedFormats?: string[];
}

export interface ImageModelAdvancedCapabilities {
  prompt?: {
    field: string;
    maxChars?: number;
    recommendedChars?: number;
  };
  controls: {
    seed?: ImageInputBinding;
    negativePrompt?: ImageInputBinding;
    guidance?: ImageInputBinding;
    steps?: ImageInputBinding;
    editStrength?: ImageInputBinding;
    outputCount?: ImageInputBinding;
    coherentSet?: ImageInputBinding;
    sequentialMode?: ImageInputBinding;
    thinkingMode?: ImageInputBinding;
    customWidth?: ImageInputBinding;
    customHeight?: ImageInputBinding;
    resolutionTier?: ImageInputBinding;
    loraWeights?: ImageInputBinding;
    loraScale?: ImageInputBinding;
  };
  additionalImageInputs: Array<{
    roleHint: ImageReferenceRole;
    binding: ImageUriBinding;
  }>;
  output: {
    arity: "single" | "array";
    supportsMultiple: boolean;
  };
  knownInputFields: string[];
}
```

The current primary reference columns remain the normalized binding for ordinary
references. `additionalImageInputs` carries a control role's OWN provider input —
mask, pose, depth, edge, control — and is read at render time by
`controlReferenceTransport` (§"Control-image binding"): an entry routes that role
off the primary array and onto its own field. It is empty on every model Vesper
runs today, so every control currently rides the numbered references.

`knownInputFields` supports validation of low-level profile overrides. It is not
used to construct a payload by itself.

### `image_model_profiles`

**Shipped 2026-08-05** in `drizzle/0100_daffy_mystique.sql`, with 17 built-in
profiles seeded. The table:

- `id` — text primary key;
- `imageModelId` — foreign key to `image_models`, delete cascade;
- `key` — stable machine key, unique within a model;
- `label` — picker label;
- `task` — enum described below;
- `operation` — `generate` or `edit`;
- `promptStrategy` — registered prompt-strategy id;
- `referencePolicy` — validated jsonb;
- `controlDefaults` — validated jsonb using normalized control names;
- `providerOverrides` — validated jsonb escape hatch;
- `timeoutMs` — nullable integer, bounded from 30 seconds through 15 minutes;
- `enabled` — boolean;
- `isDefault` — boolean within the task;
- `builtin` — display provenance only;
- `sort`, `createdAt`, and `updatedAt`.

Initial task values:

```ts
export const imageProfileTasks = [
  "portrait",
  "variant",
  "scene",
  "item",
  "location",
  "chat_look",
  "chat_place",
  "text_repair",
  "example_transform",
  "image_set",
] as const;
```

The existing `forPortrait`, `forVariant`, and `forScene` model toggles remain
broad model-level gates during migration. A profile is offered only when its
model is enabled for the corresponding legacy surface and the profile itself is
enabled. Tasks without a legacy surface use enabled profiles directly.

A later cleanup may replace the legacy toggles, but this plan does not require
that cleanup.

Only one enabled profile may be the global default for a task. Enforced by the
partial unique index `image_model_profiles_default_per_task` on `(task) WHERE
is_default AND enabled`. `timeoutMs` is bounded by a table check constraint at
30 seconds through 15 minutes, matching the zod schema.

### Profile task eligibility

**Shipped 2026-08-05** as `profileEligibility` /
`imageProfileOffered`.

A profile with `operation: generate` requires `model.canGenerate`.

A profile with `operation: edit` requires `model.canEdit` and a non-`none`
`editKind`.

Identity-critical tasks (`variant`, `scene`, `chat_look`) **reject** rather than
warn: `identityPreservation: weak` yields `identity_too_weak` and
`editKind: img2img` yields `img2img_identity_task`, and either drops the profile
from the offered set. See the slice 1 rulings at the end of this document.
`unknown` stays permissive.

`img2img` models may be used by a deliberate remix profile. They are not eligible
for the ordinary scene default without an explicit owner override, which is not
implemented.

### Reference policy

**Shipped 2026-08-11 (slice 3).** `planIntentReferences` in
`contracts/images/render-intent.ts` reads the whole policy: `allowedRoles`
filters, `roleOrder` and `priority` sort, `maxPerRole` caps, and
`referenceCapacity` truncates. `requiredRoles` is checked against everything that
will be SENT — primary array and dedicated control fields both — so a variant
profile whose identity anchor was trimmed away refuses rather than rendering a
stranger.

The empty policy is a NO-OP by construction, and that is what made the change
payload-neutral: with no allowlist, no `roleOrder`, no priorities and no caps
every comparison ties and the caller's order survives to the capacity trim,
byte-for-byte what the positional slice did. The seeded scene profiles carry
`roleOrder: [identity, location, style, object]`, which is already the order the
scene lane emits.

One coupling the selector cannot fix and therefore reports. A lane that numbers
its references in its own prompt (`buildSceneRenderPrompt` writes "Image 2: the
location") builds that text BEFORE selection runs, so a policy that reorders
would leave the text describing different images than the payload carries. No
lane triggers it — every one supplies references in its profile's `roleOrder` —
and `image_profile.references_reordered` (warn) fires if that stops being true.

A profile's `referencePolicy` has this shape:

```ts
export const imageReferenceRoles = [
  "identity",
  "location",
  "style",
  "object",
  "product",
  "before",
  "after_example",
  "mask",
  "pose",
  "depth",
  "control",
] as const;

export interface ImageReferencePolicy {
  allowedRoles: ImageReferenceRole[];
  requiredRoles: ImageReferenceRole[];
  roleOrder: ImageReferenceRole[];
  maxPerRole?: Partial<Record<ImageReferenceRole, number>>;
}
```

The default scene policy is identity, then location, then style or object. The
default variant and chat-look policy requires identity and allows style. An
example transformation requires before and after-example references.

A reference supplied by a caller carries:

```ts
export interface ImageRenderReference {
  role: ImageReferenceRole;
  buffer: Buffer;
  required?: boolean;
  priority?: number;
  sourceImageId?: string;
  name?: string;
}
```

Required references sort before optional references. Within that partition,
profile role order sorts before numeric priority, then original caller order
breaks ties. An unset `priority` sorts after every set one rather than counting
as zero, so adding a priority to one reference never silently demotes the ones
that never carried one. A role absent from `roleOrder` sorts after every ranked
role. Selection stops at `referenceCapacity(model).max`.

A role the policy REQUIRES is implicitly allowed. A policy naming a role only
under `requiredRoles` would otherwise be unsatisfiable: the reference is dropped
as disallowed, then the required-role gate refuses the render for the absence it
just created.

The selector returns selected and dropped references, and each drop carries WHY:
`role_not_allowed` (the profile is configured for a different job), `role_cap`
(the profile or the bound field asked for fewer of this role), `model_capacity`
(no slot left). Three reasons rather than one bucket because only the last one
changes if the operator picks a bigger model. Drops read out in caller order
whatever order the comparator visited them in.

### Normalized controls

**Shipped 2026-08-05** as `imageRenderControlsSchema` /
`imageControlDefaultsSchema`. Profiles and per-render advanced choices use
normalized names:

```ts
export interface ImageRenderControls {
  seed?: number;
  negativePrompt?: string;
  guidance?: number;
  steps?: number;
  editStrength?: number;
  outputCount?: number;
  coherentSet?: boolean;
  thinkingMode?: boolean;
  resolution?: "1K" | "2K" | "3K" | "4K" | "custom";
  width?: number;
  height?: number;
  lora?: {
    id: string;
    scale?: number;
  };
}
```

`controlDefaults` uses the same shape except that a seed is not normally stored
as a permanent numeric default. Profiles can specify a seed policy of random,
reuse-source, or caller-supplied. The resolved numeric seed is recorded on the
image attempt.

### `image_loras`

Not started — no table, no contract, no route. Slice 6. The design:

An administrator-managed LoRA library:

- `id` — text primary key;
- `label`;
- `locatorType` — `https_url` or `huggingface_repo`;
- `locator` — provider-retrievable URL or repository slug;
- `compatibleModelSlugs` — jsonb string array;
- `compatibleVersionIds` — jsonb string array, empty meaning any reviewed
  version of the compatible slug;
- `defaultScale`;
- `minimumScale` and `maximumScale` for Vesper’s curated range;
- `triggerWords` — jsonb string array;
- `promptPrefix` and `promptSuffix` — nullable;
- `allowedTasks` — jsonb task array;
- `enabled`, `builtin`, `createdAt`, and `updatedAt`.

The locator contains no provider token. `https_url` must parse as HTTPS.
`huggingface_repo` must match a conservative `owner/repository` shape. Private
repository support is out of scope unless Replicate exposes a supported secret
binding that can be kept outside the database.

Direct URLs may include signed query parameters, but logs and diagnostics must
record a redacted locator without its query string. Short-lived signed URLs are
not suitable as durable library entries; use a stable public file or generate a
fresh signed URL from managed storage at render time in a future storage slice.

The initial Qwen Image Edit binding accepts one LoRA locator and one scale. The
normalized contract deliberately represents one LoRA. If a future model exposes
an array, expand the capability and request contract in a separate change rather
than pretending multiple LoRAs are already supported.

A profile that names a LoRA is invalid unless:

- the active model slug and version are compatible;
- the active model exposes both LoRA bindings;
- the profile task is allowed by the LoRA;
- the resolved scale is within the provider binding and the curated LoRA range.

Trigger words and prompt additions are inserted by the prompt strategy before
prompt fitting.

### Image sets

Not started — no tables, no columns, and the provider shell still returns one
image. Slice 8. The multiple-output slice adds:

- `image_sets` with `id`, `ownerId`, `task`, `profileId`, `prompt`, `status`,
  `meta`, `createdAt`, and `updatedAt`;
- nullable `images.imageSetId`;
- nullable `images.imageSetIndex`.

`imageSetIndex` is zero-based and unique within a set. A set is ready when it has
at least one ready child and the provider attempt has settled. Partial provider
or storage failure is recorded on the set without deleting ready siblings.

Ordinary portrait, variant, scene, entity, chat-look, and chat-place calls do not
create an image set.

## Profile resolution

**Shipped 2026-08-05; live on every lane 2026-08-07.** The pure resolver is
`resolveImageProfile` in `src/contracts/images/image-model-profiles.ts`; the
server loader is `resolveImageProfileForTask` in
`src/server/images/model-profiles.ts`. Each of the seven lanes calls it for its
own task before it reserves an image row, so the row's `meta.model` records what
will actually run.

The resolver receives a task and a stored selection. It applies this order:

1. an enabled profile id valid for the task;
2. when the stored value is a model id or slug, that model’s enabled default
   profile for the task;
3. the global enabled default profile for the task;
4. the first enabled eligible profile in sort order;
5. null with `image_profile.none_offered`.

This lets existing `sceneModel` values continue working after profile pickers
land. New storage fields should be named for profiles, but API boundaries accept
legacy model ids until the compatibility period is deliberately removed.

A resolved profile includes the parsed model record. Callers never load the
model and profile independently.

## Normalized render intent

**Shipped 2026-08-07 (slice 2).** All seven lanes emit an intent; the gate on the
identity-pack plan's render-lane slice and the visual-state plan is open.

`compileProfileRenderPlan` in `src/server/images/render-profile.ts` performs
steps 5–11 of the resolution order below and was reused rather than re-invented:
reviewed quality seam, strategy-compiled prompt, model-dialect preparation,
negative resolution, control mapping, override validation, aspect choice, and
version pin. `renderImageIntent` calls it and adds what a trial has no use for —
reference selection against capacity, the required-role gate, and per-request
control overrides. LoRA resolution and image sets remain later slices.

Serializable vocabulary lives in `src/contracts/images/render-intent.ts`; the
buffer-bearing request and the orchestration in
`src/server/images/render-intent.ts`.

```ts
export interface ImageRenderIntent {
  profile: ResolvedImageProfile;
  prompt: string;
  references: ImageRenderReference[];
  target: { aspectRatio: number };
  controls?: ImageRenderControls;
}
```

Three deliberate deviations from the shape this section originally specified:

- **The caller supplies a resolved profile, not a `profileSelection` string.**
  Every lane must know its model before it reserves an image row — the row's
  `meta.model` records it, and a lane with no offered profile fails its
  precondition instead of reserving — so resolving inside the render call would
  mean either a second registry read on the hot path or a lane that reserves
  before it knows what it will run. `task` left with it: the resolved profile
  names its own task, and carrying both would let them disagree.
- **No `quality` tier on the target.** A `"fast" | "balanced" | "quality"` field
  would be a claim about the render that nothing in the payload honors until
  quality profiles and the control transports exist. It joins `target` in slice
  4, where an unset field on every existing caller is a non-breaking addition.
- **The result is `RenderWithModelResult`, not a new `ImageRenderResult`.** The
  renderer's own result already carries the image, the error, the prediction id
  and the executed version. `ResolvedImageAttempt` is the observability slice's
  record and does not exist yet; declaring the field before there is anything to
  put in it would advertise provenance the render does not keep.

The orchestration entry point is:

```ts
renderImageIntent(intent: ImageRenderIntent, sink?: DiagnosticSink): Promise<RenderWithModelResult>
```

The image-set entry point will use the same resolution and provider adapter but
return `Buffer[]` and persist through the image-set pipeline.

### What production deliberately does not take from the compiled plan

The compile step serves a CONTROLLED comparison first, and two of its guarantees
would be behavior changes if production inherited them:

- **The version pin.** A plan carries `versionId` because a trial cell must
  execute one exact version. Production follows the slug's floating latest by
  design, and since trial setup now re-probes the models it will use, a row can
  carry a `probedVersionId` that would silently start pinning every player render
  to whatever version a trial happened to probe. Pinning production is slice 5's
  job, with the smoke test and activation flow that make it safe.
- **The prediction budget.** A plan always carries a numeric `timeoutMs` so a
  cell can hash its own deadline. All 17 seeded profiles store null, so honoring
  the plan's number would replace `REPLICATE_PREDICTION_TIMEOUT_MS` with a
  hardcoded five minutes on every lane. `renderImageIntent` passes the profile's
  own budget when it declares one and otherwise leaves the environment in charge.

### Resolution order

`renderImageIntent` performs:

1. resolve profile and model;
2. validate operation and semantic task eligibility;
3. select references by policy and capacity;
4. fail before provider work when required roles are absent;
5. prepare selected reference images;
6. merge profile defaults and allowed request overrides;
7. validate and resolve a LoRA;
8. build the prompt through the profile strategy;
9. fit the prompt to provider constraints;
10. negotiate output dimensions for operation, profile, and target aspect;
11. map normalized controls to active-version input bindings;
12. transport references;
13. call Replicate with the resolved timeout;
14. normalize all outputs;
15. return the first output for the single-image path or all outputs for the set
    path;
16. record diagnostics and resolved attempt metadata.

## Prompt strategies

`promptStrategy` is not arbitrary code stored in the database. It is an enum
resolved through a code registry.

**Partly built.** `compilePromptForStrategy` in
`src/server/images/render-profile.ts` is that registry, written as an exhaustive
switch rather than a framework because only four arms have an implementation.
An eighth strategy is a compile error there rather than a silent fall-through.

It dispatches on the REFERENCE VOCABULARY first, because two different things
need naming and conflating them would rewrite live renders:

- **`identity_pack`** — the trial's `canonical_identity` / `face_detail` pair,
  whose whole comparison is which one comes first, so the compiled text has to
  say which image is which. `instruction_edit` and `text_to_image_description`
  name references only when two or more need disambiguating;
  `multi_reference_compose` names every reference from one upward.
- **`render_intent`** — the production lanes' general role vocabulary.
  `instruction_edit` and `text_to_image_description` add NOTHING: the lane's own
  builder already named its references (`buildSceneRenderPrompt` writes the
  multi-reference bindings, and Qwen Edit's multi-reference lock is applied by
  `preparePromptForImageModel` on the way out), so a second set of bindings would
  describe the same images twice in two conventions.

`multi_reference_compose` COMPILES on the `render_intent` arm as of slice 3
(2026-08-11). It used to refuse, correctly: its defining semantic is naming each
reference, the vocabulary had no wording for that, and returning the base prompt
would have let a profile claim the composing strategy while sending text
identical to `instruction_edit`. `compileReferenceRolePrompt` in
`src/lib/images/reference-role-prompt.ts` is that wording — a numbered
`Image N:` binding per role in SEND order, from one reference upward. No seeded
profile selects the strategy, so no live render changed; a controlled Qwen recipe
is its first consumer.

The CONTROL roles are why the wording is not a table of nouns. A pose skeleton is
a constraint to obey, not a thing to depict, and a model handed one under
"a pose reference" renders the stick figure. Each structural role therefore gets
imperative follow-this-do-not-draw-it wording, and a closing clause repeats it
once for the whole set whenever any control is present — deliberately redundant,
because that failure is catastrophic rather than subtle and the per-slot line
sits mid-list where position weighting can bury it.

The other four — `text_repair`, `example_transform`, `style_render`,
`coherent_set` — refuse on both arms, because each needs a contract neither
vocabulary carries and compiling one anyway would produce a prompt that is not
the strategy it claims to be.

Initial strategies:

- `text_to_image_description` — portrait, item, and location descriptions;
- `instruction_edit` — direct edit instruction for Qwen Image Edit and similar
  models;
- `multi_reference_compose` — explicitly names the purpose and order of each
  reference;
- `text_repair` — identifies the text region and desired replacement while
  preserving the rest of the image;
- `example_transform` — describes the before image and the after-example as a
  transformation pair;
- `style_render` — applies curated style language and optional LoRA triggers;
- `coherent_set` — describes shared invariants and the requested variation
  across the ordered outputs.

Existing lane-specific prompt builders remain responsible for factual scene and
appearance content. The strategy wraps or restructures that content for the
selected model mode. The first refactor should golden-test prompts so moving
through the shared intent does not silently rewrite current images.

### Prompt fitting

Not started. `fitPromptToModel` does not exist, the probe records no prompt
limits, and the reference-edit paths still use the fixed character budget
inherited from Venice in `src/server/images/prompts.ts`.

The probe should record exact and recommended prompt limits when they can be
derived reliably. Owner overrides may correct them.

Prompt builders should produce named segments:

- mandatory operation instruction;
- identity and age anchors;
- required scene facts;
- wardrobe and exposure facts;
- location and lighting;
- style and quality hints;
- optional atmospheric detail.

`fitPromptToModel` removes or shortens optional segments from the bottom of that
priority list. It does not blindly take the first N characters. If mandatory
segments alone exceed the hard limit, fail with
`image_model.prompt_too_long_required` rather than silently deleting identity or
safety-critical facts.

## Reference preparation and transport

**Control binding shipped 2026-08-11 (slice 9); preparation and concurrency not
started.** `runRegistryImageModel` now writes bound control images to their own
provider fields, on both transports, and charges them against the inline byte
budget before optional references. It still uploads serially and applies no
preparation step, so the two sub-sections below remain the open half of slice 3.

### Control-image binding

A control role reaching the render path is resolved by
`controlReferenceTransport` against the active version's
`additionalImageInputs`, and there are exactly two answers:

- **`dedicated_input`** — the version declares a field for the role. The image is
  written to that field and does NOT consume a primary reference slot, which is
  why binding runs BEFORE capacity selection: computing capacity first would drop
  an image that was never competing. The field's declared arity and `maxItems`
  cap it (`single` is one image whatever `maxItems` claims; an `array` with no
  `maxItems` is bounded only by the profile's `maxPerRole`). Surplus drops as
  `role_cap`.
- **`numbered_reference`** — no declared field, which is EVERY model Vesper runs
  today. The control rides the primary array as an ordinary numbered image and is
  scarce like any other reference. This is the live Stage 1 path: Qwen Image Edit
  2511 takes pose and depth maps exactly this way, which the Stage 0 probes
  confirmed it obeys.

Two bindings are refused rather than honoured literally. One naming the model's
own `referenceField` is read as `numbered_reference` — "pose goes in `image`" is
the numbered array described twice, and writing it as a dedicated field would
overwrite the whole reference list. One naming any `reservedImageInputFields`
entry is dropped with `image_model.control_field_reserved`, the same rule the
`providerOverrides` overlay follows.

An edit-only model may run on a bound control alone: a pose map is an input
image, and requiring an ordinary reference beside it would make the dedicated
path unusable on the models it exists for.

The `edge` reference role was added with this slice. `imageLabControlRole` is now
one-to-one over the three fixture kinds; before it, an edge map was fed under the
generic `control` because the role list had nothing edge-shaped, so a profile
could not require an edge map specifically. `control` remains the catch-all for a
structural map that is none of the three, and `imageLabControlRoles` still
accepts it so archived pre-`edge` experiments stay readable.

### Preparation

Not started. Create `src/server/images/reference-preparation.ts`.

For each selected buffer:

- use sharp with the existing input-pixel ceiling;
- apply EXIF orientation;
- remove metadata;
- flatten alpha only when the target model does not accept alpha-capable formats;
- resize only when a provider limit or profile policy requires it;
- encode to a format supported by the active binding;
- return bytes, media type, extension, dimensions, and source role.

Do not assume every future reference is WebP. The current stored Vesper assets
are WebP, but masks and external control images may not be.

### File transport

Bounded concurrency not started; uploads are still serial. Move upload and
cleanup mechanics behind `transportReplicateReferences(prepared, transport)`.

For file transport, upload with bounded concurrency of three by default. Preserve
reference order in the returned URI list regardless of completion order. If one
upload fails, delete every successful upload best-effort before returning the
failure.

For data-URL transport, apply the byte budget after preparation. Bound control
images are charged FIRST and are never traded away — a control was bound to a
field the version declared, and a render that silently lost its pose map looks
like a success. The identity anchor is never dropped merely to meet the budget;
when it alone exceeds the budget, send it and allow the provider to accept or
refuse, matching current behavior.

References and bound controls upload under one numbering, controls last, and are
split back POSITIONALLY rather than by a buffer lookup — two byte-identical
control images must stay two images.

The diagnostic for trimming includes selected roles and dropped roles but no raw
image bytes or signed URL query strings.

## Control mapping

**Built 2026-08-06 as `src/server/ai/image-control-mapping.ts`; on every lane
since 2026-08-07.** `compileProfileRenderPlan` remains its sole caller and now
runs on every render. It changes no payload today: all 17 seeded profiles store
inert `{}` defaults, and the probe derives no control bindings, so every control
a profile could carry would drop as `no_binding` anyway. Three deviations from
the design below, all deliberate:

- **Out-of-range is a drop, never a clamp.** The design says numeric values are
  clamped only where a profile explicitly allows a bounded range. No such opt-in
  exists, so the mapper refuses the value with an `invalid` reason rather than
  sending something nobody configured under a record that claims otherwise.
- **`seed`, `coherentSet`, and `lora` are explicitly unsupported.** They drop with
  an `unsupported` reason rather than falling through as `no_binding`, keeping
  "this version has no field" distinct from "Vesper does not send this yet".
- **`filterReservedInputFields` was added.** Override validation was not enough:
  a *mapped* control lands on whatever field the probe declared for it, and those
  declarations genuinely collide (a `size` shape input against a
  `resolutionTier` probed as `size`). Filtering there keeps what is recorded
  identical to what is sent.

The mapper consumes normalized controls and the active version's bindings. It
never guesses a field at render time. Alias discovery belongs to the probe —
which does not yet derive any, so every control currently drops as `no_binding`.

Known aliases during probing include:

- guidance: `guidance` or `cfg`;
- steps: `num_inference_steps`;
- edit strength: `strength` or `prompt_strength`;
- output count: `num_outputs` or `max_images`;
- coherent set: `image_set_mode`;
- sequential mode: `sequential_image_generation`;
- thinking mode: `thinking_mode`;
- LoRA: `lora_weights` and `lora_scale`.

The resolved payload merge order is:

1. prompt, references, and dimensions;
2. model-level `extraInput`;
3. mapped profile defaults;
4. mapped per-render controls allowed by the profile;
5. validated profile `providerOverrides`;
6. system-enforced values such as safety mode and output-count behavior required
   by the selected single-image or image-set path.

A later layer wins. `providerOverrides` may only use `knownInputFields`, and an
empty `knownInputFields` fails **closed** — it means the probe recorded nothing,
not that everything is permitted. It may not override prompt, reference fields,
the aspect key, version, safety enforcement, or the single-image path's forced
output count of one; `reservedImageInputFields` in `src/server/ai/replicate.ts`
is the single spelling of that set, shared by the override validator and the
payload overlay.

In the built path the merge is build-then-overlay rather than a six-layer merge:
`buildRegistryModelInput` writes the prompt, references, aspect and `extraInput`,
and the compiled `controlInput` merges over it minus the reserved fields. A
refused key raises `image_model.reserved_field_ignored`.

## Dimension negotiation

Not started. `chooseAspect` still takes only a model and a target ratio, and
`renderWithModel` crops afterwards. Slice 4/7.

Extend the existing `chooseAspect` seam rather than replacing it.

The new resolver receives operation and profile controls in addition to target
ratio. It can choose among:

- an `aspect_ratio` enum;
- a named resolution tier plus aspect ratio;
- an explicit `size` pixel pair;
- custom width and height;
- provider default followed by crop.

Generation and editing may have different valid size options. Store those
constraints in `advancedCapabilities` when known from the provider schema or
reviewed model documentation. This permits a Wan generation profile to use 4K
without making 4K available to its edit profile.

The output is:

```ts
export interface DimensionChoice {
  input: Record<string, string | number>;
  expectedAspect: number | null;
  needsCrop: boolean;
  requestedResolution?: string;
}
```

Cropping remains post-download and never stretches or pads unless a future task
explicitly requests padding.

## Replicate prediction shell

Not started for multi-output. `ReplicateImageResult` still carries one `image`,
there are no `…One` / `…Many` wrappers, and no `outputUrls` helper. The result
did gain `predictionId` and `executedVersionId` (the version the provider says it
actually ran, which a pin states intent for but cannot confirm). The timeout
rules below **are** built.

Refactor `runReplicateImageModel` so its core returns every output URI instead
of the first one.

```ts
export interface ReplicateImageResult {
  ok: boolean;
  images?: Buffer[];
  error?: string;
  predictionId?: string;
}
```

Provide compatibility wrappers:

```ts
runRegistryImageModelOne(...): Promise<SingleImageResult>
runRegistryImageModelMany(...): Promise<MultiImageResult>
```

The single wrapper forces provider output count and coherent-set controls to one
or disabled where the schema exposes them, then returns the first normalized
buffer. Existing lanes use only this wrapper.

`outputUrls(output)` accepts a URI string, URI array, and data-image URI. It
returns all valid entries in provider order. Every URL is subjected to the
existing trusted-host policy before download.

Download concurrency should also be bounded. A failure to download one output in
an image set records the failed index and preserves successfully downloaded
siblings. A single-image run fails if its first output cannot be downloaded.

### Timeouts

**Built.** Resolve timeout in this order:

1. profile `timeoutMs`;
2. `REPLICATE_PREDICTION_TIMEOUT_MS`;
3. current five-minute default.

One resolution drives both the provider `Cancel-After` header and the local poll
deadline. Anything outside a sane 30s–30m band is clamped. Request and
output-download timeouts stay separate and global.

A compiled plan always carries a numeric timeout rather than deferring to the
environment, so a run's budget is a fact the plan can state and hash.

## Version candidate and promotion flow

Not started — none of the three routes exist, and all six built-in models are
still bare official slugs tracking `latest_version` with `probedVersionId` null.
Slice 5. Note the practical cost of leaving it: `pinnedImageModelVersion` returns
null for those rows, so a controlled comparison refuses them as
`version_unpinned` until an admin re-probes each one.

The active model slug should be pinned after this slice. A bare slug may remain
accepted for manually added experimental rows.

Add admin endpoints conceptually equivalent to:

- `POST /api/admin/self/image-models/:id/probe-latest`;
- `POST /api/admin/self/image-models/:id/smoke-test`;
- `POST /api/admin/self/image-models/:id/activate-version`.

`probe-latest` retrieves the latest version without mutating the active row. It
returns the candidate version id, normalized mechanical capabilities, and a
field-level diff from the active capabilities.

The diff must highlight removed or changed fields used by enabled profiles,
including LoRA bindings, reference arity, output format, aspects, size controls,
and numeric ranges.

`smoke-test` runs the candidate version transiently through one selected profile.
It does not change the row. Live smoke tests are explicit, cost-bearing admin
actions and do not run in CI.

`activate-version` rechecks that the candidate still exists, validates every
enabled profile against it, and atomically updates:

- `slug` to `owner/name:version`;
- `probedVersionId`;
- normalized basic capabilities;
- `advancedCapabilities`;
- `updatedAt`.

Activation fails if an enabled profile becomes invalid. The admin may disable or
repair that profile and retry.

A normal re-probe of a pinned row probes only its pinned version and never moves
it to latest.

## Model-specific seeded profiles

Not started. Migration 0100 seeded 17 deliberately plain profiles — one per model
per job its lane already runs, named "… Standard" — because slice 1 had to change
nothing. The curated profiles below are slice 7 and depend on the control
transports of slices 4–6.

Profiles are ordinary database rows and deletable, matching the model registry's
single-source-of-truth ruling.

### Qwen Image 2512

Seed:

- Portrait Fast — fast mode enabled and a lower reviewed step count;
- Portrait Balanced — current behavior;
- Portrait Quality — fast mode disabled or increased steps where supported;
- Portrait Remix — edit operation using the single identity or source reference
  and an exposed edit-strength range.

Seed and negative prompt are allowed on all profiles. Guidance and steps are
admin-tunable within probed ranges. Remix is not eligible for scene defaults.

### Qwen Image Edit 2511

Seed:

- Scene Standard — instruction edit, identity required, location then style or
  object optional;
- Variant Standard — identity required;
- Text Repair — identity or source image required, `text_repair` prompt strategy;
- House Style — style prompt strategy with one curated LoRA.

The LoRA profile is enabled only when the active pinned version exposes both
LoRA bindings. The profile uses a reviewed scale; suggested experiments at 0.6,
0.8, and 1.0 should be separate trial settings, not three permanent UI sliders.

### Seedream 4.5

Seed:

- Scene Multi-Reference 2K;
- Ensemble Scene 2K;
- Location 4K;
- Coherent Scene Set.

The high-resolution and set profiles are opt-in because of cost and latency.
Prompt fitting honors the stored hard and recommended lengths.

### Seedream 5 Lite

Seed:

- Quality Scene 2K;
- Quality Scene 3K;
- Example Transformation;
- Coherent Scene Set.

Any temporary BytePlus or downstream-provider URL option remains disabled in the
normal asset path. A later video integration may add an ephemeral handoff result
type that is never persisted as a durable image URL.

### Stable Diffusion 3.5 Large

Seed:

- Stylized Portrait Balanced;
- Stylized Portrait High Guidance;
- Portrait Remix.

Do not seed scene, variant, or chat-look profiles. The existing 4:5 selection and
3:4 crop remain.

### Wan 2.7 Image Pro

Seed:

- Generate 2K Thinking;
- Generate 4K Thinking;
- Multi-Reference Edit 2K;
- Coherent Image Set.

The edit profile uses `referenceTransport: data_url`. The generation profiles do
not need references and may use provider-supported higher resolutions. Every
profile carries the fixed-moderation operator warning. No profile disables or
claims to bypass moderation.

## Admin UI

Not started. `/settings/image-models` today adds a model by slug, ticks its three
surface toggles, re-probes it, switches its reference transport, and deletes it.
Nothing on the page shows the reviewed ratings, the operator warning, the pinned
version, or profiles — the PATCH route accepts the three reviewed fields, so they
are currently only settable by API call or migration.

Extend `/settings/image-models` rather than creating six separate settings
pages.

A model card shows:

- active pinned version and whether latest differs;
- generate/edit mechanical flags;
- reviewed edit kind and identity-preservation rating;
- reference transport and capacity;
- operator warning;
- nested profiles;
- candidate-version actions;
- measured recent latency once enough samples exist.

Profile editing exposes task, operation, prompt strategy, timeout, reference
policy, curated common controls, optional LoRA, and an advanced JSON override
editor. The advanced editor validates keys and values before save.

Add a LoRA-library section under the same admin area. Arbitrary player-supplied
LoRAs are out of scope.

Normal image pickers show profile labels. When several profiles use the same
model, group them under the model label. A profile warning appears before use but
does not change the model automatically.

## Caller migration

These lettered slices are the migration sequence; the numbered slices in the plan
are the delivery order. Slice A is done, Slice B half done, C–F untouched.

### Slice A: schema and compatibility profiles — done 2026-08-05

Add fields and tables, then seed one behavior-equivalent default profile for
each currently offered model and surface. Do not change callers.

### Slice B: resolver at existing seams — done 2026-08-07

Existing stored model ids and slugs resolve to the equivalent profile. Rather
than wrapping `resolveSurfaceModel`, the lanes were moved onto
`resolveImageProfileForTask` and the model-level resolver was deleted: keeping
both would leave two answers to "which model runs this job".

### Slice C: shared intent behind current functions — done 2026-08-07

Every public lane signature is unchanged; their provider call routes through
`renderImageIntent`. Payloads are identical to the pre-migration path for all six
seeded models — the prompt is the lane's own text (the `render_intent` prompt
arm adds nothing), the control overlay is empty for inert `{}` defaults, the
target ratio is the lane's own, and neither a version pin nor a forced budget is
sent. Reference uploads are still serial; that is slice 3.

### Slice D: profile pickers and storage

Update the portrait, variant, and scene controls to persist profile ids. Keep
server parsing compatible with old model ids. Entity and chat anchor tasks use
their configured global default profiles without adding new player controls.

### Slice E: optional controls and model-specific profiles

Enable controls only after the common adapter is in use. Do not add a control
directly to a lane-specific Replicate call.

### Slice F: image sets

Add multi-output persistence and UI separately. Existing single-image functions
continue to call the one-output wrapper.

## Slice 1 implementation rulings (2026-08-05)

Slice 1 shipped Slice A above plus Slice B's **pure** resolver only: the reviewed
capability fields, `image_model_profiles`, 17 built-in profiles, and
`resolveImageProfile`. No caller was touched and no rendered image changed; the
identity-pack trial harness became the first consumer on 2026-08-06, off the
render path, and the lanes followed with slice 2 on 2026-08-07. The rulings below
were made while writing slice 1; each one is what kept the migration
payload-neutral, and none should be re-litigated without a reason.

- **Resolver step 2 falls back to the stored model's first eligible profile.** When
  the stored value is a model id or slug, resolution prefers that model's own
  `isDefault` profile for the task and otherwise takes its first offered profile in
  sort order. `isDefault` is globally unique per task, so most models carry none;
  without that second half a stored `sceneModel` of Seedream 4.5 would fall through
  to step 3 and render on Qwen Image Edit — a different model for an existing chat,
  which slice 1 forbids. Step 3's global default remains the fallback only when the
  stored value names no offered profile at all.
- **The seeded scene policy has an empty `requiredRoles`.** §"Reference policy"
  describes the default scene policy as identity, then location, then style or
  object; the seeded rows keep that `roleOrder`/`allowedRoles` but require nothing.
  The scene ladder's `generate` rung legitimately runs with zero references, so a
  required `identity` role would make a valid rung unrenderable. Requiring identity
  is a slice-3 decision, taken with role-aware selection.
- **`scene` profiles are seeded with `instruction_edit`, not
  `multi_reference_compose`** — including on Seedream 4.5, Seedream 5 Lite and Wan
  2.7, which genuinely compose. The scene lane still chooses multi-versus-single
  reference mode at render time (`routeSceneAttempts`) and each rung has its own
  prompt builder, so naming the composing strategy on the profile would assert a
  prompt change nothing asked for. Slice 2 threads strategy selection through the
  shared intent; that is where a scene profile's strategy becomes multi-reference.
- **Identity-critical tasks reject rather than warn.** §"Profile task eligibility"
  left this as "reject or visibly warn". `profileEligibility` rejects:
  `identityPreservation: "weak"` yields `identity_too_weak`, `editKind: "img2img"`
  yields `img2img_identity_task`, and either drops the profile from the offered set.
  Nothing regressed, because the two `weak`/`img2img` rows (Qwen Image 2512, Stable
  Diffusion 3.5 Large) are portrait-only and carry no identity-critical profile. The
  owner override for a deliberate remix profile on an identity task is not
  implemented and is not needed until someone wants one.
- **`advancedCapabilities` ships `{}` on every row, and `probedVersionId` null.** The
  probe is unchanged in slice 1, so it derives no control aliases and records no
  version. The contract therefore makes `{}` a valid, inert value — every branch
  optional or defaulted — with each default written as a **thunk**, because zod hands
  a `.default()` value straight through without cloning and one shared `[]` would let
  a future probe's push rewrite every row's allowlist at once. Empty
  `knownInputFields` must be read as **fail-closed** for `providerOverrides`
  validation, never as "no restrictions"; that rejects nothing today only because all
  17 seeded profiles carry `providerOverrides = {}`.
- **`updatedAt` is a column only.** `image_models.updated_at`, and the profile
  table's `created_at`/`updated_at`, exist in the schema but are absent from
  `imageModelSchema` and `imageModelProfileSchema`. Those records cross to the client
  as JSON, and a timestamp forces a date-serialization decision (`Date` versus ISO
  string versus epoch millis) that no consumer needs yet. The admin model card
  (§"Admin UI") is the first surface that will — §"Extensions to `image_models`"
  wants the timestamp "when showing capability and version changes" — so the
  version-promotion slice should make the call.
- **Anchor tasks are seeded on one model each.** `item`, `location` and `chat_place`
  borrowed the portrait surface's model when slice 1 was written, and `chat_look`
  the scene surface's; those four profiles are therefore seeded only on the model
  each lane rendered with — Qwen Image 2512 and Qwen Image Edit 2511 respectively
  — and are their tasks' global defaults. Seeding them across every capable model
  would have made rows eligible for work no picker has ever offered them.

## Slice 2 implementation rulings (2026-08-07)

Slice 2 shipped Slices B and C above: the seven lanes resolve a profile and
render through `renderImageIntent`, and the model-level resolver is gone. The
rulings below are what kept the migration payload-neutral.

- **A model offered on a surface but carrying no profile now degrades to the
  task default.** The pickers still list models by legacy surface
  (`GET /api/image-models?surface=…`), while resolution runs on profiles, so an
  operator-added model with no seeded profile is listed, stored, and then
  resolved past — to the task's default profile on a different model. It is not
  silent: `resolveImageProfileForTask` raises `image_profile.pick_unavailable`
  when the stored pick is not the resolved one. Closing the window is the picker
  slice's job (Slice D), and until it lands the admin flow that adds a model
  should be understood as adding a model no lane will use.
- **The required-role gate is checked against the SELECTED references.** A
  required identity anchor that capacity pushed out is exactly as absent as one
  the lane never had; checking before the trim would let a two-reference model
  render a variant of nobody while claiming its policy was satisfied.
- **A scene reference's role is derived from its scene kind, not stored.**
  `character` maps to `identity`, `location` to `location`, and `layout` to
  `control` — a spatial control image, which is what that role reserves. The
  scene vocabulary keeps its own names because `image_references` rows and the
  Gallery read them.
- **Control overrides merge over profile defaults member by member**, written as
  a plain merge because `mapImageRenderControls` skips any control whose value is
  `undefined` — an absent member and an undefined one are the same thing to it,
  so nothing reaches a payload uninvited. `outputCount` is still excluded from
  the merged set and recorded as a `single_image_path` drop, now whether the
  profile or the request asked for it.
- **A requested numeric seed travels to the mapper and is refused there.** It
  drops as `unsupported` with a record, rather than being filtered out earlier,
  so asking for a seed before slice 4 builds its transport is visible rather than
  silently ineffective.

## Slices 3 and 9 implementation rulings (2026-08-11)

The two slices landed together because they are one decision. Whether a control
map competes for a scarce primary slot depends on whether the version gave it a
field of its own, so ordering references without first binding controls would
select against a capacity that was wrong. `planIntentReferences` is that single
function; `selectIntentReferences` is gone rather than left beside it.

- **The empty policy is a no-op, and that is the payload-neutrality proof.** No
  allowlist, no `roleOrder`, no priorities, no caps means every comparison ties
  and the caller's order reaches the capacity trim unchanged. Every seeded
  profile is either empty or already lists its roles in the order its lane
  emits, so no live render moved.
- **An empty `allowedRoles` means "no allowlist declared", never "nothing
  allowed".** The four seeded `generate` profiles carry `[]`; reading emptiness
  as a ban would refuse every reference the day a lane started sending one. This
  is the opposite of `knownInputFields`, which fails CLOSED — and deliberately
  so: that list is a security boundary over operator-authored overrides, this one
  is a description of a job.
- **A required role is implicitly allowed.** Otherwise a policy naming a role
  only under `requiredRoles` drops the reference, then refuses the render for the
  absence it just created.
- **A per-role cap is applied before capacity.** A cap is the profile's own
  decision and capacity is the model's, so `role_cap` is the more useful answer
  and it does not change if the operator picks a bigger model.
- **The required-role gate now reads everything SENT, not the primary array
  alone.** A control on its own provider field never entered the primary contest;
  checking only the array would refuse a render whose control was sent correctly.
  This extends the slice 2 ruling above rather than replacing it.
- **A reorder is reported, not prevented.** Lanes that number their references in
  their own prompt text build it before selection runs. No lane triggers a
  reorder today, and `image_profile.references_reordered` (warn) is what makes it
  visible if a policy edit ever does, rather than the renders quietly describing
  the wrong images.
- **`multi_reference_compose` binds from ONE reference upward** — the opposite of
  the identity vocabulary's two-reference threshold. There, naming a lone image
  would rewrite live single-reference renders for nothing; here, the only
  profiles selecting the strategy exist to name every reference, and one that
  named nothing at a single image would be `instruction_edit` under a second
  name.
- **A control binding onto the primary reference field is read as the numbered
  array.** "Pose goes in `image`" describes the array twice; honouring it as a
  dedicated field would overwrite the whole reference list with the control map.
- **A bound control satisfies an edit-only model's reference requirement.** A
  pose map is an input image, and demanding an ordinary reference beside it would
  make the dedicated path unusable on the models it exists for.
- **Bound controls are charged against the inline byte budget FIRST.** They were
  bound to a field the version declared; an optional trailing style reference is
  what a byte budget should give up instead. A render that silently lost its pose
  map looks like a success.

## Observability and reproducibility

Not started for ordinary renders. The only place any of this exists is the
identity trial's own attempt record, which carries the resolved controls, drops
included, plus the prediction id and the executed version the provider echoed.

Every completed or failed provider attempt should record, in image metadata or a
normalized attempt record:

- model id, slug, and exact version;
- profile id and task;
- prompt strategy;
- target and requested provider dimensions;
- normalized controls and resolved provider fields, excluding secrets and full
  signed URLs;
- generated or supplied seed;
- selected reference roles, source image ids, and dropped roles;
- reference transport and total prepared bytes;
- prediction id;
- queue, prediction, download, normalization, and total durations when
  available;
- output count;
- failure classification and diagnostics.

“Fast,” “normal,” or “slow” labels are derived from recent successful runs per
profile after a minimum sample count. They are not manually maintained model
facts. The first UI can simply show median and recent range to admins.

A “retry same composition” action reuses the stored profile, prompt, reference
sources where still available, target, normalized controls, and seed. It does not
reuse temporary Replicate file URLs.

## Failure behavior

Emitted today: `image_profile.row_invalid`, `image_profile.none_offered` and
`image_profile.pick_unavailable` from the resolver;
`image_profile.required_reference_missing`,
`image_profile.prompt_strategy_unsupported`, `image_profile.references_trimmed`
and `image_profile.references_reordered` from the render intent;
`image_model.reserved_field_ignored` and `image_model.control_field_reserved`
from the payload builder; `image_model.references_trimmed` from the inline byte
budget; and the mapper's typed drop reasons (`no_binding`, `invalid`,
`unsupported`, `unknown_field`, `reserved`), which are recorded on the plan
rather than pushed as diagnostics.

`image_profile.references_trimmed` carries a `{ role, reason }` pair per omitted
reference rather than a bare role list: "location dropped" reads as a capacity
problem when it may be a profile that never allowed a location at all.

`image_profile.prompt_strategy_unsupported` is not in the list below because the
list predates the strategy dispatch. It is a refusal, warn-level, raised before
any provider work: the profile declares a strategy this render path has no
wording for.

Configuration errors should fail before reserving provider work where the
caller's existing lane semantics permit it, using specific diagnostics:

- `image_profile.invalid_for_model`;
- `image_profile.required_reference_missing`;
- `image_profile.control_unsupported`;
- `image_profile.override_unknown`;
- `image_lora.incompatible`;
- `image_lora.unreachable_configuration`;
- `image_model.prompt_too_long_required`;
- `image_model.version_profile_conflict`.

Provider failures continue through existing classification. Content rejection,
billing, transient, and other failures remain distinct. Wan’s predictable
moderation behavior is a warning, not a new failure class.

Reference or prompt degradation emits diagnostics naming what was dropped. It
must never silently drop a required identity reference or mandatory prompt
segment.

## Security

- All model, profile, LoRA, candidate-version, and smoke-test routes use the
  existing owner-admin guard.
- Provider tokens remain environment secrets.
- LoRA locators contain no credentials.
- Signed URL query strings are redacted in logs and diagnostics.
- Provider-returned output URLs retain the existing HTTPS and host allowlist.
- Profile overrides cannot select a model version or change authorization,
  safety enforcement, reference transport, callback URLs, or output hosts.
- Prompt and control values are bounded at API boundaries through zod.
- Image preparation keeps the existing pixel ceiling and adds a prepared-byte
  ceiling per reference and per request.

## Tests

What exists today, all pure except the last:

- `src/contracts/images/image-model-profiles.test.ts` — profile and control
  schemas, identity-critical task classification, legacy surface mapping,
  eligibility, offering, candidates, and the five-step resolver;
- `src/contracts/images/image-model-capabilities.test.ts` — the advanced
  capability schema including its per-row default isolation, and the two binding
  schemas;
- `src/server/ai/image-control-mapping.test.ts` — control mapping, reserved-field
  filtering, and provider-override validation;
- `src/server/images/render-profile.test.ts` — the version-pin rule, the
  prompt-strategy dispatch, `compileProfileRenderPlan`, prompt-preparation
  idempotency, and the control hash;
- `src/server/images/render-intent.test.ts` — prompt neutrality at one and at
  many references, the four-plus-one refusing strategies, capacity selection and
  its dropped list, the required-role gate (including a role capacity pushed
  out), control merge precedence, and the null prediction budget;
- `src/server/images/model-profiles.int.test.ts` — the seeded profile set, the
  registry's per-row resilience, and the model-deletion cascade, plus the
  assertion that every anchor task still resolves to the model its lane renders
  with today.

The rest of this section is the target coverage for the unbuilt slices.

### Pure contract tests

Cover:

- profile eligibility from mechanical and semantic capabilities;
- legacy model-id resolution to default profiles;
- required and optional reference role ordering (built —
  `contracts/images/render-intent.test.ts`);
- capacity trimming that retains identity first (built — including the empty
  policy behaving as the old positional trim, and each drop reason);
- control-role binding: dedicated field versus numbered reference, a binding onto
  the primary field, arity and `maxItems` ceilings (built);
- normalized control mapping for every seeded model fixture;
- unsupported controls being omitted with the expected diagnostic;
- dimension selection for generate versus edit profiles;
- prompt-segment fitting;
- LoRA compatibility, locator validation, and scale intersections;
- candidate capability diffs;
- output normalization from string, array, and data URI forms.

### Probe fixtures

Keep recorded OpenAPI fixtures for every pinned built-in version. Test:

- basic normalized fields;
- exact probed version id;
- aliases for guidance, steps, strength, output count, sets, thinking, and LoRA;
- multiple URI-like inputs without mistaking mask or control fields for the
  primary generic reference;
- numeric ranges and enums;
- output arity;
- prompt limits when described in a parseable form;
- conservative omission when prose cannot be parsed reliably.

The probe never invents a capability merely because a familiar field name is
absent.

### Provider adapter tests

Cover:

- bounded upload concurrency while preserving order;
- cleanup after partial upload failure;
- Wan data-URL budget and required-anchor behavior;
- payload merge precedence;
- safety enforcement winning over overrides;
- one-output wrapper disabling sets and forcing one output;
- many-output wrapper retaining order;
- identical timeout in `Cancel-After` and polling;
- trusted-host validation for every returned URL.

### Integration tests

Cover:

- admin CRUD and authz for profiles and LoRAs;
- migration seeds;
- profile defaults and uniqueness;
- model deletion cascading profiles while existing stored selections degrade;
- candidate activation being atomic;
- activation refusal when an enabled profile loses a required binding;
- scene, variant, portrait, entity, chat-look, and chat-place paths resolving the
  expected profile;
- image-set parent and ordered child persistence;
- retry metadata sufficient to reconstruct an attempt.

### Live trials

Live Replicate smoke tests are explicit, owner-triggered, and excluded from CI.
Record cost, duration, active version, payload summary, output dimensions,
identity result, and moderation result in `docs/developer-notes/images/`.

Required first trials:

- Qwen Image Edit standard versus one house-style LoRA at reviewed scales;
- Qwen 2512 fast versus quality portrait profiles;
- Seedream 4.5 ensemble references and 4K location;
- Seedream 5 Lite 3K and example transformation;
- Wan generate versus edit profiles and coherent set;
- Stable Diffusion portrait settings and crop.

## Documentation updates during implementation

Update each file under `docs/image-models/` with:

- pinned version;
- probed mechanical bindings;
- reviewed edit kind and identity rating;
- seeded profiles;
- live-trial observations;
- known moderation, latency, transport, and shape limitations;
- compatible curated LoRAs where applicable.

The per-model files remain provider and trial references. The database remains
the runtime source of truth.

## Completion definition

This plan is complete when all ordinary image lanes run through the normalized
intent and profile resolver, the current six models have reviewed profiles,
production versions can be promoted safely, one curated Qwen Image Edit LoRA is
usable, seeds and resolved settings are recorded, and the separate image-set
workflow retains multiple ordered outputs.

Masks, pose, depth, ControlNet-style bindings, per-character LoRA training, and
video generation remain follow-up work even though the contracts reserve space
for them.
