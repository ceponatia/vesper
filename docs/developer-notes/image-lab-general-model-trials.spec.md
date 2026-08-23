# Image Generator — technical spec

Status: companion to [image-lab-general-model-trials.plan.md](image-lab-general-model-trials.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

Owner ruling (2026-08-23): the earlier revision of this spec designed a neutral
`model_trial` experiment inside the Advanced Image Lab. That direction is
superseded. Raw prompt/model testing is a separate admin **Image Generator**
surface; no Image Lab experiment kind is added, and no Image Lab evidence rule
is weakened. This rewrite is the implementation authority for the plan.

## Scope

This spec governs: the Image Generator admin surface (contracts, run record,
API, job, runner, UI), the capability-probe extensions it depends on
(`additionalImageInputs` derivation and provider-input descriptors in
`@vesper/image-replicate` / `@vesper/image-core`), the reusable owner-scoped
image picker, and the Image Lab affordance corrections the plan folds into this
work. It deliberately leaves alone: every Image Lab experiment contract,
runner, verdict, and fixture rule; production image lanes and profiles; the
model registry's ownership of registration/probing/version promotion; quota,
job, and provider-health policy beyond adding one job type and one hidden
asset kind.

## Implementation status

| Slice                                                        | State            |
| ------------------------------------------------------------ | ---------------- |
| 1. Capability contracts + Replicate probe derivation          | built 2026-08-23 |
| 2. Generator run record, API, job, runner (server)            | built 2026-08-23 |
| 3. Generator UI (page, form, history, inspector, duplicate)   | built 2026-08-23 |
| 4. General owned-image picker + sources endpoint              | built 2026-08-23 |
| 5. Image Lab affordance cleanup (model/mode/fixture copy)     | built 2026-08-23 |
| 6. General picker reuse in Lab (object/location/extraction)   | built 2026-08-23 |
| 7. Stage 3 validation runs (SDXL, Qwen, prompt-only)          | not started — needs a deploy plus owner-approved provider spend, and the SDXL re-probe below |

Not built by design: direct source uploads (awaiting the plan's retention/quota
ruling), a side-by-side A/B view (the detail inspector plus duplicate lineage
covers the first implementation), and multi-output runs.

### Rulings the build settled (2026-08-23)

- The synthetic Generator profile carries the nominal task `item` —
  deliberately non-identity-critical so identity screening cannot block raw
  testing. Consequence: a curated LoRA must list `item` in its `allowedTasks`
  to run in the Generator.
- `image_generator.run_threw` exists outside the contract enum, mirroring the
  Lab's `LAB_RUN_THREW` rationale: a crash is not a vocabulary the runner
  chooses from.
- `seedPolicy` dropped-control entries are exempt from the dropped-control
  refusal — they are the synthetic profile's own scaffolding on every unseeded
  run and can never mask an admin's explicit choice.
- The purpose select in the form offers the eight content roles only; the
  contract accepts the whole role vocabulary, and a stored non-content purpose
  is dropped from a duplicate's prefill rather than remapped.
- `edge_image`/`canny_image` joined the probe's deprioritized reference-field
  fallback list as a consequence of deriving that list from the dedicated-input
  alias table — intended anti-drift coupling.
- Create-time unknown `modelId` refuses with the bare `model_missing` code
  (there is no row to snapshot a slug from); a missing `sourceRunId` degrades
  to null lineage with an info diagnostic instead of failing the create.
- After the probe change ships, the Vesper SDXL renderer needs a **re-probe**
  so its pinned capability record gains the `depth_image`/`pose_image`
  dedicated bindings and the `recipe` descriptor (admin re-probe action; the
  write is atomic beside `probedVersionId`).
- The transport's inline byte budget can trim tail primaries after the plan
  settled (shared transport behavior, unrefusable pre-spend); a succeeded run
  that sent fewer primaries than planned records `meta.trimmedPrimaries` with
  a warn diagnostic so a later comparison cannot mistake it for a full send.
- The form withholds Width/Height until the shared custom-resolution path
  (`resolution: "custom"` + dimension bindings) works end to end — the compile
  honors explicit dimensions only under that mode, so offering the fields
  today would sell a guaranteed pre-spend refusal. The resolution tier select
  remains where bound; the contract keeps `width`/`height` for API callers.

## Contracts

### Provider-input descriptors (`@vesper/image-core`)

`packages/image-core/src/capabilities/image-model-capabilities.ts` gains:

```ts
export const imageProviderInputTypes =
  ["string", "integer", "number", "boolean", "enum", "uri", "array", "unknown"] as const;

export const imageProviderInputDescriptorSchema = z.object({
  field: z.string().min(1),
  type: z.enum(imageProviderInputTypes),
  required: z.boolean(),
  default: z.unknown().optional(),          // JSON-safe provider default, when declared
  enumValues: z.array(z.string()).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  description: z.string().max(500).optional(),
  reserved: z.boolean(),                    // claimed by prompt/reference/aspect/control/dedicated/extraInput/render plumbing
});
```

This is a **separate type vocabulary** from `imageInputBindingTypes` — widening
the binding enum would change what `bindingAccepts` must exhaustively handle.
Descriptors are metadata about what the provider version declares, not a second
normalized-control system; nothing maps them into `ImageRenderControls`.

`imageModelAdvancedCapabilitiesSchema` gains
`providerInputs: z.array(imageProviderInputDescriptorSchema).default(() => [])`
(thunk default, like every other collection there). `{}` and every existing row
still parse. `emptyImageModelAdvancedCapabilities()` stays consistent.

`diffImageModelCapabilities` gains a `providerInputs.<field>` section in the
deterministic entry order, after `additionalImageInputs.*` and before `output`.

New barrel exports from `packages/image-core/src/index.ts`:
`ImageAdditionalImageInput`, `ImageUriBinding`, `ImageBindingArity`,
`imageUriBindingSchema`, `imageAdditionalImageInputSchema`,
`imageControlReferenceRoles`, `isImageControlReferenceRole`,
`imageProviderInputTypes`, `imageProviderInputDescriptorSchema`,
`ImageProviderInputDescriptor`.

### Neutral primary-reference role

`imageReferenceRoles` gains one member: `"reference"` — an ordinary content
reference carrying no semantic claim. It is **not** added to
`imageControlReferenceRoles`. Generator primary references always enter the
render planner with role `reference`; the optional owner-selected `purpose` is
recorded provenance/UI metadata only and never changes routing. Compile-error
ripple (exhaustive role switches such as `imageLabRoleLabel`) gets a label arm
in the same change.

### Generator run contracts (`apps/web/src/contracts/images/image-generator.ts`)

Pure module (no IO), importable by schema, server, and components.

```ts
export const imageGeneratorRunStatuses = ["pending", "running", "succeeded", "failed"] as const;

export const IMAGE_GENERATOR_MAX_PRIMARY = 6;   // conservative app cap; the UI states it
export const IMAGE_GENERATOR_PROMPT_MAX = 10_000;

export const imageGeneratorPrimaryInputSchema = z.object({
  imageId: z.string().min(1),
  purpose: imageReferenceRoleSchema.optional(),   // metadata only
});
export const imageGeneratorDedicatedInputSchema = z.object({
  role: z.enum(imageControlReferenceRoles),        // pose | depth | edge | mask | control
  imageId: z.string().min(1),
});
export const imageGeneratorRunInputsSchema = z.object({
  primary: z.array(imageGeneratorPrimaryInputSchema).max(IMAGE_GENERATOR_MAX_PRIMARY).default(() => []),
  dedicated: z.array(imageGeneratorDedicatedInputSchema).max(8).default(() => []),
});

export const imageGeneratorProviderInputValueSchema =
  z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

export const imageGeneratorCreateRunRequestSchema = z.object({
  modelId: z.string().min(1),
  prompt: z.string().trim().min(1).max(IMAGE_GENERATOR_PROMPT_MAX),
  inputs: imageGeneratorRunInputsSchema.optional(),
  controls: imageRenderControlsSchema.optional(),
  providerInputs: z.record(z.string().min(1), imageGeneratorProviderInputValueSchema).optional(),
  sourceRunId: z.string().min(1).optional(),      // duplicate/variant lineage
});
```

Create-time rules enforce only client-bug contradictions: at most one dedicated
input per role; `providerInputs` capped at 32 keys. Runtime facts (model
existence, version pin, capability bindings, capacity, readable inputs) are
runner checks so the failed attempt lands on the run row.

Failure vocabulary, mirroring the Lab's pattern:

```ts
export const imageGeneratorFailureCodes = [
  "model_missing",          // slug no longer resolves in the registry
  "version_unpinned",       // no exact provider version resolvable before spend
  "operation_unsupported",  // prompt-only on a model that cannot generate, etc.
  "input_missing",          // a selected image id is unreadable or its bytes are gone
  "capacity_exceeded",      // explicit primary references exceed model/app capacity
  "dedicated_input_unbound",// structural role with no active capability binding
  "control_refused",        // an explicitly selected normalized control cannot be represented
  "provider_input_rejected",// unknown/reserved/invalid advanced provider value
  "render_failed",          // provider execution failed
  "output_store_failed",    // provider succeeded, local persistence failed
] as const;
export function imageGeneratorDiagnosticCode(code) { return `image_generator.${code}`; }
```

`image_profile.*` and `image_lora.*` codes land verbatim when the shared
planner/LoRA layers own the refusal. `failure_code` stays a plain text column
for the same reason the Lab's does.

Wire shape (`imageGeneratorRunSchema`): id, status, modelSlug,
requestedVersionId, executedVersionId, prompt, finalPrompt, inputs, controls,
providerInputs, sourceRunId, resultImageId, failureCode, error?, predictionId,
createdAt/startedAt/finishedAt, plus a parsed `meta.attempt`
(`ResolvedImageAttempt`) when present.

### Client API

`apps/web/src/lib/client/api.ts` gains `imageGeneratorApi.runs.{list, create,
detail, remove}` rooted at `/api/admin/self/image-generator` and
`ownedImagesApi.list` for the picker endpoint below.

## Ownership rules

- The **registry** stays the only model list. The Generator selects a
  registered row by id at create, snapshots `model_slug`, and re-resolves
  owner-independently at run time. `advancedCapabilities` remains probe-owned.
- **`@vesper/image-replicate`** stays the only place provider field names are
  discovered. Generator application code never constructs a Replicate field
  name; dedicated slots come from `additionalImageInputs`, advanced inputs from
  `providerInputs` descriptors, controls from probed bindings.
- The Generator **must not import** `image-lab-render.ts`, any Lab runner, or
  `packages/image-core/src/lab/*`. It reaches the provider only through
  `renderImageIntent` (behind its own injectable seam).
- The shared owner-scoped byte readers `readOwnedImageBytes` /
  `readOrderedInputBytes` move from `image-lab-render.ts` to a neutral module
  (`apps/web/src/server/images/owned-image-reads.ts`, re-exported from the
  images barrel); the Lab re-imports them. They are generic owner-scoped reads
  with coherent meaning outside both surfaces.
- One run id identifies one immutable attempt. Variants create new rows via
  `sourceRunId`; nothing mutates or reruns a settled row.
- The admin-authored prompt is the whole positive prompt. The only permitted
  transformations are the ones every registered-model render already applies at
  the shared boundary (`preparePromptForImageModel`), and the recorded
  `final_prompt` is the post-transform text.
- Generator outputs are hidden internal assets (`generator_output`), excluded
  from Gallery/portrait/public surfaces and the storage-quota sum exactly as
  the existing `HIDDEN_IMAGE_KINDS` are. Backpressure and the
  `provider_image_day` budget still apply.
- `startJob` is called from the route, never from `server/images` (import-cycle
  rule); a refused job slot deletes the just-created run row.

## Algorithms

### Probe: dedicated image inputs (`packages/image-replicate/src/probe.ts`)

Module-level alias table; `DEPRIORITIZED_REFERENCE_FIELDS` derives from its
keys so the two cannot drift:

```ts
const DEDICATED_IMAGE_INPUT_ALIASES: Record<string, ImageReferenceRole> = {
  depth_image: "depth", pose_image: "pose",
  mask: "mask", mask_image: "mask",
  control_image: "control",
  edge_image: "edge", canny_image: "edge",
};
```

`deriveAdvancedCapabilities(properties, schemas, required, referenceField)`
(signature widened; call site moves below `findReferenceField`):

1. Controls and `knownInputFields` derive exactly as today.
2. `additionalImageInputs`: for each property name in the alias table, sorted
   by field name for determinism, that is URI-typed per `referenceArityOf` and
   is **not** the primary `referenceField`: emit
   `{ roleHint: alias, binding: { field, arity, required: required.includes(field), maxItems? } }`.
   Unknown URI fields are never classified heuristically — no alias, no entry.
3. `providerInputs`: one descriptor per declared property, sorted by field
   name. `type` from the parsed schema (`uri` for URI-typed, `array` for
   non-URI arrays, `unknown` when unparseable); `required` from `required[]`;
   `default`/`minimum`/`maximum`/`description` (trimmed, capped 500) when
   declared; `enumValues` via a filtering reader (inline `enum` or `$ref`,
   string members only — descriptive, unlike the strict binding reader).
   `reserved: true` when the field is the prompt, the primary reference field,
   the aspect input (`size`/`aspect_ratio` per detected mode), `version`,
   `disable_safety_checker`, a control-bound field, a dedicated-input field, or
   an `extraInput` key.

Re-probe of an unchanged schema must produce an identical record (stable
ordering) so version diffs stay empty. After this lands, the Vesper SDXL
renderer must be re-probed so its pinned record carries `depth_image` /
`pose_image` bindings and the `recipe` descriptor (Stage 3/owner action —
re-probe writes are atomic beside `probedVersionId`).

Known consequence to preserve: `missingRequiredControlInputs` refuses pre-spend
when a version declares a **required** dedicated input; SDXL's are all
optional. Qwen Image Edit 2511 declares no second URI field, so it stays on the
numbered-primary path with zero `additionalImageInputs` — pinned by test.

### Generator runner (`apps/web/src/server/images/image-generator-run.ts`)

1. Load the run row owner-scoped; parse `inputs`/`controls`/`providerInputs`
   with `parseOr` against the contracts.
2. Resolve the stored slug through `loadImageModels` (exact slug match);
   missing → `model_missing`.
3. Pin: `pinnedImageModelVersion(model)`; null → `version_unpinned`. Persist
   `requested_version_id` before spend.
4. Operation: references present → `edit`; none → `generate`. `generate` on a
   model with `canGenerate === false` → `operation_unsupported`; `edit` with
   `canEdit === false` → `operation_unsupported`.
5. Read every referenced image owner-scoped; any unreadable → `input_missing`
   (never substitute).
6. Capacity: primary count must fit
   `min(referenceCapacity(model).max, IMAGE_GENERATOR_MAX_PRIMARY)` →
   `capacity_exceeded`; never trim explicit inputs.
7. Dedicated inputs: every requested role must resolve to
   `controlReferenceTransport(model, role).kind === "dedicated_input"` →
   otherwise `dedicated_input_unbound`. No fallback to numbered references for
   an explicitly dedicated selection.
7b. Advanced provider values gate, pre-spend (`provider_input_rejected`): a
   `providerInputs` key colliding with the model's LoRA-binding fields (the
   curated library is the only path to them), a dedicated image-input field, or
   a reviewed `extraInput` pin refuses on every capability record; when the
   record carries provider-input descriptors, a `reserved` descriptor or a
   provable type/enum/range violation also refuses. Records probed before
   descriptors existed skip the descriptor layers; unknown fields remain
   `validateProviderOverrides`' refusal.
