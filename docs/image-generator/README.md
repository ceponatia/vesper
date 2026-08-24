# Image Generator

The Image Generator is Vesper's admin-only raw prompt-and-model bench at
`/settings/image-generator`, a Settings sibling of the Advanced Image Lab. It
runs any registered image model with an admin-authored whole prompt, optional
reference images, dedicated structural inputs, normalized controls, and raw
provider values — and keeps a durable per-attempt record: what was asked for,
what was actually sent, which exact provider version ran, and what came back
or why nothing did. Server code lives in
`apps/web/src/server/images/image-generator-*.ts`, the UI in
`apps/web/src/components/settings/image-generator-*.tsx`, and the run
contracts in `apps/web/src/contracts/images/image-generator.ts`.

## The boundary against the Advanced Image Lab

The Generator and the [Advanced Image Lab](../image-lab/README.md) are two
separate benches on one shared stack:

- **The Generator is freeform provider exploration.** The admin picks the
  model explicitly, authors the entire positive prompt, and no evidence rule
  constrains the request. The record is provenance — this exact request
  produced this image — with no verdict vocabulary.
- **The Lab is structured evidence.** Every experiment kind owns a defined
  question, subject bindings, fixture-review rules, and (where defined) a
  human verdict. Raw prompt/model testing is deliberately not a Lab
  experiment kind, and no Lab evidence rule is relaxed to accommodate it.

Neither surface imports the other: the Generator never touches a Lab
contract, runner, or recipe, and the Lab never reads a Generator run. Both
share the model registry and its probed capability records
([providers.md](../images/providers.md)), the pure render planner reached
through `renderImageIntent`, the curated LoRA library, the job and
provider-health machinery, and the owner-scoped byte readers
(`apps/web/src/server/images/owned-image-reads.ts`) — and nothing else.

## Runs are immutable records

One run is one row in `image_generator_runs`:
`pending → running → succeeded | failed`. The row snapshots the model slug at
create; the runner re-resolves it against the registry at run time and writes
the exact pinned provider version and the post-preparation `final_prompt`
**before** any provider spend. A settled row is never mutated or re-run — a
rerun is a new row citing the original through `sourceRunId`. The
`pending → running` claim is a conditional update, and every settle is
guarded on `running`, so two deliveries of one job cannot both reach the
provider and a settled row cannot be rewritten. Rows CASCADE
with their owner; the result and lineage pointers are SET NULL, so deleting
an output or a source run never erases the record of what happened.

A run executes under the bench's two-phase prediction budget (8 minutes to
start, 3 to render), and a prediction the provider abandons in the queue —
confirmed cancelled without ever executing — is recreated once. One run can
therefore create up to two provider predictions; each is billed only if it
actually executes, and every prediction the run created appears in the row's
`providerAttempts` record (outcome, queue and render durations, prediction id),
oldest first, with the `prediction_id` column naming the final one. The run
detail panel renders this history.

The admin's prompt is the whole positive prompt. The only transformations
between the text box and the wire are the shared model-boundary preparation
every registered-model render applies and, when a curated LoRA is selected,
that LoRA's own prompt additions — and the recorded `final_prompt` is the
post-transform text actually sent.

Deleting a run hard-deletes its hidden output image in the same call. Deletion
is a **list** action as much as a detail one: every row in the run history
carries its own Delete, and the tick boxes beside them clear a whole batch in
one call. Both doors end in the same confirmation, which names how many records
and how many rendered images are about to go — the record is provenance and
nothing brings it back.

## The form is capability-driven

The create form derives everything past the prompt from the selected model's
probed capability record, never from its slug:

- **Primary references** appear only on a model that can edit. They enter the
  planner in caller order under the neutral `reference` role; an optional
  per-reference **purpose** is recorded provenance only and never changes
  routing. Explicit primaries are capped at 6 app-side, further bounded by
  the model's own reference capacity.
- **Dedicated structural inputs** (pose / depth / edge / mask / control)
  appear only for the roles the version's probed `additionalImageInputs`
  bind to their own provider fields. An explicitly dedicated selection never
  falls back to the numbered reference array.
