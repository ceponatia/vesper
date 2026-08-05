# Image model capabilities — technical spec

Technical companion to
[image-model-capabilities.plan.md](image-model-capabilities.plan.md).

Related shipped foundation:
[image-model-registry.plan.md](image-model-registry.plan.md) and
[image-model-registry.spec.md](image-model-registry.spec.md).

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

## Current anchors

The current implementation is spread across these seams:

- `src/contracts/images/image-models.ts` — model record, surface filtering,
  reference capacity, and aspect selection;
- `src/server/ai/replicate-probe.ts` — save-time OpenAPI probe;
- `src/server/ai/replicate.ts` — input construction, reference transport,
  prediction polling, output download, and file cleanup;
- `src/server/ai/image-providers.ts` — scene attempt ordering and capability
  checks;
- `src/server/images/models.ts` — registry resolution, shape negotiation, and
  crop normalization;
- `src/server/images/scene.ts` — scene degradation ladder and the current
  three-reference buffer cap;
- `src/server/images/variants.ts`, `entity.ts`, `chat-look.ts`, and the portrait
  lane — individual callers that should eventually emit the shared render
  intent.

The current registry fields remain useful. In particular,
`referenceField`, `referenceArity`, `referenceTransport`, `maxReferences`,
`aspectMode`, `supportedAspects`, `outputFormat`, and `extraInput` continue to
serve the basic request path.

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

Add the following fields to the existing table:

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

The reviewed fields are never overwritten by a normal re-probe. A candidate
version flow may copy them forward but must not silently improve or downgrade a
quality judgment.

`advancedCapabilities` is version-specific provider data. It is replaced
atomically when the active version changes.

### Advanced capability contract

The contract should use a zod schema exported from
`src/contracts/images/image-model-capabilities.ts`.

A representative shape is:

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
references. `additionalImageInputs` is reserved for masks, pose, depth, control,
or any future model that exposes more than one image-like input.

`knownInputFields` supports validation of low-level profile overrides. It is not
used to construct a payload by itself.

### `image_model_profiles`

Add a profile table with:

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

Only one enabled profile may be the global default for a task. Enforce this with
a transaction and, where supported cleanly by the migration conventions, a
partial unique index.

### Profile task eligibility

A profile with `operation: generate` requires `model.canGenerate`.

A profile with `operation: edit` requires `model.canEdit` and a non-`none`
`editKind`.

Identity-critical tasks such as `variant`, `scene`, and `chat_look` should reject
or visibly warn on `identityPreservation: weak`. They must not automatically
enable a model merely because `canEdit` is true.

`img2img` models may be used by a deliberate remix profile. They are not eligible
for the ordinary scene default without an explicit owner override.

### Reference policy

A profile’s `referencePolicy` has this shape:

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
breaks ties. Selection stops at `referenceCapacity(model).max`.

The selector returns both selected and dropped references so diagnostics can say
which roles were omitted.

### Normalized controls

Profiles and per-render advanced choices use normalized names:

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

Add an administrator-managed LoRA library:

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

The multiple-output slice adds:

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

Add a pure resolver in `src/contracts/images/image-model-profiles.ts` and a
server loader in `src/server/images/model-profiles.ts`.

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

Create `src/contracts/images/render-intent.ts` for serializable types and
`src/server/images/render-intent.ts` for the buffer-bearing server type.

```ts
export interface ImageRenderIntent {
  task: ImageProfileTask;
  prompt: string;
  references: ImageRenderReference[];
  target: {
    aspectRatio: number;
    quality: "fast" | "balanced" | "quality";
  };
  controls?: ImageRenderControls;
  profileSelection?: string | null;
}
```

The orchestration entry point is:

```ts
renderImageIntent(
  intent: ImageRenderIntent,
  sink?: DiagnosticSink,
): Promise<ImageRenderResult>
```

A single-image result is:

```ts
export interface ImageRenderResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  attempt?: ResolvedImageAttempt;
}
```

The image-set entry point uses the same resolution and provider adapter but
returns `Buffer[]` and persists through the image-set pipeline.

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

The probe records exact and recommended prompt limits when they can be derived
reliably. Owner overrides may correct them.

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

### Preparation

Create `src/server/images/reference-preparation.ts`.

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

Move upload and cleanup mechanics behind
`transportReplicateReferences(prepared, transport)`.

For file transport, upload with bounded concurrency of three by default. Preserve
reference order in the returned URI list regardless of completion order. If one
upload fails, delete every successful upload best-effort before returning the
failure.

For data-URL transport, apply the byte budget after preparation. Required
references are considered first. The identity anchor is never dropped merely to
meet the budget; when it alone exceeds the budget, send it and allow the
provider to accept or refuse, matching current behavior.

The diagnostic for trimming includes selected roles and dropped roles but no raw
image bytes or signed URL query strings.

## Control mapping

Create `src/server/ai/image-control-mapping.ts`.

The mapper consumes normalized controls and the active version’s bindings. It
never guesses a field at render time. Alias discovery belongs to the probe.

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

A later layer wins. `providerOverrides` may only use `knownInputFields`. It may
not override prompt, reference fields, version, safety enforcement, or the
single-image path’s forced output count of one.

Numeric values are clamped only when the profile explicitly allows a bounded
range. Otherwise an out-of-range configuration is rejected at save time rather
than silently changed.

## Dimension negotiation

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

Resolve timeout in this order:

1. profile `timeoutMs`;
2. `REPLICATE_PREDICTION_TIMEOUT_MS`;
3. current five-minute default.

Apply the same resolved value to the provider `Cancel-After` header and the local
poll deadline. Keep request and output-download timeouts separate and global.

Record the resolved timeout in attempt metadata.

## Version candidate and promotion flow

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

Profiles are ordinary database rows and deletable, matching the model registry’s
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

### Slice A: schema and compatibility profiles

Add fields and tables, then seed one behavior-equivalent default profile for
each currently offered model and surface. Do not change callers.

### Slice B: resolver at existing seams

Change `resolveSurfaceModel` into or wrap it with `resolveImageProfile`. Existing
stored model ids and slugs resolve to the equivalent profile. Continue returning
the embedded model to old callers temporarily.

### Slice C: shared intent behind current functions

Keep public lane function signatures stable while their provider call is routed
through `renderImageIntent`. Golden-test prompt and reference ordering. The first
commit in this slice should produce the same payloads as current main for all six
seeded models except for intentionally parallelized uploads and added metadata.

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

## Observability and reproducibility

Every completed or failed provider attempt records, in image metadata or a
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

Configuration errors fail before reserving provider work where the caller’s
existing lane semantics permit it. They use specific diagnostics:

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

### Pure contract tests

Cover:

- profile eligibility from mechanical and semantic capabilities;
- legacy model-id resolution to default profiles;
- required and optional reference role ordering;
- capacity trimming that retains identity first;
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
