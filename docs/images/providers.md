# Providers

**One backend — Replicate — and the model list is DATA, not code.** Which models
the app can run are rows in `image_models`, managed from the admin-only
`/settings/image-models` page; per-model API reference lives in
[image-models/](../image-models/README.md), design detail in
`image-model-registry.spec.md`.
There is no Venice provider — no `VENICE_*` env, no `server/ai/venice.ts`, no
`venice_*` provider ids (owner ruling 2026-08-05: Replicate is cheaper and more
accurate).

**A model row carries what the render path needs to call it**, because Replicate
models disagree with each other in ways no shared mapping can paper over:
`referenceField` + `referenceArity` (the reference input is `image` on one model,
`image_input` on another, `images` on a third, `reference_image` on a fourth —
and both Qwen models call it `image` with *different* arities), `maxReferences`,
`aspectMode` +
`supportedAspects`, `outputFormat`, and free-form `extraInput` constants. Two
capability booleans drive every picker: `canGenerate` (can run from a bare
prompt) and `canEdit` (has a reference input at all).

**Capabilities are probed, not typed by hand.** `probeReplicateModel`
(`packages/image-replicate/src/probe.ts`, reached through the configured client)
reads the model's published OpenAPI input schema
on save and derives all of the above. `canGenerate` is false exactly when the
reference field is in the schema's `required` list — which is what keeps
`qwen/qwen-image-edit-2511` out of the new-portrait picker without anyone
flagging it. **This is the one place in the image path that fails loudly instead
of degrading:** a bad slug is a rejected save, because a half-known row would
move the failure to render time where it costs a player-visible image instead of
a form error. The one thing the probe cannot derive is `maxReferences` — no model
declares `maxItems` on its array input, the caps are stated in prose — so it is
stored per row and editable on the settings page.

**Which input is the reference is a priority order, not the first URI it finds.**
A schema can declare several URI-typed inputs, and they are not
interchangeable: a *control* image (a depth map, a pose skeleton, a mask) looks
identical to an identity reference in the schema. So the probe checks the
identity names first (`image`, `image_input`, `images`, `reference_image`,
`face_image`), then anything else URI-typed, and the control names
(`depth_image`, `pose_image`, `mask`, `mask_image`, `control_image`) **last**.
`nsfw-api/sdxl-pulid` is why: it declares `depth_image` before `reference_image`,
and plain property order resolved its reference field to the depth input — which
would have fed a character's portrait to a depth converter and rendered a
silhouette-shaped stranger, with nothing in the payload looking wrong. Control
names are deprioritized rather than excluded, so a model whose only image input
is a control image still registers as edit-capable.

**Two kinds of capability live on a row, and only one of them is probed.**
Everything above is read from the schema. The facts that decide whether a model
*should* do a job cannot be: `canEdit` is true for anything with an image input,
which lumps `qwen/qwen-image-edit-2511` (follows an instruction and keeps the
face) in with `stability-ai/stable-diffusion-3.5-large` (strength repainting that
hands back a plausible stranger). Three **reviewed** columns carry that human
judgment — `editKind` (`none` · `instruction_edit` · `multi_reference_compose` ·
`img2img` · `unknown`), `identityPreservation` (`strong` · `moderate` · `weak` ·
`unknown`), and `operatorWarning` (free text the admin card edits and the profile
pickers show as helper text before use; Wan 2.7's un-disableable moderation is
its first value) — and **a re-probe
must never overwrite them**, because no schema can tell you whether a face
survived. `supportedAspects` and `maxReferences` are owner-curated on the same
terms once a row exists: the probe writes both at **create**, but a re-probe and
a version activation leave them alone (`imageModelReprobeFields`), because the
stored list can deliberately exclude entries the schema offers — Wan's 4K size
pairs break its edit path, so resurrecting them from the schema would break
every Wan edit. The admin PATCH accepts `supportedAspects` for deliberate
updates, and the version diff labels both fields "owner-curated". `unknown` is the column default and is deliberately **permissive**: an
operator-added experimental row keeps behaving exactly as it does today instead
of being locked out by a rating nobody has written. Per-model ratings are written
up in [image-models/](../image-models/README.md); the row is the runtime truth. Two
further columns are **probe-owned** — the admin PATCH cannot set either:
`probedVersionId` (the exact version the stored bindings were read from — for a
pinned `owner/name:version` slug it must equal the pin) and
`advancedCapabilities` (optional control bindings — seed, guidance, steps, edit
strength, output count, thinking mode, LoRA … — plus extra image inputs, output
arity, and the `knownInputFields` allowlist a profile's raw overrides are
validated against). The probe derives the full known-alias binding set — seed,
negative prompt, guidance (`guidance`/`cfg`), steps (`num_inference_steps`),
edit strength (`strength`/`prompt_strength`), output count
(`num_outputs`/`max_images`), thinking mode, sequential/set modes, a tier-like
`size` enum as `resolutionTier`, integer `width`/`height` as custom dimensions,
and the two LoRA fields — types, ranges and enum values included, plus
`knownInputFields` as the sorted list of every input property, all written
atomically beside `probedVersionId` at create and re-probe. A row probed before
any of this holds `{}`, and empty means "send no optional control" — so a
profile's control defaults sit recorded-but-inert until its model's version is
probed or pinned, which is the designed activation path.
`updated_at` is a **column with no contract field**: the record crosses to the
client as JSON, so adding a timestamp forces a date-serialization decision no
consumer needs until the admin version card shows "capabilities changed at".