- **Normalized controls** (seed, negative prompt, guidance, steps, edit
  strength, thinking mode, resolution tier, custom dimensions, LoRA) are
  editable only where the active version binds a field for them. The
  image-set controls — `coherentSet`, `outputCount`, `sequentialMode` — are
  deliberately absent: a bench that renders one image per run has no use for
  them, and the server refuses them rather than reinterpreting a set request
  as a single render.
- **Output shape** offers the version's own declared shapes, filtered to the
  members the shared shape mapper actually resolves back to. Blank — the
  default — is the model's own shape; see below. On a version whose shape list
  IS its size list, the shape select replaces the resolution tier outright,
  because there the two are one provider input.
- **Advanced model inputs** render from the probed `providerInputs`
  descriptors: non-reserved fields of a type the bag can express become typed
  inputs, while reserved fields — owned by the prompt/reference/aspect/
  control/dedicated plumbing — are listed but not editable. A model registered
  before descriptors existed has none, so it offers no advanced inputs at all
  and the server refuses any sent directly to the API; a re-probe restores them.
- **The prompt** is required only where the version's probed prompt
  descriptor says so. On a model whose schema does not require it, an empty
  prompt sends no prompt field at all rather than an empty string.

Everything starts unset: the provider's own defaults rule until the admin
explicitly sets a value.

A dedicated structural input does **not** by itself make a request an edit. A
model that generates from a prompt while taking a required `pose_image` is
still generating, and only a model that cannot generate at all reads its
structural image as the thing being edited — which is why such a model can be
run here without a primary reference binding at all.

An **effective-request summary** above the Run button states the resolved
operation, version pin, references, shape, controls, and advanced values; the
summary and the POST assemble from the same state, so they cannot disagree.
Registering a new model changes this form through its capability record
alone, with no code edit.

## The model's own shape

Every player-facing image lane asks the render path for Vesper's 3:4 portrait
target, picks the nearest shape the model offers, and centre-crops whatever
comes back to reach it. The Generator does not. A bench that reshaped a
model's answer would be reporting Vesper's opinion as the model's, so a
Generator run asks for **no shape at all** by default: no `aspect_ratio` or
`size` key is written into the payload, no provider bucket is chosen for being
nearest a target the admin never named, and the returned image is stored
uncropped at whatever size the model produced.

Choosing an **Output shape** switches the run to that member of the version's
own declared list. It travels as a ratio through the same shape mapper every
lane uses, so the value that reaches the provider is the member that was
picked — and when a version declares several members at one ratio and the
mapper would resolve to a different one, the run refuses rather than
substituting it.

