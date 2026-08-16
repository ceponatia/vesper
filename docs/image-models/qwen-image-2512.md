# Qwen Image 2512

**Slug:** `qwen/qwen-image-2512`
**Probed:** 2026-08-05, version `47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6`
**Quality ruling:** no transitional runtime override

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

Four `generate` profiles use the `text_to_image_description` strategy, and each
is its task's global default ([providers.md](../images/providers.md)):

- `portrait-standard`;
- `item-standard`;
- `location-standard`;
- `chat-place-standard`.

All four carry empty control defaults, so resolving one reproduces the payload
below.

Two curated portrait profiles trade speed against detail. Neither is a default;
each runs only when picked:

- `portrait-fast` — `steps: 28`, down from the provider's 40, for a cheaper
  everyday render. `go_fast` is already `true` in the row's `extra_input`, so no
  override is needed.
- `portrait-quality` — `steps: 50`, the ceiling, plus a `go_fast: false`
  provider override — the raw boolean has no normalized control, so the override
  is the only reach.

The `steps` defaults map through the version's probed control bindings: while
the model row's `advancedCapabilities` is empty they drop as recorded
`no_binding`, and they take effect once the version is probed or pinned. The
`go_fast` override is refused fail-closed until the probe writes
`knownInputFields`.

## Negative-prompt ruling

The provider's `negative_prompt` default is empty. The transitional shared render
seam leaves it empty and does not invent a generic block.

This model serves portraits, items, locations, and chat-place images. Terms that
look like universal cleanup are not actually universal here: signs and clothing
may require text or logos, motion blur may be requested, and low-resolution media
may be an intentional style. Anatomy terms also require the character's intended
morphology.

Task/style/morphology-aware profiles may add conflict-checked negative steering
later. Until then, Qwen Image 2512 remains byte-identical at the quality-policy
seam.

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
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": true,
  "disable_safety_checker": true
}
```

With a reference, add `"image": "<single url>"`. No `negative_prompt` key is
added by the reviewed policy (`reviewed-profile-controls.ts`).
