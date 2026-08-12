# Providers

**One backend — Replicate — and the model list is DATA, not code.** Which models
the app can run are rows in `image_models`, managed from the admin-only
`/settings/image-models` page; per-model API reference lives in
[image-models/](../image-models/README.md), design detail in
[developer-notes/image-model-registry.spec.md](../developer-notes/finished/image-model-registry.spec.md).
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
(`server/ai/replicate-probe.ts`) reads the model's published OpenAPI input schema
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
`unknown`), and `operatorWarning` (free text bound for the admin card and the
pickers, though no surface renders it; Wan 2.7's un-disableable moderation is its
only value) — and **a re-probe
must never overwrite them**, because no schema can tell you whether a face
survived. `unknown` is the column default and is deliberately **permissive**: an
operator-added experimental row keeps behaving exactly as it does today instead
of being locked out by a rating nobody has written. Per-model ratings are written
up in [image-models/](../image-models/README.md); the row is the runtime truth. Two
further columns are **probe-owned** — the admin PATCH cannot set either:
`probedVersionId` (the exact version the stored bindings were read from — for a
pinned `owner/name:version` slug it must equal the pin) and
`advancedCapabilities` (optional control bindings — seed, guidance, steps, edit
strength, output count, thinking mode, LoRA … — plus extra image inputs, output
arity, and the `knownInputFields` allowlist a profile's raw overrides are
validated against). The probe derives exactly two of those bindings — a string
`lora_weights` input becomes `controls.loraWeights` and a numeric `lora_scale`
becomes `controls.loraScale`, range included, written atomically beside
`probedVersionId` at create and re-probe — and derives nothing else, so a row
probed before that existed holds `{}`, and empty means "send no optional
control", which is exactly what every lane sends for everything but a LoRA.
`updated_at` is a **column with no contract field**: the record crosses to the
client as JSON, so adding a timestamp forces a date-serialization decision no
consumer needs until the admin version card shows "capabilities changed at".

**Beneath a model sit task profiles — "how to use this model for one job."**
`image_model_profiles` (contract `contracts/images/image-model-profiles.ts`) is
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
model; it can never claim a capability the model does not expose.

**A LoRA is a curated library row, never a raw locator on a request.**
`image_loras` (contract `contracts/images/image-loras.ts`, admin CRUD under
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

**Every render resolves a profile.** All seven lanes call
`resolveImageProfileForTask` for their own task before they reserve an image row,
then describe the render as an *intent* (below). Model-level resolution no longer
exists. The 22 built-in profiles are each equivalent to what its lane rendered
before, so the switch changed where the configuration comes from and not what the
provider receives. The seeded set, by model:

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

**Profile resolution is a five-step degrade** (`resolveImageProfile`), because the
stored value may be a profile id, a model id, a model slug, or a dead value from
before any of this existed: (1) a profile id among the offered candidates; (2) a
model id or slug → that model's **own** default profile, else its first offered
profile in sort order; (3) the task's global default profile; (4) the first
offered profile in sort order; (5) null, which the caller reports as
`image_profile.none_offered` and fails the render on. A stored pick the resolver
did not honor raises `image_profile.pick_unavailable` — which is also what an
operator sees after adding a model through the admin page, because the model
pickers still list models by legacy surface while renders resolve profiles, so a
model with no profile is offered and then passed over for the task default. Step
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

**A render is described as an intent, not as a model call**
(`server/images/render-intent.ts`). A lane supplies its resolved profile, its
prompt, a target ratio, and references that carry a **role** — `identity`,
`location`, `style`, `object`, and the structural control roles — instead of an
anonymous buffer list where a reference's meaning was its position. Planning is
pure and happens before any bytes leave the process, and it decides which
references survive, in what order, and on which provider field
(`planIntentReferences`).

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
version — an ordinary render follows the model slug's floating latest, while a
controlled comparison pins, which is why only the trial does. And it does **not**
force a prediction budget: a profile's own `timeoutMs` is used when it declares
one (none of the seeded 17 do), and otherwise `REPLICATE_PREDICTION_TIMEOUT_MS`
still decides.

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
(3:4 everywhere except items at 1:1 and locations at 3:2); `chooseAspect` picks
the closest entry in `supportedAspects`, preferring the largest exact match; and
`renderWithModel` centre-crops whatever is left over. One mechanism therefore
serves Vesper's 3:4 portraits, Stable Diffusion 3.5 Large (whose enum has **no**
3:4 — it renders 4:5 and gets cropped), Wan 2.7 (which has no aspect input at all
and takes `1536*2048` pixel pairs), and the entity lanes.

**Selection stays fail-visible.** `routeSceneAttempts` orders one model's
degradation ladder — multi-reference edit → single-reference edit → bare prompt —
and the bare-prompt rung is reachable **only** when no reference image exists at
all. A render never hops to a *different* model, so a failure stays visible and
retryable rather than silently painting a different-looking person (owner ruling 2026-07-29). An edit-only model
with no reference yields an empty chain and a visible refusal. The
`replicate/<slug>` actually used is recorded on `images.meta.model`.

**Transport** (`server/ai/replicate.ts`): the model prediction endpoint (`POST
/models/{owner}/{name}/predictions`) with `Prefer: wait=60`, then poll — or
`POST /predictions` carrying a version id when the slug is pinned
`owner/name:version`. `REPLICATE_PREDICTION_TIMEOUT_MS` (clamped 30s–30m, default
5m) is parsed **once per prediction** and drives both deadlines — Replicate's
`Cancel-After` header and the client's own poll cutoff — so raising it can't leave
the provider cancelling at a stale bound. Edit references are uploaded as
**private Replicate files** (Vesper's images are not publicly addressable and
exceed the data-URL guidance), trimmed to the model's capacity by `fitReferences`
*before* the upload cost is paid, and deleted best-effort as soon as the
prediction settles; outputs are downloaded only from `replicate.delivery` /
`api.replicate.com` and land in the same immutable pipeline as every other asset.
Nothing throws — a failure degrades to an error string the caller turns into a
failed row. `disable_safety_checker` is only ever sent to models whose schema
declares it (Replicate rejects unknown inputs); its value comes from
`REPLICATE_SAFE_MODE`.

**Billing failures are their own class.** `replicate 402: Insufficient credit`
would otherwise match the transient status-code pattern and earn a pointless
retry, so `classifyImageFailure` checks billing first and `isBillingFailure`
names it.
