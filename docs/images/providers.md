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
further columns are probe-owned and **nothing writes them**:
`probedVersionId` (the exact version the stored bindings were read from — for a
pinned `owner/name:version` slug it must equal the pin) and
`advancedCapabilities` (optional control bindings — seed, guidance, steps, edit
strength, output count, thinking mode, LoRA … — plus extra image inputs, output
arity, and the `knownInputFields` allowlist a profile's raw overrides are
validated against). `advancedCapabilities` is `{}` on every row, and empty means
"send no optional control", which is exactly what every lane does today.
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
`location`, `style`, `object`, and the reserved control roles — instead of an
anonymous buffer list where a reference's meaning was its position. Planning is
pure and happens before any bytes leave the process: references are trimmed to
`referenceCapacity` in caller order (priority selection by role is not built
yet), a profile's `requiredRoles` are checked against what SURVIVES that trim and
refuse the render with `image_profile.required_reference_missing` if any is
absent, per-render controls merge over the profile's stored defaults, and the
profile's prompt strategy compiles the final text. A strategy this path has no
wording for refuses with `image_profile.prompt_strategy_unsupported` rather than
sending a lesser one.

The production prompt strategies add **nothing** to the lane's own text: the
lane's builder already names its references, so a second set of numbered bindings
would describe the same images twice. The numbered `Image N:` preamble belongs to
the identity-pack vocabulary and is compiled only for the identity trial.

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