**Versions are promoted through an explicit candidate flow, never by drift.**
Three owner-admin actions on the model card (`/settings/image-models`):
`probe-latest` probes the bare model path and returns the candidate version, a
field-level capability diff (owner-curated fields labeled as review-only), and
per-profile findings without mutating anything; `smoke-test` runs one transient
render pinned to the candidate through a chosen profile — an edit profile gets
a locally generated neutral reference, nothing is persisted, and the action is
explicitly cost-bearing; `activate-version` re-probes that exact version
(falling back to the bare probe plus a latest-id equality check for official
models, which expose no per-version endpoint), refuses with the blocking
findings when an enabled profile would break — an impossible operation, a
provider override outside the candidate's `knownInputFields`, a LoRA profile
losing its bindings — and otherwise atomically pins the slug to
`owner/name:version` and swaps in the candidate's probed capabilities. A
re-probe of a pinned row probes only its pin and never moves it to latest.
Ordinary renders follow whatever the slug resolves to, so pinning the slug is
what pins production.

**Beneath a model sit task profiles — "how to use this model for one job."**
`image_model_profiles` (contract `packages/image-core/src/models/image-model-profiles.ts`) is
the extension point one permanent `extraInput` bag could never be: the same
Seedream row is an everyday 2K scene model in one place and a slow 4K location
model in another. A profile carries `task` (`portrait` · `variant` · `scene` ·
`item` · `location` · `chat_look` · `chat_place` · `text_repair` ·
`example_transform` · `image_set`), `operation` (`generate`/`edit`),
`promptStrategy` (an enum resolved through a code registry — never prompt logic
stored in the database), a `referencePolicy` (allowed roles, required roles, role
order, optional per-role caps, drawn from the `identity`/`location`/`style`/
`object`/… role vocabulary), `controlDefaults` (the normalized control names plus
a seed **policy** — `random`/`reuse_source`/`caller`, because a stored numeric
seed is a pin, not a default), `providerOverrides`, `timeoutMs` (null, or
30s–15min), `enabled`/`isDefault`/`builtin`, and `sort`. `(imageModelId, key)` is
unique, at most **one enabled default per task globally** (a partial unique
index), and profiles cascade-delete with their model. A profile may *narrow* a
model; it can never claim a capability the model does not expose. Profiles have
a full admin write path — create/edit/delete routes under
`/api/admin/self/image-models/{modelId}/profiles`, managed from a nested
section of each model card — and a saved configuration is validated against the
model (eligibility, provider overrides against `knownInputFields`, fail-closed
when unprobed) **only while the merged row is enabled**: a disabled row accepts
any schema-valid patch, which is what makes "disable the broken profile and
retry" an action that actually works.