8. Build the synthetic Generator profile (below) and the `ImageRenderIntent`:
   whole prompt; primary references with role `reference` in caller order;
   dedicated inputs with their structural roles; explicit `controls`;
   `versionId` = the pin. `providerInputs` travel as the synthetic profile's
   `providerOverrides` so `validateProviderOverrides` (known/reserved,
   fail-closed on empty `knownInputFields`) applies unchanged.
9. Resolve LoRA first when `controls.lora` is set (pre-spend refusal on
   failure), then `planImageRender` with current runtime facts. Persist
   `final_prompt` and the plan outcome **before** spend. Any dropped control,
   dropped reference, or planner refusal is a pre-spend refusal —
   `control_refused` / `provider_input_rejected` / `capacity_exceeded` /
   verbatim `image_profile.*` — never a silent trim.
10. Render through the injectable seam (default `renderImageIntent` with the
    intent carrying the pin). Store the output via `createImageAsset` with
    `kind: "generator_output"`, `meta: { hidden: true, imageGeneratorRunId }`,
    `prompt: finalPrompt`. Settle `succeeded` with `result_image_id`,
    `prediction_id`, `executed_version_id`, and `meta.attempt`.
11. Failures settle on the row: provider failure → `render_failed` plus the
    render classifier's code in `error`, provider health via
    `imageFailureHealthOutcome`; storage failure after a successful provider
    response → `output_store_failed` with `providerOutcome: true`. Pre-spend
    refusals report `providerOutcome: null`. The route passes
    `providerOutcome` to `startJob`'s `reportProviderOutcome`, mirroring the
    Lab.

