# Stable Diffusion 3.5 Large

**Slug:** `stability-ai/stable-diffusion-3.5-large`
**Probed:** 2026-08-05, version `2fdf9488b53c1e0fd3aef7b477def1c00d1856a38466733711f9c769942598f5`

> A text-to-image model that generates high-resolution images with fine details.
> It supports various artistic styles and produces diverse outputs from the same
> prompt, thanks to Query-Key Normalization.

Offered in the **portrait studio only**. It is the awkward member of the set:
two of its properties disagree with assumptions the rest of the app makes.

## Two things that make this model special-cased

**It cannot produce 3:4.** Its `aspect_ratio` enum is `16:9 1:1 21:9 2:3 3:2 4:5
5:4 9:16 9:21` — no `3:4`. Owner ruling 2026-08-05: render at **`4:5`** and
centre-crop to 3:4. `4:5` is 0.80 against the target 0.75, losing about 6.25% of
the width; the alternative `2:3` is 0.667 and would lose about 11.1% of the
height. This is the only model in the set that needs the crop path.

**It returns a bare string, not an array.** Every other model's output schema is
an array of URIs; this one is `{"type": "string", "format": "uri"}`. The shared
`outputUrl` helper already accepts both shapes, so nothing special is needed —
but a future refactor that assumes arrays would break here first.

## Not an identity-preserving editor

Its `image` input is classic strength-based image-to-image: a single URI plus
`prompt_strength`, defaulting to `0.85`, documented as *"1.0 corresponds to full
destruction of information"*. At that strength the subject is substantially
repainted. This is exactly the failure mode behind the owner ruling of
2026-07-29 that kept text-to-image style swaps out of the scene picker — they
"painted a different-looking person". So while the model is technically
edit-capable, it is **not** enabled for the scene generator or New Variant.

The schema also notes `aspect_ratio` *"is ignored if you are using an input
image"*, which means the crop path is the only way to control shape when a
reference is supplied.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** technically yes, image-to-image only.
- **Reference field:** `image` — a single URI string.
- **Reference cap:** 1.
- **Aspect handling:** crop. Send `aspect_ratio: "4:5"`, centre-crop to 3:4.
- **Output:** a single URI **string**. WebP available.

## Reviewed capability

Reviewed by hand, never probed, and never overwritten by a re-probe:

- **Edit kind:** `img2img`. `image` + `prompt_strength` is strength-based
  repainting, as described above.
- **Identity preservation:** `weak` — the "painted a different-looking person"
  failure mode behind the 2026-07-29 owner ruling.
- **Operator warning:** none.

Because the row is portrait-only, the `weak` rating costs nothing today. What the
ratings add is a written rule where there was only an observation: a `weak`/`img2img`
model is refused for the identity-critical tasks (`variant`, `scene`, `chat_look`),
so a scene or variant profile cannot be added to this row without changing the
ratings first. Until the profile layer has a caller, the `for_scene`/`for_variant`
toggles are still what actually keeps it out of the scene generator and New Variant.

## Seeded profiles

One:

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references, empty control defaults, no timeout
  override. **Not** a global default (Qwen Image 2512 holds that).

No scene, variant or chat-look profile is seeded, per the plan. **Nothing calls the
profile layer yet** — the curated CFG/negative-prompt/seed portrait profiles the
plan describes are later work.

## Inputs

- `prompt` — string. **Required.**
- `image` — string, URI. Optional. Image-to-image source.
- `prompt_strength` — number, default `0.85`, range 0–1.
- `aspect_ratio` — enum, default `"1:1"`. Values: `16:9`, `1:1`, `21:9`, `2:3`,
  `3:2`, `4:5`, `5:4`, `9:16`, `9:21`.
- `cfg` — number, default `5`, range 1–10. Guidance scale.
- `negative_prompt` — string.
- `output_format` — enum, default `"webp"`. Values: `webp`, `jpg`, `png`.
- `seed` — integer.

There is **no `disable_safety_checker`** and no `output_quality`.

## Output

`{"type": "string", "format": "uri"}` — a single URL, not a list.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "aspect_ratio": "4:5",
  "output_format": "webp"
}
```

The returned 4:5 image is centre-cropped to 3:4 after download.
