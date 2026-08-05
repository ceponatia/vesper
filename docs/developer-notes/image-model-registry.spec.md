# Image model registry — spec

Technical companion to [image-model-registry.plan.md](image-model-registry.plan.md).

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
[docs/image-models/](../image-models/).

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

**No model declares `maxItems` on its array reference input.** The reference cap
is therefore stored per row, not derived.

Shape control:

- `3:4` is present in the `aspect_ratio` enum for `qwen-image-edit-2511`,
  `seedream-4.5`, and `seedream-5-lite`.
- `stable-diffusion-3.5-large`'s `aspect_ratio` enum has no `3:4` — it offers
  `16:9 1:1 21:9 2:3 3:2 4:5 5:4 9:16 9:21`. Ruling 1 applies.
- `wan-2.7-image-pro` has **no `aspect_ratio` input at all**, only `size`, whose
  enum includes the exact-3:4 values `768*1024`, `1536*2048`, and `3072*4096`.

Output format: `webp` is available on `qwen-*` and `stable-diffusion-3.5-large`.
`seedream-5-lite` offers only `png` / `jpeg`. `seedream-4.5` and
`wan-2.7-image-pro` declare no `output_format` input. Anything that is not WebP
is converted after download by the existing sharp path.

## Data model

New table `image_models`, owned by `src/server/db/schema.ts`.

- `id` — text primary key, minted by `newId()`.
- `slug` — unique. The Replicate model path, optionally `owner/name:version`.
- `label` — display string for the pickers.
- `canGenerate` — boolean. True when the model can run with no reference.
- `canEdit` — boolean. True when the model has a reference input field.
- `referenceField` — the input key references are written to.
- `referenceArity` — `"single"` or `"array"`.
- `maxReferences` — integer. The stored cap (ruling: not derivable).
- `aspectMode` — `"aspect_ratio"`, `"size"`, or `"crop"`. How 3:4 is obtained.
- `aspectValue` — the literal value sent (`"3:4"`, `"1536*2048"`, `"4:5"`).
- `outputFormat` — nullable; omitted from the payload when null.
- `extraInput` — jsonb; per-model constants merged into the payload.
- `forPortrait` / `forVariant` / `forScene` — surface toggles.
- `builtin` — marks a seeded row for display only. Does **not** gate deletion
  (ruling 4).
- `sort`, `createdAt`.

Surface filters compose the capability flags with the toggles: the portrait
picker lists `canGenerate && forPortrait`; New Variant and the scene picker list
`canEdit && forVariant` / `canEdit && forScene`. A row whose flags and toggles
disagree is simply not offered — no error, no diagnostic.

## Capability probe

`GET https://api.replicate.com/v1/models/{owner}/{name}` →
`latest_version.openapi_schema.components.schemas.Input`. From it:

- `referenceField` — the first property whose type is `string` with
  `format: "uri"`, or an array whose `items` are such strings. Search order is
  fixed (`image`, `image_input`, `images`, then any other match) so a model with
  two image-ish inputs resolves deterministically.
- `referenceArity` — `"array"` when the property is an array, else `"single"`.
- `canEdit` — a reference field was found.
- `canGenerate` — the reference field is absent from the schema's `required`.
- `aspectMode` / `aspectValue` — `aspect_ratio` enum contains `3:4` ⇒
  `("aspect_ratio", "3:4")`; else a `size` enum contains a 3:4 pixel pair ⇒
  `("size", <that pair>)`; else the closest portrait `aspect_ratio` by absolute
  distance from 0.75 ⇒ `("crop", <that ratio>)`.
- `outputFormat` — `"webp"` when the enum offers it, else the first enum value,
  else null.

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
is a trust boundary: the response is parsed through a zod schema with `parseOr`,
and a probe that cannot find a prompt input fails the save with
`image_model.probe_failed` rather than writing a half-known row.

Probe failure is the ONE place this feature fails loudly instead of degrading —
writing a row we cannot render with would move the failure to render time, where
it costs a player-visible image instead of a form error.

## Render path

`src/server/ai/replicate.ts` gains `runRegistryModel(record, { prompt, references })`:

1. Upload each reference as a private Replicate file (existing
   `uploadReplicateFile`), capped at `min(references.length, maxReferences)`.
2. Build the payload: `prompt`, then `referenceField` set to the single URL or
   the URL array per `referenceArity` (omitted entirely when there are no
   references), then the aspect key per `aspectMode`, then `outputFormat` and
   `extraInput` when present.
3. Run and poll through the existing `runReplicateImageModel` shell — unchanged
   deadline, cancel-after, and download behaviour.
4. When `aspectMode === "crop"`, centre-crop the downloaded buffer to 3:4 before
   returning it.
5. Delete the uploaded files best-effort in `finally`, as today.

`src/server/ai/image-providers.ts` keeps its role as the capability seam but its
provider ids collapse to `demo` plus the registry: routing asks the record what
it can do rather than switching on a hardcoded provider id. `venice_*` ids and
`src/server/ai/venice.ts` are deleted outright, along with `VENICE_*` env.

## Reference-capacity scaffold

`src/contracts/images/image-models.ts` (pure) exports
`referenceCapacity(record)` returning `{ max, arity, field }`, and
`fitReferences(record, refs)` returning the slice actually sendable. Callers in
`src/server/images/*` use `fitReferences` instead of their current hardcoded
`slice(0, MAX_REFERENCES)`, so a one-reference model stops receiving three.

## Scene-picker busy bugs

Diagnosed 2026-08-05 from an owner report that switching the scene model failed
with a message about a generation still being in progress when none was.

**Cause.** The dropdown saves through `PATCH /api/chats/:chatId/state`, whose
first guard is `chatBusyResponse` (`src/app/api/chats/owned.ts`). That is a bare
`keyedLockBusy(chatExchangeLockKey(chatId))` check. The lock is held for the
whole exchange and released only in `streamExchange`'s `finally`, after `settle`
and `saveReplyFailure` — and the stream keeps draining after a client
disconnect by design (`src/server/api/stream.ts`), so the lock outlives the
browser's view of the exchange. The window itself is tracked as **B14** in
[chat-reply-latency.plan.md](chat-reply-latency.plan.md) and is not addressed
here.

Three fixes, all in code this change already touches:

1. **Gate the control.** `SceneStrip` receives the conversation's `sending`
   flag and disables the model `Select` while it is true, with a title
   explaining why. The Generate button already has a comparable gate.
2. **Revert the optimistic write.** `saveSceneModel` in
   `src/components/chat/chat-conversation.tsx` sets local state before the
   PATCH and, on failure, only toasts — leaving the dropdown showing a model the
   server never stored, which the next render silently contradicts because
   `queueChatScene` reads the model from the database. The failed branch now
   restores the previous value, guarded by the same generation counter that
   already protects against out-of-order saves.
3. **Name the real holder.** `chatBusyResponse` reads `keyedLockHolderLabel` and
   phrases by holder — reply versus world catch-up — matching the existing
   `chatBusyBounce` in `src/app/api/chats/[chatId]/sim-shared.ts`. Its copy also
   stops saying "before changing the scene", which read as image generation on
   an image control.

## Testing

Pure tests: the capability probe's field/arity/aspect derivation against
recorded schema fixtures for all six models; `referenceCapacity` and
`fitReferences`; the centre-crop geometry; `chatBusyResponse` holder phrasing.

Integration (`test:int`): the admin CRUD routes including the authz matrix
(non-admin is 404 under `/api/admin/self`), and the seed migration landing six
rows.

Degradation tests assert both the fallback and the diagnostic code, per
[docs/testing.md](../testing.md).