### Synthetic Generator profile

An in-memory `ImageModelProfile`-shaped object built per run (never a DB row):
pass-through prompt strategy (`instruction_edit` for edit,
`text_to_image_description` for generate — both leave the base prompt
unchanged), an open reference policy (`allowedRoles: []`, `requiredRoles: []`,
`roleOrder: []`, no identity strategy), `controlDefaults` with
`seedPolicy: "caller"` and nothing else, `providerOverrides` = the run's
advanced values, and the existing trial fallback timeout. `profileEligibility`
runs against it like any other profile. This keeps `compileProfileRenderPlan`
as the only control mapper and `reservedImageInputFields` as the only reserved
list, with zero production-profile resolution.

### Duplicate / variant

Client-side prefill from a settled run's detail: model (when still registered),
prompt, ordered primary inputs with purposes, dedicated inputs, controls
(including explicit seed), provider inputs, and `sourceRunId` = the original.
The POST creates a new run; the original row and output stay immutable. When
the original's `requested_version_id` no longer matches the current pin, the
form surfaces that fact before submit rather than silently running different
weights.

### Owned-image sources endpoint

`GET /api/admin/self/owned-images` (`withOwnerAdmin`): owner-scoped `ready`
images filtered to the source-policy allowlist — every kind except
`identity_face_crop` and `identity_trial_output` (system bookkeeping). Query
params: optional `kinds` (subset of the allowlist), `limit` (default 60, max
200), `before` cursor on `createdAt`. Returns id, kind, createdAt, prompt
snippet, entity/chat linkage for display labels. The general picker component
(`apps/web/src/components/settings/owned-image-picker.tsx`) renders it with
kind filter tabs and is the shared source for Generator inputs and the Lab's
already-permitted generic roles.

