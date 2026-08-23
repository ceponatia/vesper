# Qwen Image Edit Plus LoRA (2509 LoRA explorer)

**Slug:** `qwen/qwen-image-edit-plus-lora`
**Probed:** 2026-08-11, version
`b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200`

> Qwen Image Edit 2509 LoRA explorer, uses HuggingFace URLs to load any
> safetensor.

The one Qwen edit endpoint that accepts a user-supplied LoRA, and therefore the
Advanced Image Lab's **LoRA finishing connector**
([../image-lab/](../image-lab/README.md)). Neither
[Qwen Image Edit 2511](qwen-image-edit-2511.md) nor Qwen Image Edit Plus
exposes any LoRA input — 2511's model-card phrase "integrated LoRAs" describes
acceleration baked into its weights, not a loadable input — so LoRA work runs
here, on the older 2509-generation checkpoint, and nowhere else.

## Role in Vesper

Registered by admin, deliberately **off every player surface**: no portrait,
variant, or scene toggle, and no profile rows, so no picker offers it and no
stored selection can resolve to it. The lab reaches it by slug on
LoRA-carrying recipe runs. Expect its renders to differ from 2511's in two ways
beyond the LoRA itself: it is a generation older (identity documented weaker),
and no reviewed quality overlay exists for this row, so `go_fast` rides the
provider default `true` where 2511's overlay forces `false`. Comparison arms on
this model should therefore be compared with each other first.

## Capabilities

- **Generate without a reference:** no — `required: ["prompt", "image"]`.
- **Edit from a reference:** yes; instruction editing, same family as 2511.
- **Reference field:** `image`, an array of URIs (JPEG, PNG, GIF, WebP).
- **Reference workflow:** 1–3 reference images. Vesper stores a cap of 3.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`; provider default
  `match_input_image`.
- **Output:** array of URIs; WebP available.

## LoRA support

The reason this row exists. Both fields are probe-derived into the row's
`advancedCapabilities` (`loraWeights`/`loraScale`) — the first registered model
whose bindings are non-empty — and the render path maps a **library-resolved**
LoRA onto them ([../images/providers.md](../images/providers.md) §"A LoRA is a
curated library row").

- `lora_weights` — string. A Hugging Face repo slug (`owner/model`) or a direct
  `.safetensors`/zip/tar URL. **Blank means "run without a LoRA"**, which is
  what makes this endpoint its own no-LoRA comparison arm: both arms of a LoRA
  trial run the same model at the same pin, so the LoRA's contribution is not
  confounded with a model change.
- `lora_scale` — number, 0–4, provider default 1. "Strength applied to the
  selected LoRA." The library row's curated band narrows this range per LoRA;
  a scale outside either range is refused before the provider is called.

The provider fetches the weights at prediction time. The library validates a
locator's **shape**, not its existence — a well-formed locator pointing at a
missing or incompatible file fails at the provider, at spend time, classified
like any other render failure.

## Reviewed capability

- **Edit kind:** `instruction_edit`;
- **Identity preservation:** `moderate` — the 2509 generation is documented as
  weaker at identity than 2511; `moderate` keeps it eligible for the lab's
  identity-critical finishing recipe while recording the step down;
- **Operator warning:** none.

## Inputs

- `prompt` — string, required. An edit instruction.
- `image` — array of URI strings, required.
- `lora_weights` — string, default `""` (no LoRA).
- `lora_scale` — number, default `1`, range 0–4.
- `aspect_ratio` — enum, default `"match_input_image"`: `1:1`, `16:9`, `9:16`,
  `4:3`, `3:4`, `match_input_image`.
- `go_fast` — boolean, default `true`. No Vesper overlay for this row.
- `output_format` — enum, default `"webp"`: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Known limitations

- One LoRA per prediction — no second `extra_lora_*` pair, unlike
  `qwen/qwen-image` (whose img2img edit mode keeps it out of identity work).
- Identity is a generation behind 2511; a finishing pass here trades identity
  strength for LoRA access.
- Low-credit Replicate accounts are throttled to a burst of **one** prediction
  create per ~10s window; concurrent lab arms against this (or any) model can
  fail `transient` at create with a 429 and should be fired sequentially.