**A LoRA is a curated library row, never a raw locator on a request.**
`image_loras` (contract `packages/image-core/src/loras/image-loras.ts`, admin CRUD under
`/api/admin/self/image-loras`, managed from a section of
`/settings/image-models`) carries a label, a locator — a Hugging Face
`owner/repo` slug or a direct HTTPS weights URL, never a credential —
compatible model slugs and optional exact version ids, a curated scale range
(`minimumScale ≤ defaultScale ≤ maximumScale`), allowed tasks, optional trigger
words and prompt prefix/suffix, and an enabled flag. A render names a LoRA
only as `controls.lora = { id, scale? }`; resolution loads the row and refuses
before any provider work when the LoRA's own curation says no
(`image_lora.incompatible` — wrong model, wrong version, wrong task, scale
outside the curated range) or the configuration cannot reach the provider
(`image_lora.unreachable_configuration` — row missing or disabled, the active
version declaring no LoRA bindings, scale outside the provider's declared
range). A scale is refused, never clamped. The resolved locator and scale land
on the version's two declared fields; prompt additions and any trigger word not
already present are woven into the compiled prompt so the recorded final prompt
is the sent prompt; the record keeps `{ id, scale }` while the locator goes to
the provider payload and nowhere else, with URL query strings redacted from
diagnostics. One LoRA per render — that is what the tested binding supports.

**Every render resolves a profile, and every picker lists profiles.** All seven
lanes call `resolveImageProfileForTask` for their own task before they reserve
an image row, then describe the render as an *intent* (below). Model-level
resolution no longer exists, and neither does a model picker: the player-facing
selects (`ImageProfileSelect` — the portrait studio's two sections, the chat
scene strip, the scenario modal) list offered profiles grouped per model from
`GET /api/image-profiles?task=…`, lead with an explicit "Task default" option
(an empty value; the server resolves the task default), and show the selected
profile's operator warning as helper text. The stored value rides the same
`modelId`/`sceneModel` fields, so a legacy stored model id keeps resolving
through the degrade chain below. Of the 29 built-in profiles, the 22 standard
ones are each equivalent to what its lane rendered before; the seven curated
ones are non-default alternatives a player or admin must pick. The standard
set, by model:

- `qwen/qwen-image-2512` — `portrait-standard`, `item-standard`,
  `location-standard`, `chat-place-standard`; all `generate` /
  `text_to_image_description`, and **each is its task's global default**.
- `qwen/qwen-image-edit-2511` — `variant-standard`, `scene-standard`,
  `chat-look-standard`; all `edit` / `instruction_edit`, and **each is its task's
  global default**.
- `bytedance/seedream-4.5`, `bytedance/seedream-5-lite`, and
  `wan-video/wan-2.7-image-pro` — `portrait-standard`, `variant-standard`,
  `scene-standard`. Alternatives; no defaults.
- `stability-ai/stable-diffusion-3.5-large` — `portrait-standard` only, matching
  the row's portrait-only toggles.
- `aisha-ai-official/nsfw-flux-dev`, `aisha-ai-official/likereality-pony-v1` and
  `prunaai/p-image` — `portrait-standard` only. These three publish **no
  reference input at all**, so `canEdit` is false and the variant and scene
  surfaces are closed to them by capability, not by a toggle.
- `nsfw-api/sdxl-pulid` — `variant-standard` and `scene-standard`, and no
  portrait profile: it is an identity adapter, and bare-prompt it is an ordinary
  SDXL generator. Single reference only, so a `multi` scene render degrades to
  the single-reference rung.

The four anchor tasks with no picker of their own (`item`, `location` and
`chat_place` sit on the general-purpose generator; `chat_look` on the instruction
editor) are seeded **only on the model that lane renders with**, so no model
becomes newly eligible. The seeded policies likewise reproduce current behavior:
generate tasks allow no references at all; `variant` and `chat_look` require
`identity` and allow `style`; `scene` orders identity → location → style → object
and **requires nothing**, because the scene ladder's bare-prompt rung legitimately
runs with zero references. `scene` profiles carry the `instruction_edit` strategy
even on the multi-reference models — the lane decides multi-vs-single at
render time, and changing that here would change a payload.

