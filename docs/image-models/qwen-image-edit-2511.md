# Qwen Image Edit 2511

**Slug:** `qwen/qwen-image-edit-2511`
**Probed:** 2026-08-05, version `a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729`

> An enhanced version over Qwen-Image-Edit-2509, featuring multiple improvements
> including notably better consistency.

Vesper's **default for chat scene images and for portrait variants**. This is
the identity-preserving edit model the app is built around: hand it the
character's canonical portrait and a description of the new moment, and the same
person comes back in a new setting.

## The one edit-only model

This is the **only model in the set whose reference input is required**. Its
schema declares `required: ["prompt", "image"]`, so it cannot generate from a
prompt alone. It is therefore never offered in the portrait studio's new-portrait
picker — that surface filters on "can run without a reference", and this model
cannot.

## Capabilities

- **Generate without a reference:** **no.** `image` is required.
- **Edit from a reference:** yes — this is its whole purpose.
- **Reference field:** `image` — an **array** of URIs, despite the singular name.
  This is the easiest field in the set to get wrong: the sibling
  [Qwen Image 2512](qwen-image-2512.md) uses the same key for a single string.
- **Reference cap:** no `maxItems` declared and none stated in prose. Vesper
  seeds **3**, matching the multi-reference scene path (subject, location, and
  one spare).
- **Aspect handling:** `aspect_ratio` enum includes `3:4`. Send `"3:4"`.
- **Output:** array of URIs. WebP available.

## Inputs

- `prompt` — string. **Required.** Described as *"Text instruction on how to edit
  the given image"* — it takes an instruction, not a scene description. Prompts
  written for a text-to-image model read poorly here.
- `image` — array of URI strings. **Required.** *"Images to use as reference.
  Must be jpeg, png, gif, or webp."*
- `aspect_ratio` — enum, default `"match_input_image"`. Values:
  `match_input_image`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`.
- `go_fast` — boolean, default `true`.
- `output_format` — enum, default `"webp"`. Values: `webp`, `jpg`, `png`.
- `output_quality` — integer, default `95`, range 0–100.
- `seed` — integer.
- `disable_safety_checker` — boolean, default `false`.

Note the absence of a `strength` or `prompt_strength` control: edit intensity is
governed by the instruction, not a numeric dial.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<edit instruction>",
  "image": ["<url 1>", "<url 2>"],
  "aspect_ratio": "3:4",
  "output_format": "webp",
  "output_quality": 95,
  "go_fast": true,
  "disable_safety_checker": true
}
```

`aspect_ratio` is sent explicitly rather than left at `match_input_image`
because references are already 3:4 and an explicit value keeps a non-conforming
reference from dictating the output shape.