## Persistence

New table `image_generator_runs` (`apps/web/src/server/db/schema.ts`, then
`pnpm db:generate` → review → `pnpm db:migrate`; expected as a clean CREATE
TABLE with no interactive prompt — if Drizzle asks a create-vs-rename question,
stop and hand it to the owner):

| Column                 | Shape                                                      |
| ---------------------- | ---------------------------------------------------------- |
| `id`                   | text pk `$defaultFn(newId)`                                |
| `owner_id`             | text notNull FK `users.id` CASCADE                         |
| `status`               | text enum `imageGeneratorRunStatuses` default `pending`    |
| `model_slug`           | text notNull (snapshot)                                    |
| `requested_version_id` | text (set pre-spend by the runner)                         |
| `executed_version_id`  | text (provider echo)                                       |
| `prompt`               | text notNull                                               |
| `final_prompt`         | text                                                       |
| `inputs`               | jsonb default `{}` (`imageGeneratorRunInputsSchema`)       |
| `controls`             | jsonb default `{}` (`imageRenderControlsSchema`)           |
| `provider_inputs`      | jsonb default `{}`                                         |
| `result_image_id`      | text FK `images.id` SET NULL                               |
| `failure_code`         | text (generator codes + shared layer codes, two vocabularies) |
| `error`                | text (truncated provider/classifier detail)                |
| `prediction_id`        | text                                                       |
| `source_run_id`        | text FK self SET NULL                                      |
| `meta`                 | jsonb default `{}` (`{ attempt?, providerOutcome? … }`)    |
| `created_at` / `started_at` / `finished_at` | tz timestamps                         |