The seven curated profiles ride the same machinery as alternatives, never
defaults: Qwen 2512 `portrait-fast` (steps 28) and `portrait-quality` (steps
50, `go_fast` off via provider override), Seedream 4.5 `ensemble-scene-2k`
(multi-identity/object reference policy, 2K tier) and `location-4k`, Seedream 5
Lite `quality-scene-3k`, Stable Diffusion 3.5 `stylized-portrait-high-guidance`
(guidance 8 plus a curated negative), and Wan `multi-reference-edit-2k`.
Control defaults that map through probed bindings sit inert until the model's
version is probed or pinned; Wan's 2K tier is effective the moment the profile
is picked, because size-pair negotiation needs no binding. Per-model detail:
[image-models/](../image-models/README.md).

**Profile resolution is a five-step degrade** (`resolveImageProfile`), because the
stored value may be a profile id, a model id, a model slug, or a dead value from
before any of this existed: (1) a profile id among the offered candidates; (2) a
model id or slug → that model's **own** default profile, else its first offered
profile in sort order; (3) the task's global default profile; (4) the first
offered profile in sort order; (5) null, which the caller reports as
`image_profile.none_offered` and fails the render on. A stored pick the resolver
did not honor raises `image_profile.pick_unavailable`; the pickers list the same
candidate set resolution reads, so the picker and the render can no longer
disagree about what is offered. Step
2's second half is load-bearing: `isDefault` is
globally unique per task, so most models carry none, and without that fallback a
stored Seedream scene pick would silently jump to Qwen Edit — a render change.
"Offered" is one shared candidate set (`imageProfileCandidates`, which pickers
read too, so a picker can never show an option resolution would refuse): right
task, `enabled`, model present and parsed, the task's **legacy surface toggle**
still on where the task has one (`forPortrait`/`forVariant`/`forScene` gate
`portrait`/`variant`/`scene`; the anchor and new tasks never had a toggle and use
enabled profiles directly), and the profile eligible for its model. Every step
reads that same list, so an ineligible or disabled stored pick degrades instead of
failing. A malformed profile payload degrades to `[]` rather than throwing
(`imageModelProfileListSchema`, docs/resilience.md §1), and a single unparseable
row is skipped with `image_profile.row_invalid` rather than emptying the list.

**A render is described as an intent, not as a model call.** A lane supplies its
resolved profile, its prompt, a target ratio, and references that carry a
**role** — `identity`, `location`, `style`, `object`, and the structural control
roles — instead of an anonymous buffer list where a reference's meaning was its
position. Planning is pure and happens before any bytes leave the process, and it
decides which references survive, in what order, and on which provider field
(`planIntentReferences`).

The path is split across the workspace boundary at exactly that line. Planning
and profile compilation are `@vesper/image-core` (`planImageRender`,
`compileProfileRenderPlan`): no database, no provider, no environment. The
application half (`server/images/render-intent.ts`) resolves the LoRA binding
against the library, resolves the deployment facts the planner may not read —
today just whether the provider's safety checker is bypassed — reports the
diagnostics below, and calls the transport. A lane still renders through
`renderImageIntent` and never touches the planner directly; the Advanced Image
Lab is the one exception, because it needs the compiled prompt before it renders.

**Which references survive is the profile's policy, not the caller's order.**
Selection sorts required references ahead of optional ones, then by the profile's
`roleOrder`, then by a caller's numeric `priority`, then by the order the lane
supplied them — and truncates at `referenceCapacity`. A role outside
`allowedRoles` is dropped before the contest (an empty `allowedRoles` declares no
allowlist, and a `requiredRoles` entry is allowed implicitly); `maxPerRole` caps
each role. Every dropped reference carries the reason it went —
`role_not_allowed`, `role_cap`, or `model_capacity` — and they read out in caller
order under `image_profile.references_trimmed`. An empty policy is a no-op, which
is what keeps the seeded profiles' payloads unchanged.

`requiredRoles` are checked against everything that will actually be SENT — the
primary array and the dedicated control fields alike — and refuse the render with
`image_profile.required_reference_missing` if any is absent. A reference the
CALLER marked `required: true` refuses one layer finer: if selection drops it
for any reason, the plan refuses with
`image_profile.required_reference_dropped`, naming each dropped role and
reason — the role gate is a set, so it alone cannot tell "an identity reference
survived" from "the second of two required identities was trimmed". Only
optional references are trimmed and reported. Per-render controls
merge over the profile's stored defaults, and the profile's prompt strategy
compiles the final text. A strategy this path has no wording for refuses with
`image_profile.prompt_strategy_unsupported` rather than sending a lesser one.

