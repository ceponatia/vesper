# Qwen Image Edit Plus LoRA (2509 LoRA explorer)

**Slug:** `qwen/qwen-image-edit-plus-lora`
**Provenance:** probed 2026-08-11 against pinned version `b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`.

> Qwen Image Edit 2509 LoRA explorer, uses Hugging Face URLs to load a custom
> safetensor.

This is Vesper's older, dedicated Qwen 2509 LoRA wrapper. It accepts a
user-supplied LoRA at runtime. No production route runs on it: it is a legacy
comparison endpoint, addressable from the Image Lab and the Image Generator.
Runtime-LoRA support on [Qwen Image Edit 2511](qwen-image-edit-2511.md) is
version-specific; that model page is the canonical owner of the 2511 provider
API state.

## The built-in adapter is not the custom LoRA

The provider's fast path uses a built-in **Lightning** adapter/optimization.
That is separate from the custom LoRA named by `lora_weights`:

- `go_fast: true` uses the Lightning fast path and, when supplied, blends in the
  custom LoRA;
- `go_fast: false` removes the Lightning path; if a custom LoRA is supplied it
  runs without Lightning, and if `lora_weights` is blank the run is the base
  2509 editor;
- leaving `lora_weights` blank therefore does **not** mean “use Vesper's NSFW
  LoRA because it is built in.” It means no custom LoRA was supplied.

This is why provider prediction input is the authoritative proof that a custom
LoRA actually ran. Vesper metadata recording a selected LoRA proves routing
intent, not by itself that Replicate received `lora_weights`.

## Role in Vesper

This wrapper is deliberately **off ordinary player profile pickers**, but it is
not unreachable:

1. LoRA-focused Image Lab recipes can address it directly;
2. any registered/enabled row is selectable in the admin Image Generator for an
   ordinary supported run. LoRA bindings only determine whether that Generator
   run can expose and send a LoRA control.

It has no ordinary portrait/variant/scene profile row of its own, and no
production route runs on it: the intimate-scene route
(`apps/web/src/server/images/scene-lora.ts`) and the anatomy bench pair their
picked profile with [Qwen Image Edit 2511](qwen-image-edit-2511.md) instead.

This matters when comparing output: this older 2509-generation wrapper's
reviewed identity rating is weaker than 2511's. A render on this endpoint is
useful as a legacy comparison arm, not as evidence about the production
intimate route or the anatomy bench, both of which run on 2511.

## Capabilities

- **Generate without a reference:** no — `prompt` + `image` are required.
- **Edit from a reference:** yes; instruction editing, same family as 2511.
- **Reference field:** `image`, an array of URIs (JPEG, PNG, GIF, WebP).
- **Reference workflow:** 1–3 reference images. Vesper stores a cap of 3.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`; provider default
  `match_input_image`.
- **Runtime custom LoRA:** yes, one custom LoRA through
  `lora_weights`/`lora_scale`.
- **Accelerated sampling:** yes — `go_fast`, provider default `true`, reachable
  as the normalized `fastMode` control. On this wrapper it is also the Lightning
  switch described above, so a comparison run has to hold it constant.
- **Output:** array of URIs; WebP available.

## LoRA support

Both fields are probe-derived into the row's `advancedCapabilities`
(`loraWeights`/`loraScale`) and the render path maps a **library-resolved** LoRA
onto them ([loras.md](../../images/providers/loras.md) — a LoRA is a curated
library row, never a raw locator on a request).

- `lora_weights` — string. Prefer a Hugging Face repo slug (`owner/model`) or a
  direct `.safetensors` URL. **Blank means run without a custom LoRA.** A
  no-LoRA arm on this same endpoint is useful for A/B work because both arms can
  share the same model/version.
- `lora_scale` — number, 0–4, provider default 1. The library row's curated band
  can narrow this range per LoRA; a scale outside either range is refused before
  the provider is called.

For Vesper's curated library, a Hugging Face repo slug is the preferred locator.
It is stable, credential-free in the stored row, and matches the provider's
advertised loader contract. Do not rely on a Civitai API URL shape or an
expiring/query-token URL when a HF repository can host the same safetensors.

The provider fetches the weights at prediction time. The library validates a
locator's **shape and compatibility contract**, not that the remote bytes exist
or are compatible with this checkpoint. A well-formed locator pointing at a
missing or incompatible file still fails at provider time.

## Reviewed capability

- **Edit kind:** `instruction_edit`;
- **Identity preservation:** `moderate` — the 2509 generation is documented and
  observed as weaker at identity than 2511;
- **Operator warning:** none.

The `moderate` rating records that the wrapper remains usable for identity work
while acknowledging the step down from 2511.

## Inputs

- `prompt` — string, required. An edit instruction.
- `image` — array of URI strings, required.
- `lora_weights` — string, default `""` (no custom LoRA).
- `lora_scale` — number, default `1`, range 0–4.
- `aspect_ratio` — enum, default `"match_input_image"`: `1:1`, `16:9`, `9:16`,
  `4:3`, `3:4`, `match_input_image`.
- `go_fast` — boolean, default `true`. No 2511-style reviewed quality overlay is
  guaranteed merely by using this wrapper; inspect the final effective request.
- `output_format` — enum, default `"webp"`: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Verifying that the custom LoRA actually ran

For a live render, inspect both layers:

- **Vesper provenance:** selected wrapper/version and the curated LoRA id/scale
  show what Vesper intended to route;
- **Replicate prediction input:** `lora_weights` and `lora_scale` show what the
  provider actually received.

Do not use `images.meta.lora` alone as provider-payload proof. A route can record
its intent before a later transport/version mismatch prevents the field from
reaching Replicate.

## Known limitations

- One custom LoRA per prediction.
- Identity is a generation behind 2511; the production intimate route and the
  anatomy bench run on 2511's own runtime LoRA path instead, so this wrapper is
  reached only as a deliberate legacy comparison arm.
- The built-in Lightning fast path and the custom LoRA are separate controls;
  comparisons must keep `go_fast` constant or the A/B changes two things.
- Low-credit Replicate accounts may throttle prediction creation; classify those
  failures as transport/rate-limit problems rather than model-quality evidence.
