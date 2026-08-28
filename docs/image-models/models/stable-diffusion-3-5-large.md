# Stable Diffusion 3.5 Large

**Slug:** `stability-ai/stable-diffusion-3.5-large`
**Provenance:** probed 2026-08-05 against pinned version `2fdf9488b53c1e0fd3aef7b477def1c00d1856a38466733711f9c769942598f5`.

**Quality ruling:** no transitional runtime override

> A text-to-image model that generates high-resolution images with fine details.
> It supports varied artistic styles and diverse outputs.

Offered in the portrait studio only. Two provider details differ from the common
path: it has no 3:4 enum value, and it returns one URI string rather than an array.
The shared adapter handles both.

## Shape fallback

Its `aspect_ratio` enum is `16:9`, `1:1`, `21:9`, `2:3`, `3:2`, `4:5`, `5:4`,
`9:16`, `9:21` — no `3:4`.

Owner ruling 2026-08-05: request `4:5` and centre-crop to 3:4. `4:5` is closer to
the target than `2:3` and loses a smaller fraction of the frame. The generic
`chooseAspect` logic owns this; the model adapter has no SD-specific branch.

Other free-dimension models may also pass through post-crop after reviewed native
sizes are applied, so this is no longer described as the only model that uses the
crop path.

## Output shape

The output schema is `{"type": "string", "format": "uri"}` rather than an
array. The shared `outputUrl` helper accepts both forms.

## Not an identity-preserving editor

Its optional `image` input is classic strength-based image-to-image with
`prompt_strength`, provider-default `0.85`. The provider describes `1.0` as full
destruction of source information. At the default, a person may be substantially
repainted.

It therefore remains unavailable for normal variants, chat-look, and scenes even
though the schema makes it technically edit-capable.

The provider also ignores `aspect_ratio` when an input image is supplied, so a
future deliberate remix path must normalize after generation.

## Capabilities

- **Generate without a reference:** yes.
- **Edit from a reference:** technically yes, conventional img2img only.
- **Reference field:** `image`, one URI.
- **Reference cap:** 1.
- **Aspect handling:** request `4:5`, crop to 3:4 for portrait output.
- **Output:** one URI string; WebP available.

## Reviewed capability

- **Edit kind:** `img2img`;
- **Identity preservation:** `weak`;
- **Operator warning:** none.

The semantic rating makes identity-critical profiles ineligible even if a surface
toggle is changed later.

## Seeded profiles

- `portrait-standard` — `generate`, `text_to_image_description`, no references,
  empty controls, not the global default.
- `stylized-portrait-high-guidance` (Stylized Portrait High Guidance) — the
  deliberate stylization pick, runs only when picked: `guidance: 8` (the `cfg`
  field, provider range 1–10, default 5) plus a curated artifact-cleanup
  negative prompt (blur, low detail, JPEG artifacts, watermark/signature,
  deformed hands, extra fingers).

The curated controls map through the probed bindings (`cfg`,
`negative_prompt`): while the model row's `advancedCapabilities` is empty they
drop as recorded `no_binding`, and they take effect once the version is probed
or pinned. `portrait-standard` stays byte-identical for everyone who does not
choose the stylized profile.

## Negative-prompt ruling

The transitional render policy adds no `negative_prompt` field. Even on a
portrait surface, a generic cleanup block can conflict with requested printed
clothing, logos, blur, pixel-art media, unusual anatomy, or authored absences.

Negative terms are an opt-in curation instead:
`stylized-portrait-high-guidance` carries the one conflict-checked negative
block, chosen with the profile rather than imposed at the seam. The default
path remains byte-identical there.

## Inputs

- `prompt` — string, required.
- `image` — optional URI string.
- `prompt_strength` — number, default `0.85`, range 0–1.
- `aspect_ratio` — enum, provider-default `1:1`; no 3:4.
- `cfg` — number, default `5`, range 1–10.
- `negative_prompt` — string.
- `output_format` — enum, default `webp`.
- `seed` — integer.

There is no `disable_safety_checker` and no `output_quality` field.

## Output

`{"type": "string", "format": "uri"}`.

## Effective Vesper payload

```json
{
  "prompt": "<built prompt>",
  "aspect_ratio": "4:5",
  "output_format": "webp"
}
```

The returned 4:5 image is centre-cropped to 3:4 after download. No
`negative_prompt` key is added by the reviewed policy (`reviewed-profile-controls.ts`).
