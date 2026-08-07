# Image model registry — spec

Status: companion to [image-model-registry.plan.md](image-model-registry.plan.md)
(shipped 2026-08-05)

The registry is live and this document describes what shipped. The columns and
machinery added on top of it — reviewed capability ratings, task profiles,
normalized controls, version promotion — are owned by
[image-model-capabilities.spec.md](image-model-capabilities.spec.md), not by this
file.

## Owner rulings (2026-08-05)

1. **Stable Diffusion 3.5 Large is included as a text-to-image model.** It does
   support text-to-image. It does not offer 3:4; the agent chose the closest fit
   and crops. Ruling: render at `4:5` and centre-crop to 3:4 (aspect 0.80 against
   the target 0.75 loses ~6.25% of width, where `2:3` at 0.667 would lose ~11.1%
   of height).
2. **Both Qwen models ship.** `qwen/qwen-image-2512` is the default for new
   portraits; `qwen/qwen-image-edit-2511` is the default for the scene editor and
   for portrait variants. 2512 also advertises image-to-image, but the dedicated
   edit model is assumed better at editing until measured otherwise.
3. **Every model carries an edit capability flag.** Models that can edit are
   offered in New Variant and the scene generator. Agent judgment (delegated):
   edit-capable models *are* also offered in the portrait studio's new-portrait
   picker whenever they can run without a reference — so the filter is two
   independent flags, not one either/or.
4. **The database is the single source of truth.** Seeded built-ins are ordinary
   rows: editable and deletable like any other.
5. **Existing chats are not migrated.** The owner deletes them manually. Stored
   picks still parse defensively (`parseOr` at the boundary, per
   [docs/resilience.md](../resilience.md)) and fall back to the default.

## Probed Replicate facts (2026-08-05)

Recorded here because the registry seed depends on them and because Replicate
does not version this metadata. Per-model detail lives in
[docs/image-models/](../image-models/); the seeded values themselves are in
`drizzle/0098_demonic_gamma_corps.sql`.

Reference input field name and arity, which differ per model and are the reason
a single shared mapping is impossible:

- `qwen/qwen-image-2512` — `image`, single URI, plus `strength`. Optional.
- `qwen/qwen-image-edit-2511` — `image`, **array** of URI. **Required.**
- `bytedance/seedream-4.5` — `image_input`, array of URI, default `[]`.
- `bytedance/seedream-5-lite` — `image_input`, array of URI, default `[]`.
- `stability-ai/stable-diffusion-3.5-large` — `image`, single URI, plus
  `prompt_strength` (0.85 default). Optional.
- `wan-video/wan-2.7-image-pro` — `images`, array of URI, default `[]`.

Required-input sets: every model requires only `["prompt"]` except
`qwen/qwen-image-edit-2511`, which requires `["prompt", "image"]`.

**No model declares `maxItems` on its array reference input.** The caps are
stated in prose instead, so the probe reads a starting value out of the field
description and the stored number is editable on the admin page.

Shape control:

- `3:4` is present in the `aspect_ratio` enum for `qwen-image-edit-2511`,
  `seedream-4.5`, and `seedream-5-lite`.
- `stable-diffusion-3.5-large`'s `aspect_ratio` enum has no `3:4` — it offers
  `16:9 1:1 21:9 2:3 3:2 4:5 5:4 9:16 9:21`. Ruling 1 applies.
- `wan-2.7-image-pro` has **no `aspect_ratio` input at all**, only `size`, whose
  enum mixes tier names (`2K`) with pixel pairs. Only the pairs are stored, and
  the `4096*…` entries are deliberately excluded because Wan documents 4K as
  text-to-image only and the render path prefers the largest exact match.

Output format: `webp` is available on `qwen-*` and `stable-diffusion-3.5-large`.
`seedream-5-lite` offers only `png` / `jpeg`. `seedream-4.5` and
`wan-2.7-image-pro` declare no `output_format` input. Anything that is not WebP
is converted after download by the existing sharp path.

## Data model

Table `image_models`, declared in `src/server/db/schema.ts`, created by
`drizzle/0098_demonic_gamma_corps.sql` and parsed through `imageModelSchema` in
`src/contracts/images/image-models.ts`.