**A structural control is routed by its binding, not by its position.** A control
role (`mask` · `pose` · `depth` · `edge` · `control`) is checked against the
active version's `additionalImageInputs`. A version that declares its own field
for the role gets the image on that field, where it does **not** spend a primary
reference slot; a version that declares none — every model Vesper runs today —
takes the control as an ordinary numbered image in the primary array, which is
how Qwen Image Edit 2511 accepts pose and depth maps. A binding naming the
primary reference field is read as the numbered array rather than as a second
field, and a binding naming any reserved field is refused with
`image_model.control_field_reserved`. A dedicated field's declared arity and
`maxItems` cap what it takes; the surplus drops as `role_cap`.

The two production prompt strategies add **nothing** to the lane's own text: the
lane's builder already names its references, so a second set of numbered bindings
would describe the same images twice. `multi_reference_compose` is the exception
and the point of the strategy — it prefixes a numbered `Image N:` binding per
reference from one reference upward, in send order, naming each role's purpose,
and adds a closing clause whenever a structural control is present telling the
model to follow the control and never render it. The identity-pack vocabulary
compiles its own separate numbered preamble for the identity trial.

Lanes that number their references in their own prompt text build that text
before selection runs, so nothing may move a slot underneath them.
`image_profile.references_renumbered` reports when something does — measured as
slot equality, so removing the second of three references (dropped, disallowed,
or routed to a dedicated field) counts, while trimming from the tail does not. No
lane triggers it today.

A version may also declare a control input it **requires**. A render with nothing
to bind to that field is refused with
`image_profile.required_control_input_missing` before transport, rather than
buying a provider rejection at full latency.

Two things the intent deliberately does not send. It does **not** pin a provider
version — an ordinary render follows whatever the model slug resolves to (a
pinned slug pins production; a bare slug floats), while a controlled comparison
pins explicitly, which is why only the trial does. And it does **not**
force a prediction budget: a profile's own `timeoutMs` is used when it declares
one (no seeded profile does), and otherwise `REPLICATE_PREDICTION_TIMEOUT_MS`
still decides.

**Seeds are resolved app-side and recorded, never drawn in the pure planner.**
An explicit `controls.seed` always wins; otherwise a `random`-policy profile
draws a uniform integer inside the active version's probed seed binding — only
when that binding exists (an unseeded run stays honestly unseeded), and never
on a render carrying an explicit version pin, whose schema the active bindings
do not describe. Every generating lane then records the attempt under
`images.meta.render` — model, profile, task, prompt strategy, resolved seed,
applied and dropped controls, the reference roles actually sent (truncated to
what the byte budget let through), the prediction id, and the version the
provider says it executed — on failures too where the lane's failure shape
returns rather than throws. That record is what a retry of the same composition
reads. The character-fact lanes file a second, sibling provenance key beside it —
`images.meta.visualState`, the visual-digest record ([pipelines.md](pipelines.md)).

**Eligibility composes the mechanical and the reviewed** (`profileEligibility` →
`operation_unsupported` | `edit_kind_none` | `identity_too_weak` |
`img2img_identity_task`): a `generate` profile needs `canGenerate`; an `edit`
profile needs `canEdit` **and** an `editKind` other than `none`; and the
identity-critical tasks — `variant`, `scene`, `chat_look` — additionally refuse
`identityPreservation: "weak"` and `editKind: "img2img"`, because `canEdit` alone
was never evidence that a face survives. `portrait` is deliberately not
identity-critical: it *creates* the reference every other task preserves. An
img2img model stays usable through a deliberate remix profile on a non-identity
task, and `unknown` passes every semantic check.

**Shape is negotiated per render, not fixed per model.** A lane asks for a ratio
(3:4 everywhere except items at 1:1 and locations at 3:2); `chooseDimensions`
extends the `chooseAspect` seam with the profile's dimension controls. On
aspect-ratio models the shape is the closest enum entry (largest exact match
preferred) while a tier or custom pair rides the mapped control fields; on
size-mode models the enum entries ARE the sizes, so a named tier picks the
nearest-area entry within the closest-ratio group (largest when unset — the
pre-tier behavior), and an explicit pair is honored only under the `custom`
tier and only when it matches an offered entry verbatim. `width`/`height`
require the `custom` tier in both modes — set without it they are dropped with
`requires_custom_resolution` rather than sent under a crop expectation that
would be wrong. `renderWithModel` centre-crops toward the lane's ratio whenever
the expected shape misses it. One mechanism therefore serves Vesper's 3:4
portraits, Stable Diffusion 3.5 Large (whose enum has **no** 3:4 — it renders
4:5 and gets cropped), Wan 2.7 (no aspect input; `1536*2048` pixel pairs, its
2K/4K tiers picking among them), and the entity lanes.

