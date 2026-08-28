# Pruna P-Image

**Slug:** `prunaai/p-image`
**Provenance:** probed 2026-08-11 against pinned version `79bbabc34e1dc2c55b09a5a8a220d7792f77234c5aded9b074bdf6bf783a2f65`.

**Quality ruling:** no transitional runtime override

> A sub 1 second text-to-image model built for production use cases.

`is_official` is true, so the row is registered under the bare slug rather
than pinned to a version — the only model in this four-doc batch where that
is so. It runs through Replicate's official bare-slug endpoint and tracks
whatever `latest_version` resolves to; a future Replicate-side update changes
this row's behavior without a Vesper deploy or a re-probe.

Lifetime run count on Replicate is 16,251,435 — by far the most exercised
model in the registry, and the speed and cost baseline of this batch.

## Capabilities

- **Generate without a reference:** yes. `prompt` is the only required input.
- **Edit from a reference:** no. `lora_weights` is a plain string, not a
  reference image, and there is no URI-typed input anywhere in the schema.
- **Reference cap:** 0.
- **Aspect handling:** `aspect_ratio` enum, including `3:4`. Send `"3:4"`.
- **Output:** a bare URI string, not an array.

## Native 3:4 — no crop needed

`aspect_ratio` defaults to `16:9` but its enum includes `1:1`, `16:9`,
`9:16`, `4:3`, `3:4`, `3:2`, `2:3`, and `custom`. Vesper sends `"3:4"`
directly — the only model in this batch with a native aspect input, so no
reviewed width/height override and no post-download crop are needed.
`custom` carries no ratio of its own and is filtered out of the model's
`supportedAspects`; `width`/`height` are only read when `aspect_ratio` is
`custom`, so Vesper never sends them.

## Bare-string output

The output schema is `{"type": "string", "format": "uri"}` rather than an
array — the only other model in the registry with this shape is
[Stable Diffusion 3.5 Large](stable-diffusion-3-5-large.md). The shared
`outputUrl` helper accepts both forms.

## Safety checker

`disable_safety_checker` (provider default `false`) is declared, so the probe
pins it and the render path overrides its value from the inverted
`REPLICATE_SAFE_MODE` env, the same as every other model that has this input.

## LoRA support

`lora_weights` (a HuggingFace LoRA URL in the form
`huggingface.co/<owner>/<model-name>[/<file.safetensors>]`) and `lora_scale`
(default `0.5`) are the model's own inputs. Vesper sends neither — no LoRA is
configured on the seeded row. Which checkpoint to pin, and whether its
license permits hosted commercial use, is an owner decision that has not been
made, and the registry's `advanced_capabilities` LoRA bindings are `{}` and
unwritten. A LoRA selection today would have to be a per-model constant.

## Reviewed capability

- **Edit kind:** `none` — no image input exists to rate.
- **Identity preservation:** `unknown`.
- **Operator warning:** *"Sub-second generation, the speed and cost baseline.
  No LoRA is configured on this row; its lora_weights input is unused."*
  Descriptive context for the admin card, not a moderation or reliability
  caveat; no surface renders it yet.

## Seeded profiles

One, not the global default:

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references.

Every render resolves a profile, so picking this model for a new portrait
resolves this row.

## Inputs

- `prompt` — string. **Required.**
- `aspect_ratio` — enum, default `16:9`. Values: `1:1`, `16:9`, `9:16`,
  `4:3`, `3:4`, `3:2`, `2:3`, `custom`.
- `width` / `height` — integers, multiples of 16. Read only when
  `aspect_ratio` is `custom`.
- `seed` — integer.
- `lora_weights` — string. HuggingFace LoRA URL,
  `huggingface.co/<owner>/<model-name>[/<file.safetensors>]`.
- `lora_scale` — number, default `0.5`.
- `hf_api_token` — password string, for gated LoRA repos.
- `prompt_upsampling` — boolean, default `false`. Upsamples the prompt with
  an LLM.
- `disable_safety_checker` — boolean, default `false`.

There is no `negative_prompt` or `output_format` input.

## Output

`{"type": "string", "format": "uri"}`.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "aspect_ratio": "3:4",
  "disable_safety_checker": true
}
```

No `lora_weights`, `lora_scale`, `width`, or `height` key is sent — the model
takes its native `3:4` path and no LoRA is configured. At sub-second
generation and the highest run count of any model in the registry, this is
the batch's speed and cost baseline.