The distinction is an explicit policy on the shared render request
(`ImageRenderTarget.aspectRatio`, where `null` means the model's own), not a
Generator fork of the payload builder. Production lanes are unchanged.

## All-or-nothing inputs

Vesper's production lanes may drop a reference that will not fit — a scene
missing its third image still beats no scene. A Generator run may not: a
render that sent four of five explicitly selected images is a different
experiment wearing the same run id.

So a Generator run travels under the strict arm of the shared render policy:

- **`references: "require_all"`** — if the model's reference capacity or the
  inline byte budget would leave any selected reference behind, the transport
  refuses **before creating a prediction**. The run settles
  `capacity_exceeded` naming each unsent reference and its reason, reports
  nothing to provider health, and produces no output.
- **`providerInputs: "strict"`** — the finished payload is held against the
  version's probed descriptors immediately before the provider call: required
  fields must be present (unless the schema declares a default of its own),
  and declared type, integer-ness, enum membership and range must hold. Fields
  whose declared shape is an address, a list, or something the probe could not
  read are refused unless a typed transport owns them, so an admin API caller
  cannot reach a URI input by typing a string — the owner-scoped picker is the
  only path to an image.

Both checks live in `@vesper/image-replicate` beside the payload rules they
enforce; the Generator asks for the policy and never restates the rules.

## Fail closed before spend

A value that cannot be honored is refused, never silently trimmed — a
silently adjusted request would make every comparison built on it dishonest.
Every refusal settles on the run row as a stable code in the
`image_generator.*` namespace; refusals owned by the shared planner or LoRA
layers (`image_profile.*`, `image_lora.*`) land verbatim. Everything except
the last two codes below is checked before the provider is paid:

| Code                      | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `model_missing`           | the stored slug no longer resolves in the registry              |
| `version_unpinned`        | no exact provider version resolvable before spend               |
| `operation_unsupported`   | prompt-only on a no-generate model; references on a no-edit one |
| `input_missing`           | a selected image id is unreadable or its bytes are gone         |
| `capacity_exceeded`       | selected references exceed capacity or the inline byte budget   |
| `dedicated_input_unbound` | a structural role with no dedicated capability binding          |
| `prompt_required`         | the prompt is empty and this version requires one               |
| `control_refused`         | a set control or shape cannot be sent on this version           |
| `provider_input_rejected` | an unknown, reserved, unsupported, or invalid provider value    |
| `version_replay_unsafe`   | a captured version cannot be replayed against trusted facts     |
| `render_failed`           | provider execution failed                                       |
| `output_store_failed`     | the provider succeeded; local persistence did not               |

`render_failed` and `output_store_failed` stay distinct so provider health is
never charged for a local disk problem; pre-spend refusals report no provider
outcome at all. The runner never throws through the job — every stop is a
settled row carrying its reason, per [resilience.md](../resilience.md).

## Outputs are hidden assets

A successful run stores its image as kind `generator_output`, a member of
`HIDDEN_IMAGE_KINDS` ([asset-registry.md](../images/asset-registry.md)):
absent from the Gallery, the portrait surfaces, entity cloning, the file
route's public widening, and the per-owner storage-quota sum. The
`provider_image_day` budget and render backpressure still apply — hidden
outputs are free of storage accounting, not of provider cost control.

## What a run records about itself

Beside the request the admin authored, every run writes down — **before the
provider is paid** — a sanitized **effective request**: the provider-shaped
control fields and their values, the shape mode with the aspect field and
value actually sent, each selected image with the provider slot it occupies,
each structural image with the provider field it was bound to, and whether
any post-render crop was going to happen. Once the provider answers, the run
settles the returned pixel dimensions, whether Vesper cropped, and the
prediction and executed-version echoes.

The recorded request is the **whole** payload, assembled by the same builder
the transport uses — not just the controls the run set. The model row's own
pinned fields, the output format, and the reviewed quality corrections Vesper
applies to a few known models all reach the provider too, and a record that
omitted them would be describing a request nobody sent.

The reason for all of it is drift. Vesper keeps one capability record per
registered model and replaces it wholesale on re-probe, so a row saying
`guidance = 4` cannot by itself say whether the provider received
`guidance: 4` or `cfg: 4`, and a row saying "3:4" cannot say whether that
reached `aspect_ratio`, reached `size` as `1536*2048`, or was applied by
cropping afterwards. Recording the bound names makes a run's account of itself
independent of a capability record that will move. Each run also freezes the
mechanical capability facts it executed under, which is what makes exact
replay possible below.

Nothing sensitive is kept: no bytes, no data URLs, no signed download URLs,
no credentials. A LoRA reaches the payload as a download address, so that
field is recorded as redacted and the curated library id stands as the real
reference.

The run detail's **Effective request** panel shows all of it, with the raw
sanitized record underneath.

## Duplicate / variant

A settled run's detail offers **Duplicate**: the create form remounts seeded
with the original's model (when still registered), prompt, ordered primary
references and purposes, dedicated inputs, controls including any explicit
seed, and advanced provider values, plus `sourceRunId` lineage. Nothing runs
until submitted, and the original row and output stay untouched.

When the original's pinned version no longer matches the model's current pin,
the form says so and asks which version to run:

- **Use the current registered version** — the ordinary duplicate, recorded as
  a different arm.
- **Replay the captured version** — the exact historical version, planned
  against the capability record that run stored. The server verifies the
  version belongs to the same registered model and that the stored record
  genuinely describes it; when it cannot, the run refuses with
  `version_replay_unsafe` rather than pointing today's field bindings at
  yesterday's weights. The current version is never substituted for a replay
  the admin asked for.

One limit worth knowing: Vesper's reviewed quality corrections for a handful of
known models live in code rather than in the capability record, so a replay
picks up whatever those corrections say today. That is deliberate — they exist
to correct harmful provider defaults, and dropping them for a replay would make
it less like a real Vesper render, not more.

The run detail likewise surfaces a requested-vs-executed version disagreement
on any single run.

## Sources: the general owned-image picker

`GET /api/admin/self/owned-images` lists the requesting admin's own `ready`
images — every kind except the two system-bookkeeping ones
(`identity_face_crop`, `identity_trial_output`) — as ids plus display
metadata; bytes stay behind the authorized image file route. The shared
picker component renders it with a kind filter and cursor paging, and feeds
both the Generator's inputs and the Image Lab's generic roles: fixture
extraction sources, the controlled portrait's optional object reference, and
the staged scene's optional location reference.

## API and jobs

| Route                                          | Wrapper                  | Methods              |
| ---------------------------------------------- | ------------------------ | -------------------- |
| `/api/admin/self/image-generator/runs`         | `withOwnerAdmin`         | GET list, POST (201) |
| `/api/admin/self/image-generator/runs/delete`  | `withOwnerAdmin`         | POST bulk delete     |
| `/api/admin/self/image-generator/runs/[runId]` | `withOwnerAdminResource` | GET detail, DELETE   |
| `/api/admin/self/owned-images`                 | `withOwnerAdmin`         | GET                  |

Everything is self-scoped: models, images, and runs resolve against the
requesting admin's own id, and another owner's run answers the same 404 a
nonexistent one does. The bulk delete takes its ids in a body — a list of them
does not belong in a URL — capped at the list route's own maximum, and both of
its statements carry the owner predicate, so an id that is not this admin's is
simply absent from the count rather than refused, and never deleted. The POST runs the shared admission guard with
`outputKind: "generator_output"` (provider budget applies, storage
reservation skipped), creates the pending row, then starts the
`generator_image` job from the route — a refused job slot deletes the
just-created row rather than stranding a `pending` record that never runs.
The page's `?run=<id>` parameter deep-links one run's detail.

## Code map

| Module                                                       | Owns                                          |
| ------------------------------------------------------------ | --------------------------------------------- |
| `apps/web/src/contracts/images/image-generator.ts`           | statuses, request/wire schemas, failure codes |
| `apps/web/src/server/images/image-generator-store.ts`        | row↔wire, create/list/detail/delete/settle    |
| `apps/web/src/server/images/image-generator-run.ts`          | runner algorithm, synthetic profile, refusals |
| `apps/web/src/server/images/image-generator-render.ts`       | injectable render seam (`renderImageIntent`)  |
| `apps/web/src/server/images/owned-image-reads.ts`            | shared owner-scoped byte readers              |
| `apps/web/src/app/api/admin/self/image-generator/…`          | run routes                                    |
| `apps/web/src/app/api/admin/self/owned-images/route.ts`      | sources endpoint                              |
| `apps/web/src/app/settings/image-generator/page.tsx`         | server page (`?run=` idiom)                   |
| `apps/web/src/components/settings/image-generator-*.tsx`     | client UI (page, form, list, detail, copy)    |
| `apps/web/src/components/settings/owned-image-picker.tsx`    | general owned-image picker                    |

The runner builds a synthetic in-memory profile per run (pass-through prompt
strategy, caller seed policy, the run's advanced values as provider
overrides) so `compileProfileRenderPlan` stays the only control mapper and no
production profile is consulted. The working-tier design record is
`image-lab-general-model-trials.plan.md` and its spec.

## Related

- [image-lab/](../image-lab/README.md) — the structured-evidence bench beside
  this one, and the boundary above.
- [images/providers.md](../images/providers.md) — the registry, the
  capability probe that drives this form, render intents, and transport.
- [images/asset-registry.md](../images/asset-registry.md) — hidden-kind
  policy and the asset lifecycle `generator_output` rides.
