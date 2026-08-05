# FLUX.1 [dev]

**Slug:** `black-forest-labs/flux-dev`
**Probed:** 2026-08-05, version `6e4a938f85952bdabcc15aa329178c4d681c52bf25a0342403287dc26944661d`

> A 12 billion parameter rectified flow transformer capable of generating images
> from text descriptions

Black Forest Labs' open-weight FLUX, run on Replicate's own GPUs rather than
proxied to BFL's API. That distinction is the point of adding it: the hosted
`flux-1.1-pro` and `flux-kontext-pro` endpoints expose only `safety_tolerance`
(a 1–6 dial that BFL caps lower when an input image is present), while this one
exposes a real `disable_safety_checker`. Offered for portraits.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** img2img only — see below. Not identity-preserving.
- **Reference field:** `image` — a single URI.
- **Reference cap:** 1.
- **Aspect handling:** `aspect_ratio` enum including `3:4`. Send `"3:4"`.
- **Output:** array of URIs.

## Its reference input is strength-based repainting

Like [Stable Diffusion 3.5 Large](stable-diffusion-3-5-large.md), the `image`
input is img2img: the reference is noised to `prompt_strength` and repainted, so
it steers colour and composition but does not carry a face. It cannot hold a
character's identity across a scene the way
[Qwen Image Edit 2511](qwen-image-edit-2511.md) or
[RealVis Hyper LoRA](realvis-hyper-lora.md) can. That is why the row is offered
for portraits and not for scenes.

Two behaviours change when `image` is present:

- `aspect_ratio` stops applying — *"The aspect ratio of your output will match
  this image"*. Vesper's stored references are already 3:4, so the shape lands
  where it should anyway.
- `prompt_strength` becomes live. Default `0.8`; *"1.0 corresponds to full
  destruction of information in image"*.

## Safety checker

`disable_safety_checker` (default `false`) removes the post-generation NSFW
classifier that otherwise blanks outputs. Vesper sets it from the inverted
`REPLICATE_SAFE_MODE` env like every other model that has the input.

Worth being precise about what that buys: the flag removes the *classifier*, not
the model's own training. FLUX dev was trained conservatively, so disabling the
checker stops false refusals rather than making the model produce what it was
never taught to draw.

## Inputs

- `prompt` — string. **Required.**
- `aspect_ratio` — enum, default `"1:1"`. Values: `1:1`, `16:9`, `21:9`, `3:2`,
  `2:3`, `4:5`, `5:4`, `3:4`, `4:3`, `9:16`, `9:21`.
- `image` — URI string. Img2img mode; overrides `aspect_ratio`.
- `prompt_strength` — number, default `0.8`, range 0–1. Img2img only.
- `num_outputs` — integer, default `1`, range 1–4.
- `num_inference_steps` — integer, default `28`, range 1–50. *"Recommended range
  is 28-50."*
- `guidance` — number, default `3`, range 0–10.
- `seed` — integer.
- `output_format` — enum, default `"webp"`. Values: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `80`, range 0–100. Ignored for png.
- `disable_safety_checker` — boolean, default `false`.
- `go_fast` — boolean, default `true`. fp8-quantized fast path; *"outputs will
  not be deterministic"* when on.
- `megapixels` — enum, default `"1"`. Values: `1`, `0.25`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": true,
  "num_outputs": 1,
  "disable_safety_checker": true
}
```

With a reference, add `"image": "<single url>"` — sent as an uploaded file URL
(`reference_transport = 'file'`, the default).

`prompt_strength`, `guidance`, `num_inference_steps` and `megapixels` are left at
their defaults today. They are the obvious per-model knobs to expose when the
registry grows beyond prompt + reference.
