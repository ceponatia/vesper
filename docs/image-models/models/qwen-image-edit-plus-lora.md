# Qwen Image Edit Plus LoRA (2509 LoRA explorer)

**Slug:** `qwen/qwen-image-edit-plus-lora`
**Probed:** 2026-08-11, version
`b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`
**Provider latest rechecked:** 2026-08-24

> Qwen Image Edit 2509 LoRA explorer, uses Hugging Face URLs to load a custom
> safetensor.

This is Vesper's older, dedicated Qwen 2509 LoRA wrapper. It accepts a
user-supplied LoRA at runtime. Runtime-LoRA support on
[Qwen Image Edit 2511](qwen-image-edit-2511.md) is version-specific; that model
page is the canonical owner of the 2511 provider API state.

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

1. the production intimate-scene route currently pairs the resolved scene
   profile with this wrapper and a curated LoRA binding when the intimate staging
   trigger applies (`apps/web/src/server/images/scene-lora.ts`);
2. LoRA-focused Image Lab recipes can address it;
3. any registered/enabled row is selectable in the admin Image Generator for an
   ordinary supported run. LoRA bindings only determine whether that Generator
   run can expose and send a LoRA control.

It has no ordinary portrait/variant/scene profile row of its own. The intimate
route works by pairing the lane's existing scene profile with the wrapper model,
not by making this wrapper a normal player selection.

This matters when comparing output: the production intimate route swaps from
2511 to this older 2509-generation wrapper, whose reviewed identity rating is
weaker. The model swap itself can therefore reduce identity fidelity even when
the prompt and reference are otherwise unchanged.

## Capabilities

- **Generate without a reference:** no — `prompt` + `image` are required.
- **Edit from a reference:** yes; instruction editing, same family as 2511.
- **Reference field:** `image`, an array of URIs (JPEG, PNG, GIF, WebP).
- **Reference workflow:** 1–3 reference images. Vesper stores a cap of 3.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`; provider default
  `match_input_image`.
- **Runtime custom LoRA:** yes, one custom LoRA through
  `lora_weights`/`lora_scale`.
- **Output:** array of URIs; WebP available.

## LoRA support

Both fields are probe-derived into the row's `advancedCapabilities`
(`loraWeights`/`loraScale`) and the render path maps a **library-resolved** LoRA
onto them ([../images/providers.md](../images/providers.md) §"A LoRA is a curated
library row").

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
- Identity is a generation behind 2511; the current intimate route swaps the
  base model to obtain this wrapper's runtime LoRA path.
- The built-in Lightning fast path and the custom LoRA are separate controls;
  comparisons must keep `go_fast` constant or the A/B changes two things.
- Low-credit Replicate accounts may throttle prediction creation; classify those
  failures as transport/rate-limit problems rather than model-quality evidence.