Index: `image_generator_runs_owner_created_idx (owner_id, created_at)`.
FK policy follows the evidence-table ruling: owner CASCADEs, pointers SET NULL,
snapshots (slug, version) carry no FK.

Job type: `generator_image` appended to the `jobs.type` enum (TS refinement,
no migration) with `providerLaneFor` → `"image"`.

Asset kind: `generator_output` appended to `images.kind` and to
`HIDDEN_IMAGE_KINDS`; routes pass `outputKind: "generator_output"` to
`imageRenderRejection`. Deleting a run deletes its output via
`deleteOwnedImage(resultImageId, ownerId, { kind: "generator_output" })`.
Never persisted: credentials, signed upload URLs, resolved LoRA locators
(curated library id is authoritative).

### API routes

| Route                                             | Wrapper                  | Methods |
| ------------------------------------------------- | ------------------------ | ------- |
| `/api/admin/self/image-generator/runs`            | `withOwnerAdmin`         | GET list, POST create+queue (201) |
| `/api/admin/self/image-generator/runs/[runId]`    | `withOwnerAdminResource` | GET detail, DELETE |
| `/api/admin/self/owned-images`                    | `withOwnerAdmin`         | GET |

POST order: `readBody` → `imageRenderRejection(user, req, { outputKind:
"generator_output" })` → create pending row (service) → `startJob({ type:
"generator_image", … })` from the route → on cap refusal delete the row and
return `jobCapRejection`. CSRF/origin comes from the wrapper; no per-route
code.

