# Qwen Image 2512

**Slug:** `qwen/qwen-image-2512`
**Probed:** 2026-08-05, version `47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6`
**Quality ruling:** 2026-08-05

> Qwen Image 2512 is an improved version of Qwen Image with more realistic human
> generation, finer textures, and stronger text rendering.

Vesper's default for a brand-new portrait. It is primarily a text-to-image model;
its optional reference input is strength-based image-to-image, not the
identity-preserving instruction edit performed by
[Qwen Image Edit 2511](qwen-image-edit-2511.md).

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, image-to-image via `strength`.
- **Reference field:** `image`, a single URI string.
- **Reference cap:** 1.
- **Aspect handling:** `aspect_ratio` includes `3:4`.
- **Output:** array of URIs; WebP available.

## Reviewed capability

Reviewed by hand and never overwritten by a schema probe:

- **Edit kind:** `img2img`;
- **Identity preservation:** `weak` at the default repaint strength;
- **Operator warning:** none.

The row is offered for generation surfaces today. If a future profile tries to
use it for an identity-critical variant or scene, the `weak`/`img2img` semantic
rating makes that profile ineligible. A deliberate remix workflow is the correct
future use of its `strength` control.

## Seeded profiles

Four dormant `generate` profiles use the `text_to_image_description` strategy:

- `portrait-standard`;
- `item-standard`;
- `location-standard`;
- `chat-place-standard`.

They reproduce current model selection but do not yet provide controls. Nothing
calls the profile layer yet.

## Quality policy before profiles are wired

The provider exposes `negative_prompt` with an effectively empty default. The
shared render seam adds Vesper's style-neutral anatomy/production negative:

```text
extra limbs, extra arms, extra legs, malformed limbs, disconnected limbs,
extra fingers, missing fingers, fused fingers, mutated hands, poorly drawn
hands, bad anatomy, disfigured, text, watermark, signature, logo, blurry,
low resolution
```

The block intentionally does not forbid illustration/cartoon media, multiple
people, or close framing. Those terms need task and style context and belong in
profiles once they reach the render path.

`go_fast` remains `true` for new text-to-image generation. Qwen Edit, not this
model, receives the identity-quality fast-mode override.

## Reference-image caveat

When `image` is supplied the output follows the reference image's aspect. An
`aspect_ratio` sent alongside the reference may therefore be advisory. Stored
Vesper references are normally already normalized, but a future remix workflow
must validate the source shape.

`strength` defaults to `0.8`; the provider describes `1.0` as full destruction of
source information. The default substantially repaints the reference.

## Inputs

- `prompt` — string, required.
- `image` — optional URI string for image-to-image.
- `strength` — number, default `0.8`, range 0–1.
- `aspect_ratio` — enum, provider default `16:9`; includes `3:4` and custom
  width/height mode.
- `width` / `height` — integer, 256–2048, multiples of 16, custom aspect only.
- `guidance` — number, default `4`, range 0–10.
- `num_inference_steps` — integer, default `40`, range 20–50.
- `negative_prompt` — string, provider default blank.
- `go_fast` — boolean, default `true`.
- `output_format` — enum, default `webp`.
- `output_quality` — integer, default `95`.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Effective Vesper payload

```json
{
  "prompt": "<built prompt>",
  "negative_prompt": "extra limbs, extra arms, extra legs, malformed limbs, disconnected limbs, extra fingers, missing fingers, fused fingers, mutated hands, poorly drawn hands, bad anatomy, disfigured, text, watermark, signature, logo, blurry, low resolution",
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": true,
  "disable_safety_checker": true
}
```

With a reference, add `"image": "<single url>"`. The negative is supplied by
`src/server/images/quality-presets.ts` until task profiles own it.