- `id` — text primary key, minted by `newId()`.
- `slug` — unique. The Replicate model path, optionally `owner/name:version`.
- `label` — display string for the pickers.
- `canGenerate` — boolean. True when the model can run with no reference.
- `canEdit` — boolean. True when the model has a reference input field.
- `referenceField` — the input key references are written to.
- `referenceArity` — `"single"` or `"array"`.
- `referenceTransport` — `"file"` (default) or `"data_url"`. How the bytes
  travel; see "Reference transport" below. Owner-set, never probed. Added by
  `drizzle/0099_married_lionheart.sql`.
- `maxReferences` — integer. The stored cap, probe-seeded from prose and
  owner-editable.
- `aspectMode` — `"aspect_ratio"` or `"size"`. Which input key carries the shape.
- `supportedAspects` — the model's whole shape menu, verbatim from its enum.
  Selection happens per render, not at save time.
- `outputFormat` — nullable; omitted from the payload when null.
- `extraInput` — jsonb; per-model constants merged into the payload.
- `forPortrait` / `forVariant` / `forScene` — surface toggles.
- `builtin` — marks a seeded row for display only. Does **not** gate deletion
  (ruling 4).
- `sort`, `createdAt`.

There is no stored `aspectValue` and no `"crop"` aspect mode. Both were folded
into `supportedAspects` plus a per-render decision, so that one mechanism serves
the 3:4 portrait/scene lanes and the entity lanes' 1:1 and 3:2 without a
per-model branch.

The columns beyond this list — `probedVersionId`, `editKind`,
`identityPreservation`, `operatorWarning`, `advancedCapabilities`, `updatedAt` —
belong to the capabilities work and are specified in
[image-model-capabilities.spec.md](image-model-capabilities.spec.md)
§"Extensions to `image_models`".

Surface filters compose the capability flags with the toggles
(`imageModelOffersSurface`): the portrait picker lists `canGenerate &&
forPortrait`; New Variant and the scene picker list `canEdit && forVariant` /
`canEdit && forScene`. A row whose flags and toggles disagree is simply not
offered — no error, no diagnostic.

## Capability probe

`src/server/ai/replicate-probe.ts`.
`GET https://api.replicate.com/v1/models/{owner}/{name}` →
`latest_version.openapi_schema.components.schemas.Input`. From it:

- `referenceField` — the first property whose type is `string` with
  `format: "uri"`, or an array whose `items` are such strings. Search order is
  fixed (`image`, `image_input`, `images`, then any other match) so a model with
  two image-ish inputs resolves deterministically.
- `referenceArity` — `"array"` when the property is an array, else `"single"`.
- `canEdit` — a reference field was found.
- `canGenerate` — the reference field is absent from the schema's `required`.
- `maxReferences` — `maxItems` when declared; otherwise the second number of a
  `"1-14 images"` range or the number in `"up to 9 images"`, read from the
  field's description; otherwise 3. A starting value the admin page can correct,
  never a guarantee.
- `aspectMode` / `supportedAspects` — the `aspect_ratio` enum when the model has
  one, else the `size` enum filtered to entries that express a shape (a tier name
  like `2K` says nothing about proportions), else an empty menu.
- `outputFormat` — `"webp"` when the enum offers it, else the first enum value,
  else null.
- `isOfficial` / `versionId` — see "Official vs community models" below.

**A pinned slug is probed at its own version.** `owner/name:version` reads
`GET /models/{owner}/{name}/versions/{version}` (whose `openapi_schema` sits at
the top level) rather than the model record's `latest_version` (where it is
nested). Probing latest for a pinned row would store capability columns
describing a schema the render path never posts — the exact drift pinning exists
to prevent, and it would surface as every render failing on invalid inputs while
the save looked fine. Observed real: the version endpoint for
`qwen/qwen-image-edit-2511` reports `lora_scale` / `lora_weights` that the model
record's `latest_version` does not.

The probe runs on create and on an explicit re-probe from the settings page. It
is a trust boundary: the response is parsed through a zod schema, and a probe
that cannot find a prompt input fails the save with `image_model.probe_failed`
rather than writing a half-known row.

Probe failure is the ONE place this feature fails loudly instead of degrading —
writing a row we cannot render with would move the failure to render time, where
it costs a player-visible image instead of a form error.

Re-probing refreshes only what the model *can* do. The surface toggles, the
hand-set reference cap, the reference transport, and the reviewed judgments the
capabilities work added are the owner's and are never overwritten by it.

## Render path

