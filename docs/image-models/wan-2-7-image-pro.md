# Wan 2.7 Image Pro

**Slug:** `wan-video/wan-2.7-image-pro`
**Probed:** 2026-08-05, version `d880bad3fb109170221d7c233c4665bab6ba83d01936f3c9b1389de6ed2a82ed`

> Generate and edit high-quality images with Alibaba's Wan 2.7 Pro with 4K
> output, thinking mode, text-to-image, multi-image editing, and image set
> generation.

A multi-reference alternative for scenes. Not a Vesper default. Two things make
it unlike every other model in the set: it will not accept Replicate's own
uploaded-file URLs (see below), and its upstream moderation cannot be turned
off.

## References must be inlined, not uploaded

Wan is the reason the registry has a `reference_transport` column. Its wrapper
proxies Alibaba's async API and validates the **file extension** of whatever it
is handed; a Replicate files-API URL arrives at the model container without one,
and the prediction fails:

```
ValueError: Invalid image format ''. Supported formats: .bmp, .jpeg, .jpg, .png, .webp
```

This is not a missing input — the payload matches the schema exactly. Reproduced
against the live model on 2026-08-05 with one reference, holding everything else
constant:

- `https://api.replicate.com/v1/files/<id>.webp` — fails with
  `Invalid image format ''`.
- `data:image/webp;base64,…` — accepted; reaches the upstream model.

Note the upload URL *does* end in `.webp` — the extension is lost somewhere
between Replicate's file store and the model container, so no amount of naming
the upload fixes it. Vesper therefore stores `reference_transport = 'data_url'`
for this row and inlines the bytes (`server/ai/replicate.ts`). Every other model
in the set resolves the upload URL fine and keeps the smaller payload.

## Moderation cannot be disabled

There is no `disable_safety_checker` input, and the upstream API moderates both
prompt and reference images:

```
ContentModerationError: Content flagged for: sexual
```

That was a benign prompt with an ordinary Vesper character reference. Expect this
model to refuse a substantial share of scene renders regardless of prompt
wording; the failure surfaces as a `content_rejection` and the render fails
rather than falling to another model (one model runs the whole chain).

## No aspect ratio input at all

This is the only model in the set with **no `aspect_ratio` field**. Shape comes
from `size`, whose enum mixes preset tiers with explicit pixel pairs:

`1K` `2K` `4K` `1024*1024` `2048*2048` `4096*4096` `1280*720` `720*1280`
`2048*1152` `1152*2048` `4096*2304` `2304*4096` `1024*768` `768*1024`
`2048*1536` `1536*2048` `4096*3072` `3072*4096`

Three of those are exactly 3:4 — `768*1024`, `1536*2048`, and `3072*4096`.
Vesper sends **`1536*2048`**, the 2K-tier 3:4 pair, matching the resolution the
other models produce.

Note the separator is an asterisk (`1536*2048`), not the `x` or `×` used by most
APIs.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, multi-reference list.
- **Reference field:** `images` — an array of URIs, default `[]`. Plural, unlike
  every other model in the set.
- **Reference cap:** **9.** No `maxItems`; the description states *"up to 9
  images, jpg/png/bmp/webp"*.
- **Aspect handling:** `size` with an explicit pixel pair. Send `"1536*2048"`.
- **Output:** array of URIs.

## Reviewed capability

Reviewed by hand, never probed, and never overwritten by a re-probe:

- **Edit kind:** `multi_reference_compose` — a genuine reference list (up to 9),
  not strength-based repainting.
- **Identity preservation:** `unknown`, and deliberately so: moderation refuses
  ordinary character references before there is an output to judge, so nobody can
  yet say whether a face survives. `unknown` is permissive, so its variant and scene
  profiles remain eligible — a rating nobody has written must not disable a model
  that works today.
- **Operator warning:** *"Upstream moderation cannot be disabled and has refused
  ordinary character references."* The first and only use of `operator_warning`;
  it is destined for the admin model card and the model pickers, and **no surface
  renders it yet**. It is a caveat, not a failure class — a refused render still
  surfaces as `content_rejection` and fails the row rather than hopping to another
  model.

## Seeded profiles

Three, none of them a default, all with empty control defaults and no timeout
override:

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references.
- `variant-standard` (Variant Standard) — task `variant`, `edit`,
  `instruction_edit`, `identity` required and `style` allowed.
- `scene-standard` (Scene Standard) — task `scene`, `edit`, `instruction_edit`,
  identity → location → style → object with nothing required.

The seeded profiles carry **no** `provider_overrides` and no separate
generate-versus-edit settings: today both paths share one payload shape, and the
`reference_transport = 'data_url'` fact stays on the model row where the transport
layer already reads it. **Nothing calls the profile layer yet** — the split
thinking-mode generation, 4K, and coherent-image-set profiles the plan describes are
later work, and no profile will ever claim to bypass moderation.

## Behaviour that changes when references are present

Two inputs quietly stop applying in edit mode:

- `size` — the preset tiers `1K`/`2K`/`4K` *"auto-size based on input images"*,
  and 4K is *"only available for text-to-image"*. Sending an explicit pixel pair
  rather than a tier avoids depending on that inference.
- `thinking_mode` — defaults to `true` but *"only applies to text-to-image (no
  input images...)"*. It is left at its default; it simply has no effect on the
  edit path.

## No output format control

Like [Seedream 4.5](seedream-4-5.md), this model declares no `output_format`
input. Conversion to WebP happens after download.

## Inputs

- `prompt` — string. **Required.**
- `images` — array of URI strings, default `[]`.
- `size` — enum, default `"2K"`. See the list above.
- `num_outputs` — integer, default `1`, range 1–4 *"(1-12 for image set mode)"*.
- `image_set_mode` — boolean, default `false`. *"Generate a coherent set of
  related images from a single prompt."* Leave false.
- `thinking_mode` — boolean, default `true`. Text-to-image only.
- `seed` — integer, range 0–2147483647.

There is **no `disable_safety_checker`** and no `output_format`.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "images": ["data:image/webp;base64,<bytes 1>", "data:image/webp;base64,<bytes 2>"],
  "size": "1536*2048",
  "num_outputs": 1,
  "image_set_mode": false
}
```

The `images` entries are inlined data URIs rather than uploaded-file URLs — see
"References must be inlined" above. This is the only model in the set that is
sent references this way.