**Selection stays fail-visible.** `routeSceneAttempts` (`packages/image-core/src/provider-interface/attempts.ts`) orders one model's
degradation ladder — multi-reference edit → single-reference edit → bare prompt —
and the bare-prompt rung is reachable **only** when no reference image exists at
all. A render never hops to a *different* model, so a failure stays visible and
retryable rather than silently painting a different-looking person (owner ruling 2026-07-29). An edit-only model
with no reference yields an empty chain and a visible refusal. The
`replicate/<slug>` actually used is recorded on `images.meta.model`.

**Transport** (`@vesper/image-replicate`): the model prediction endpoint (`POST
/models/{owner}/{name}/predictions`) with `Prefer: wait=60`, then poll — or
`POST /predictions` carrying a version id when the slug is pinned
`owner/name:version`. `REPLICATE_PREDICTION_TIMEOUT_MS` (clamped 30s–30m, default
5m) drives both deadlines — Replicate's `Cancel-After` header and the client's own
poll cutoff — so raising it can't leave the provider cancelling at a stale bound.
Reference and control bytes cross a **preparation pass** at the
`renderWithModel` choke point (`reference-preparation.ts`: EXIF orientation
applied, metadata stripped, alpha flattened only for non-alpha targets, encoded
to a format the model accepts) — an already-clean webp passes through
byte-identical after one metadata sniff, and a reference whose preparation
fails degrades to its original bytes with a diagnostic rather than failing the
render. Prepared bytes carry their real media type and extension to the wire.
Edit references are uploaded as
**private Replicate files** (Vesper's images are not publicly addressable and
exceed the data-URL guidance), trimmed to the model's capacity by `fitReferences`
*before* the upload cost is paid, uploaded with **bounded concurrency of three**
(`transportReplicateReferences` — input-order URIs whatever the completion
order, and on any single failure every successful upload is deleted best-effort
before the failure returns), and deleted best-effort as soon as the
prediction settles; outputs are downloaded only from `replicate.delivery` /
`api.replicate.com` and land in the same immutable pipeline as every other asset.
Nothing throws — a failure degrades to an error string the caller turns into a
failed row. `disable_safety_checker` is only ever sent to models whose schema
declares it (Replicate rejects unknown inputs); its value comes from
`REPLICATE_SAFE_MODE`.

**The transport reads no environment; the application configures it once.**
`apps/web/src/server/ai/replicate-runtime.ts` is the only code in Vesper that reads
`REPLICATE_API_TOKEN`, `REPLICATE_SAFE_MODE` and
`REPLICATE_PREDICTION_TIMEOUT_MS`. It resolves them on first use — lazily,
because Next loads server modules while building routes, when secrets are absent
— and memoizes one configured client for the process; `hasReplicate()` and
`disableSafetyChecker()` are views onto that one snapshot, and rendering,
preprocessing and probing all run through it. That is what keeps the safety
posture single-source: the value a render's plan is fingerprinted with is the
same immutable value the payload builder writes, so a process cannot hash one
posture and send another.

**Billing failures are their own class.** `replicate 402: Insufficient credit`
would otherwise match the transient status-code pattern and earn a pointless
retry, so classification checks billing first and `isBillingFailure` names it.

**Failure classification is split across the boundary.** The vocabulary and the
rules — transient / content rejection / other, and what each says about provider
health — are provider-neutral and live in
`packages/image-core/src/provider-interface/failures.ts`, taking a plain message.
`apps/web/src/server/ai/image-providers.ts` is the four-line adapter that turns a *thrown*
value into that message, which is the one part that has to know the AI SDK: an
upstream moderation verdict arrives buried in `APICallError.responseBody`, not in
`error.message`. A second image transport reuses every rule by describing its own
errors and calling the same functions.
