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

`item-standard` and `location-standard` additionally carry an active **prompt
binding** (`qwen_2512_description` plus the seeded positive and negative pack
pair), so those two lanes compile their prompt from a world digest rather than
from a hand-written builder. `portrait-standard` and `chat-place-standard` do not
yet, and keep their existing prompt path.

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

**This endpoint ignores `negative_prompt`, so Vesper does not send one.**

The parameter exists in the Replicate schema and its provider default is empty,
but Qwen Image does not act on it. Vesper measured this directly: a render asked
for a red apple, with `red apple, apple` in the negative field, kept the apple in
16 of 16 paired renders across both the accelerated (`go_fast: true`) and
non-accelerated sampling paths. Upstream reporting gives the mechanism — the
model was not trained on negative conditioning, the parameter is present for
pipeline compatibility, and the official examples pass a single space.

The `qwen_2512_description` dialect therefore declares `negativeTransport:
"unsupported"`. Every exclusion the negative pack selects is dropped with the
reason `endpoint_ignores_negative_field` and recorded in provenance, so an
operator can still see what this render would have excluded on an endpoint that
could carry it. Probing or activating this row does not change that — the drop is
a dialect fact, not a missing control binding.

The positive channel is the only one that steers here. Exclusions that matter for
a render must be expressed as affirmative claims describing what the picture
should contain ([prompt-programs.md](../images/prompt-programs.md)).

This row still serves portraits, items, locations and chat-place images, so the
collision linter continues to matter for the positive side: a sign that must read
legibly and an android's correctly synthetic skin are still world facts a prompt
must not contradict.

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
