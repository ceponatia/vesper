# Qwen Image 2512

**Slug:** `qwen/qwen-image-2512`
**Probed:** 2026-08-05, version `47c060e80055269a615f9636df2d51fd50239dc439f5ecde465a7d513a0abda6`

> Qwen Image 2512 is an improved version of Qwen Image with more realistic human
> generation, finer textures, and stronger text rendering.

Vesper's **default for a brand-new portrait**. It is primarily a text-to-image
model; its reference input is strength-based image-to-image, not the
identity-preserving edit that its sibling
[Qwen Image Edit 2511](qwen-image-edit-2511.md) performs. Use the sibling when
the character's face has to survive.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, image-to-image via `strength`.
- **Reference field:** `image` — a single URI string, not an array.
- **Reference cap:** 1.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`. Send `"3:4"`.
- **Output:** array of URIs. WebP available.

## Reviewed capability

Reviewed by hand, never probed, and never overwritten by a re-probe:

- **Edit kind:** `img2img`. The optional `image` + `strength` pair is conventional
  strength-based repainting, not identity-preserving editing.
- **Identity preservation:** `weak`. At the default `strength: 0.8` the source is
  substantially repainted, so the subject can come back as a different person.
- **Operator warning:** none.

The ratings cost nothing today: this row is offered on portrait surfaces only. They
matter if that changes — a `weak`/`img2img` model is refused outright for the
identity-critical tasks (`variant`, `scene`, `chat_look`), so a scene profile added
to this row would not resolve. A deliberate remix profile on a non-identity task is
the intended use of its `strength` input.

## Seeded profiles

Four, all `generate` with the `text_to_image_description` prompt strategy, an empty
reference policy, empty control defaults, and no timeout override. Each is its
task's **global default** and reproduces what its lane resolves today:

- `portrait-standard` (Portrait Standard) — task `portrait`.
- `item-standard` (Item Standard) — task `item`.
- `location-standard` (Location Standard) — task `location`.
- `chat-place-standard` (Chat Place Standard) — task `chat_place`.

`item`, `location` and `chat_place` have no picker of their own: those lanes resolve
the portrait surface's default today, which is why their profiles are seeded here
and on no other model. **Nothing calls the profile layer yet** — the fast/balanced/
quality and remix profiles the plan describes are later work.

## Reference-image caveat

When `image` is supplied the model states: *"The aspect ratio of your output
will match this image."* Any `aspect_ratio` sent alongside a reference is
therefore advisory at best. Because every stored Vesper image is already 3:4,
this is harmless in practice — but it means the aspect setting cannot be relied
on to correct a non-3:4 reference.

`strength` defaults to `0.8`, described as *"1.0 corresponds to full destruction
of information in image"*. At the default the source is heavily repainted.

## Inputs

- `prompt` — string. **Required.**
- `image` — string, URI. Optional. Image-to-image source.
- `strength` — number, default `0.8`, range 0–1. Image-to-image denoising.
- `aspect_ratio` — enum, default `"16:9"`. Values: `1:1`, `16:9`, `9:16`, `4:3`,
  `3:4`, plus `custom`-style width/height handling below.
- `width` / `height` — integer, 256–2048, multiples of 16. Only when
  `aspect_ratio=custom`.
- `guidance` — number, default `4`, range 0–10. Prompt adherence.
- `num_inference_steps` — integer, default `40`, range 20–50.
- `negative_prompt` — string, default `" "`.
- `go_fast` — boolean, default `true`. Speed optimizations.
- `output_format` — enum, default `"webp"`. Values: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

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
  "disable_safety_checker": true
}
```

With a reference, add `"image": "<single url>"`. Note the app inverts
`REPLICATE_SAFE_MODE` into `disable_safety_checker`.