`src/server/ai/replicate.ts` exports
`runRegistryImageModel(model, request, sink)`:

1. Trim references through `fitReferences`, so a single-reference model is never
   handed three. A model that cannot generate and has no reference left refuses
   here rather than at the provider.
2. Move the bytes according to `referenceTransport` — upload each as a private
   Replicate file and send the URLs, or inline them as data URIs.
3. Build the payload with `buildRegistryModelInput`: `prompt`, then
   `referenceField` set to the single URL or the URL array per `referenceArity`
   (omitted entirely when there are no references), then the aspect key per
   `aspectMode`, then `outputFormat` and `extraInput` when present.
   `disable_safety_checker` takes its value from the environment but is never
   introduced as a key on a model whose schema lacks it, because Replicate
   rejects unknown inputs.
4. Overlay `request.controlInput` on the built payload, minus the fields the
   render path owns (`reservedImageInputFields`: prompt, the reference field, the
   aspect key, `version`, `disable_safety_checker`). A refused key raises
   `image_model.reserved_field_ignored` rather than being swallowed. Ordinary
   lanes pass no control input at all.
5. Run and poll through the existing `runReplicateImageModel` shell — deadline,
   `Cancel-After`, and download.
6. Delete any uploaded files best-effort in `finally`.

Shape normalization sits one level up, in `renderWithModel`
(`src/server/images/models.ts`): `chooseAspect` picks the closest entry in
`supportedAspects` to the ratio the lane asked for, and the result is
centre-cropped when that entry was not exact — or when the model offered no
parseable shape at all and used its own default. A crop failure degrades with
`image_model.crop_failed` rather than losing the image.

`src/server/ai/image-providers.ts` keeps its role as the capability seam, but its
ids now describe **how many references an attempt uses** (`multi_edit`, `edit`,
`generate`) rather than which vendor serves it, plus `demo` for the
no-provider monogram path. A selected model never falls across to a different
model. `venice_*` ids and `src/server/ai/venice.ts` were deleted outright, along
with `VENICE_*` env.

## Official vs community models (added 2026-08-05, post-ship)

`POST /models/{owner}/{name}/predictions` — the endpoint `replicatePredictionTarget`
uses for a bare slug — is **official models only**. A community model posted
there returns a bare 404 that says nothing about why. Three rows registered
cleanly and then 404'd on every render because of it
(`lucataco/juggernaut-xl-v9`, `nsfw-api/pony-realism-v2.3`,
`nsfw-api/realvis-hyper-lora`).

The model record exposes `is_official`, so the probe reads it and the add route
**auto-pins a community model** to the probed version id, storing
`owner/name:version`. Pinned slugs post to `/predictions` with the version,
which is the only endpoint that runs them.

- Official models keep the bare slug and go on tracking `latest_version`.
- `is_official` missing ⇒ treated as **community**. Running a pinned version
  works for official models too (verified against `black-forest-labs/flux-dev`),
  so a wrong "community" guess costs only latest-tracking, while a wrong
  "official" guess costs every render.
- A community model with no `latest_version` is rejected at save
  (`image_model.unrunnable`) — there is no way to run it.
- The duplicate check runs twice: once on what the caller typed, once on the
  pinned slug, since the first check cannot see a row it is about to collide
  with.

## Reference transport (added 2026-08-05, post-ship)

Uploading each reference as a private Replicate file is not universal. Wan 2.7's
wrapper proxies Alibaba's async API and validates the file **extension** of what
it receives; a Replicate files-API URL reaches the model container without one,
and the prediction dies before it starts:

```
ValueError: Invalid image format ''. Supported formats: .bmp, .jpeg, .jpg, .png, .webp
```

So the transport joins the field name and the arity as a third thing a schema
cannot tell you, stored per row:

- `file` — upload, send the URL, delete in `finally`. The default, and what every
  seeded model but Wan wants: it keeps the prediction payload small.
- `data_url` — inline the bytes as `data:image/webp;base64,…`. No upload, so
  nothing to clean up. Every stored Vesper image is webp, so the media type is a
  constant rather than something to sniff.

Inlining is bounded by `DATA_URL_BUDGET_BYTES` (6 MB of raw buffers ≈ 8 MB of
base64 — far above the 3 references × ~200 KB a real render sends). References
past the budget are dropped with an `image_model.references_trimmed` diagnostic
rather than failing the render, except that the anchor reference is always kept:
sending none would render a stranger, so the provider gets to be the one that
refuses.