## Resilience

- jsonb boundaries split by consumer: wire/read-back parses degrade per-field
  to empty defaults with `parse.boundary_failed`, while the **runner** parses
  fail closed (`parseOrNull` → a stable refusal code) — an empty-because-failed
  inputs bag must never run as "nothing selected".
- The Generator fails **closed before spend**: every §13 plan case maps to a
  stable `image_generator.*` code or a verbatim shared-layer code, settled on
  the row with diagnostics, never a thrown 500 and never a fallback model.
- Provider failure vs local persistence failure stay distinct
  (`render_failed` vs `output_store_failed`) so provider health is never
  charged for a local disk problem.
- Optional display metadata (entity labels in the picker) degrades to the bare
  image id without blocking a run.
- Degradation tests assert fallback **and** diagnostic code.

## Code organization

| Module | Owns |
| --- | --- |
| `apps/web/src/contracts/images/image-generator.ts` | statuses, input/request/wire schemas, failure codes, caps |
| `apps/web/src/server/images/image-generator-store.ts` | row↔wire, create/list/detail/delete/settle |
| `apps/web/src/server/images/image-generator-run.ts` | runner algorithm, synthetic profile, refusals |
| `apps/web/src/server/images/image-generator-render.ts` | injectable render seam (default `renderImageIntent`), test override |
| `apps/web/src/server/images/owned-image-reads.ts` | shared owner-scoped byte readers (moved from the Lab kernel) |
| `apps/web/src/app/api/admin/self/image-generator/…` | routes above |
| `apps/web/src/app/api/admin/self/owned-images/route.ts` | sources endpoint |
| `apps/web/src/app/settings/image-generator/page.tsx` | server page (`?run=` param idiom) |
| `apps/web/src/components/settings/image-generator-page.tsx` + `-form` + `-run-list` + `-run-detail` + `-copy.ts` | client UI |
| `apps/web/src/components/settings/owned-image-picker.tsx` | general picker |

Server modules export through the `@/server/images` barrel. The settings
navigation gains an **Image Generator** link beside the Image Lab entry.
`packages/image-core` changes live in `capabilities/`; `packages/image-replicate`
changes in `probe.ts`. No new package: the boundary work fits the app plus the
existing image packages.

### Image Lab affordance cleanup (UI only, contracts unchanged)

- `baseline_portrait` / `baseline_scene`: the create form replaces the Model
  picker with read-only copy stating the model resolves from the active
  production profile at run start.
- Controlled Mode: hidden from the create form until it has a deterministic
  render effect; historic stored values remain visible on the detail view.
- Fixture upload copy: "control fixture" with Pose / Depth / Edge wording, not
  "skeleton".
- `controlled_portrait` gains its contract-legal optional `object` reference;
  `staged_scene` gains its contract-legal optional `location` reference;
  fixture extraction accepts any picker-eligible owned source — all three
  through the general picker, with no experiment-contract change.

## Fixtures and tests

- **Probe (package suite):** alias-table derivation for the SDXL-shaped schema
  (depth/pose dedicated entries, `recipe` descriptor, reserved flags for
  prompt/reference/width/height), the Qwen 2511 shape still yielding zero
  dedicated entries, unknown URI fields staying unbound, required propagation,
  stable ordering across identical probes. Existing assertions pinning
  `additionalImageInputs: []` update to the new derivation.
- **Capability contracts (package suite):** descriptor schema defaults, old
  records parsing unchanged, version-diff entries for `providerInputs.*`.
- **Generator contracts (pure app suite):** create-request validation, failure
  code vocabulary/prefixing, run wire parsing.
- **Runner (int suite, added to the `test:engine` file list):** a focused
  `image-generator.int.test.ts` mirroring the Lab's seam-injection style
  (`setImageGeneratorRendererForTesting`, no real provider): happy path
  prompt-only and prompt+reference (hidden output, provenance columns, version
  pin), each pre-spend refusal with its exact code, provider-failure vs
  store-failure distinction, delete cleaning the output, capacity refusal,
  owner scoping.
- **Hidden-kind policy:** `limits.test.ts` (`it.each(HIDDEN_IMAGE_KINDS)`) and
  the quota int test cover `generator_output` automatically once it joins the
  list; no duplicate tests.
- Existing Lab int/pure suites must pass unchanged — they are the guard that
  the cleanup touched affordances, not contracts.
