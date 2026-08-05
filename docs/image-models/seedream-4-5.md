# Seedream 4.5

**Slug:** `bytedance/seedream-4.5`
**Probed:** 2026-08-05, version `9fe3b8282dcb9d9063b05e33210a1432801f7c5a6641db944baefcec4886761a`

> Seedream 4.5: Upgraded Bytedance image model with stronger spatial
> understanding and world knowledge.

A strong multi-reference alternative for scenes. Not a Vesper default. By run
count it is by far the most-used model in the set on Replicate, which is a
reasonable proxy for reliability.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, with a genuine multi-reference list rather than
  strength-based repainting.
- **Reference field:** `image_input` — an array of URIs, default `[]`.
- **Reference cap:** **14.** No `maxItems` in the schema; the field description
  states *"List of 1-14 images for single or multi-reference generation"*.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`. Send `"3:4"`.
- **Output:** array of URIs.

## No output format control

This model declares **no `output_format` input**. Whatever it returns is what
Vesper gets, so the download path must convert to WebP rather than requesting it.
This is the only model in the set with neither an `output_format` field nor a
documented default format.

## Inputs

- `prompt` — string. **Required.** *"Maximum 4000 characters. BytePlus recommends
  keeping prompts under 600 English characters"* — worth heeding, since Vesper's
  scene prompts are long.
- `image_input` — array of URI strings, default `[]`.
- `size` — enum, default `"2K"`. Values: `2K` (2048px), `4K` (4096px), `custom`.
  *"1K resolution is not supported."*
- `width` / `height` — integer, 1024–4096, default 2048. Only when
  `size='custom'`.
- `aspect_ratio` — enum, default `"match_input_image"`. Values:
  `match_input_image`, `1:1`, `4:3`, `3:4`, `4:5`, `5:4`, `16:9`, `9:16`, `3:2`,
  `2:3`, `21:9`, `9:21`. *"Only used when size is not 'custom'."*
- `max_images` — integer, default `1`, range 1–15. Only meaningful when
  `sequential_image_generation='auto'`.
- `sequential_image_generation` — enum, default `"disabled"`. Values: `disabled`,
  `auto`. Leave disabled: `auto` lets the model return a set rather than one
  image.
- `disable_safety_checker` — boolean, default `false`. *"When enabled, input
  moderation is relaxed to only block illegal content."*

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry. With `sequential_image_generation` disabled and `max_images: 1`
there will be exactly one.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "image_input": ["<url 1>", "<url 2>"],
  "aspect_ratio": "3:4",
  "size": "2K",
  "max_images": 1,
  "sequential_image_generation": "disabled",
  "disable_safety_checker": true
}
```

`max_images` and `sequential_image_generation` are pinned explicitly so a future
default change on Replicate's side cannot start returning image sets.