**Not probeable.** Nothing in an OpenAPI schema distinguishes a wrapper that
resolves URLs itself from one that does not, so `reprobe` never touches this
column and new rows start at `file`. It is a fact learned by running the model,
recorded like the reference cap.

**Wan's other problem is not fixable here:** it has no `disable_safety_checker`
and its upstream moderates prompt *and* reference images
(`ContentModerationError: Content flagged for: sexual` on a benign prompt with an
ordinary character reference). The transport fix makes the model run; it does not
make it agreeable.

## Reference-capacity scaffold

`src/contracts/images/image-models.ts` (pure) exports
`referenceCapacity(model)` returning `{ max, arity, field }`, and
`fitReferences(model, refs)` returning the slice actually sendable.

Enforcement is central: `runRegistryImageModel` applies `fitReferences` to every
request, so no lane can send a one-reference model three images even by accident.
`routeSceneAttempts` and `attemptReferenceCount` read `referenceCapacity` to
decide how long a scene's degradation ladder is. The scene lane still gathers at
most three candidate buffers of its own before the capacity check narrows them
further; that positional trimming is what the capabilities plan's role-aware
selection replaces.

## Scene-picker busy bugs

Diagnosed 2026-08-05 from an owner report that switching the scene model failed
with a message about a generation still being in progress when none was. All
three fixes shipped.

**Cause.** The dropdown saves through `PATCH /api/chats/:chatId/state`, whose
first guard is `chatBusyResponse` (`src/app/api/chats/owned.ts`). That is a bare
`keyedLockBusy(chatExchangeLockKey(chatId))` check. The lock is held for the
whole exchange and released only in `streamExchange`'s `finally`, after `settle`
and `saveReplyFailure` — and the stream keeps draining after a client
disconnect by design (`src/server/api/stream.ts`), so the lock outlives the
browser's view of the exchange. The window itself is tracked as **B14** in
[chat-reply-latency.plan.md](chat-reply-latency.plan.md) and was not addressed
here.

1. **Gate the control.** `SceneStrip` (`src/components/characters/chat-scene-strip.tsx`)
   receives the conversation's `sending`
   flag and disables the model `Select` while it is true, with a title
   explaining why. The Generate button already had a comparable gate.
2. **Revert the optimistic write.** `saveSceneModel` in
   `src/components/chat/chat-conversation.tsx` sets local state before the
   PATCH and, on failure, used only to toast — leaving the dropdown showing a
   model the server never stored, which the next render silently contradicted
   because `queueChatScene` reads the model from the database. The failed branch
   now restores the previous value, guarded by the same generation counter that
   already protects against out-of-order saves.
3. **Name the real holder.** `chatBusyResponse` reads `keyedLockHolderLabel` and
   phrases by holder — reply versus world catch-up — matching the existing
   `chatBusyBounce` in `src/app/api/chats/[chatId]/sim-shared.ts`. Its copy also
   stopped saying "before changing the scene", which read as image generation on
   an image control.

## Testing

Pure tests that exist:

- `src/contracts/images/image-models.test.ts` — schema defaults and per-row
  isolation, `parseAspectValue` on both spellings, `chooseAspect` (exact match,
  closest-with-crop, largest exact pixel pair, non-portrait lane ratios, tie
  toward the wider option, empty menu), `referenceCapacity` / `fitReferences`,
  surface filtering, and `resolveImageModel` degradation.
- `src/server/ai/replicate-probe.test.ts` — field/arity/cap/aspect/format
  derivation, pinned-version probing, and the rejection paths.
- `src/server/ai/replicate.test.ts` — `buildRegistryModelInput`, per-call
  deadlines, the control-input overlay and its reserved fields, the inline
  reference transport and its budget, `replicatePredictionTarget`, and
  `runRegistryImageModel`.
- `src/server/ai/image-providers.test.ts` — attempt routing, reference counts,
  and failure classification including the billing case.

Gaps left open at ship, worth closing if this area is reopened: there is no test
for `cropToTargetAspect`'s geometry, none for `chatBusyResponse`'s holder
phrasing, and no integration test for the admin CRUD routes, their authz matrix,
or the migration's six seeded rows. Degradation tests assert both the fallback
and the diagnostic code, per [docs/testing.md](../testing.md).
