# Seedream 5 Lite

**Slug:** `bytedance/seedream-5-lite`
**Probed:** 2026-08-05, version `eeb2857d94c49a5bcbc9d6c6057416e1d3b1a2735a16e08e4def9bf7ee22ec71`

> Seedream 5.0 lite: image generation with built-in reasoning, example-based
> editing, and deep domain knowledge.

Replicate publishes only the "lite" edition of Seedream 5 — there is no plain
`bytedance/seedream-5`. It is verified end to end against a live scene: identity
held across a scene change, and output came back natively 3:4. Not a Vesper
default because it is slow.

## Measured behaviour

From the trial, not the schema:

- Text-to-image: ~40s, 1728×2304.
- Reference edit: ~60s, 1728×2304, face and hair preserved.

That is roughly two to three times the everyday default's latency, which is why
this is an opt-in pick.

## Capabilities

- **Generate without a reference:** yes. Required input is `prompt` only.
- **Edit from a reference:** yes, multi-reference list.
- **Reference field:** `image_input` — an array of URIs, default `[]`.
- **Reference cap:** **14.** No `maxItems`; the description states *"List of
  1-14 images for single or multi-reference generation"*.
- **Aspect handling:** `aspect_ratio` enum includes `3:4`. Send `"3:4"`.
- **Output:** array of URIs.

## Reviewed capability

Reviewed by hand, never probed, and never overwritten by a re-probe:

- **Edit kind:** `multi_reference_compose` — a genuine reference list, not
  strength-based repainting.
- **Identity preservation:** `strong`, and it is the one rating in the set with
  direct evidence: the 2026-08-05 trial above held face and hair across a scene
  change.
- **Operator warning:** none. Note this is not a moderation clearance — the model
  has no `disable_safety_checker` input and the trial ran a clothed, non-explicit
  prompt, so the reach of its moderation is still untested.

## Seeded profiles

Four, none of them a default — this is the slow, opt-in quality pick. The three
standard rows carry empty control defaults and no timeout override (its ~40–60s
latency still fits the global prediction budget; a per-profile `timeout_ms` is
available if the 3K profile needs one):

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references.
- `variant-standard` (Variant Standard) — task `variant`, `edit`,
  `instruction_edit`, `identity` required and `style` allowed.
- `scene-standard` (Scene Standard) — task `scene`, `edit`, `instruction_edit`,
  identity → location → style → object with nothing required.

The scene profiles carry `instruction_edit` rather than `multi_reference_compose`
for the same reason as [Seedream 4.5](seedream-4-5.md): the lane chooses the
reference mode at render time.

One curated profile extends the standard set and runs only when picked:

- `quality-scene-3k` (Quality Scene 3K) — task `scene`, the identity-strong
  quality pick at the model's top tier, `resolution: "3K"` (the `size` enum
  stops at 3K — there is no 4K). Same strategy and role order as
  `scene-standard`, no per-role caps.

The `resolution` default maps through the probed `size`-tier binding: while the
model row's `advancedCapabilities` is empty it drops as recorded `no_binding`,
and it takes effect once the version is probed or pinned.

## No WebP

`output_format` offers only `png` and `jpeg` — this is the one model in the set
that cannot return WebP. The default is `png`, which at 2K is several megabytes.
Vesper requests `png` and converts on download; the extra bytes over the wire
are unavoidable.

## Inputs

- `prompt` — string. **Required.**
- `image_input` — array of URI strings, default `[]`.
- `size` — enum, default `"2K"`. Values: `2K` (2048px), `3K` (3072px). Note
  there is no `4K` and no `custom`, unlike [Seedream 4.5](seedream-4-5.md).
- `aspect_ratio` — enum, default `"match_input_image"`. Values:
  `match_input_image`, `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`.
  Narrower than 4.5's list — no `4:5` or `5:4`.
- `output_format` — enum, default `"png"`. Values: `png`, `jpeg`.
- `max_images` — integer, default `1`, range 1–15.
- `sequential_image_generation` — enum, default `"disabled"`. Values: `disabled`,
  `auto`.

Note there is **no `disable_safety_checker`** on this model, unlike Seedream 4.5.
The practical reach of content moderation here is untested — the trial ran a
clothed, non-explicit prompt.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — take the
first entry.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "image_input": ["<url 1>"],
  "aspect_ratio": "3:4",
  "size": "2K",
  "output_format": "png",
  "max_images": 1,
  "sequential_image_generation": "disabled"
}
```
