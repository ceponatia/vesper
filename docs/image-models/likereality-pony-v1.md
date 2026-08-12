# LikeReality Pony v1

**Slug:** `aisha-ai-official/likereality-pony-v1`
**Registered as:** `aisha-ai-official/likereality-pony-v1:f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2`
**Probed:** 2026-08-11, version `f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2`
**Quality ruling:** 2026-08-11

The model page carries no description text. Its schema is a Pony/SDXL-lineage
fine-tune behind a full ComfyUI-style wrapper: VAE choice, scheduler choice,
CLIP skip, PAG, a refiner pass, an upscaler, and three ADetailer passes (face,
hand, person) each with its own prompt pair. Lifetime run count on Replicate is
55,413.

Offered for portraits only. It publishes no URI-typed input at all, so it
cannot hold a character's face across a render — it is closed to the variant
and scene surfaces by capability, not by an unset toggle.

## Community model — pinned by version

`is_official` is false, so the row is pinned to the version above and runs
through Replicate's versioned predictions endpoint. It does not follow future
releases. A new version requires a new probe, semantic review, fixed-matrix
trial, and license/terms review.

## Capabilities

- **Generate without a reference:** yes. Nothing is formally required — the
  schema's `required` list is empty.
- **Edit from a reference:** no. There is no URI-typed input of any kind.
- **Reference cap:** 0.
- **Aspect handling:** free `width`/`height` integers; no `aspect_ratio` and no
  `size` input.
- **Output format control:** none.
- **Safety toggle:** none.
- **Output:** array of URIs.

## Explicit native dimensions

The provider defaults `width`/`height` to 1080×1080. `packages/image-core/src/models/quality-presets.ts` sends the same portrait bucket used for
[Juggernaut XL v9](juggernaut-xl-v9.md) and [NSFW FLUX Dev](nsfw-flux-dev.md):

```json
{
  "width": 832,
  "height": 1216
}
```

`cropToTargetAspect` trims the modest remainder to 3:4 after download.

## Negative prompt policy

This is the consequential reviewed setting on this model, and it differs in
kind from a generic quality/anatomy boilerplate default. The provider default
for `negative_prompt` is literally:

```text
nsfw, naked
```

Left unsent, that default would apply to every render — suppressing exactly
the output an adult-content app exists to produce, and silently contradicting
whatever wardrobe and exposure state the prompt asserts. The contradiction is
invisible while it happens: an unsent field never appears in the payload, so
nothing in a logged request looks wrong.

Vesper therefore sends:

```json
{
  "negative_prompt": ""
}
```

`buildRegistryModelInput` preserves the empty string, so this neutralizes the
remote default.

`prepend_preprompt` stays at its default `true`. That is a separate mechanism
from the negative-prompt default above: it prepends the Pony score-tag
preamble (`score_9, score_8_up, score_7_up,`) and a matching negative preamble
of its own. That prepending is standard practice for this checkpoint family —
it is not the same thing as the `"nsfw, naked"` default, and clearing
`negative_prompt` does not touch it.

## Reviewed capability

- **Edit kind:** `none` — no image input exists to rate.
- **Identity preservation:** `unknown`.
- **Operator warning:** *"Community Pony/SDXL fine-tune, untried in Vesper.
  Text-to-image only — no reference input. Its provider default negative
  prompt is "nsfw, naked"; the reviewed quality policy clears it."*
  Descriptive context for the admin card, not a moderation or reliability
  caveat; no surface renders it yet.

## Seeded profiles

One, not the global default:

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references.

Every render resolves a profile, so picking this model for a new portrait
resolves this row.

## Inputs

- `prompt` — string, Compel weighting syntax. Not in `required`.
- `negative_prompt` — string, **provider default `"nsfw, naked"`**; Vesper
  clears it. Compel syntax.
- `model` — enum, default `LikeReality-Pony-v1`; that is the only value.
- `vae` — enum, default `default`. Values: `default`, `Liquid111`,
  `NeptuniaXL-VAE-ContrastSaturation`, `LikeReality-Pony-v1`.
- `seed` — integer, default `-1` (`-1` = random).
- `steps` — integer, default `30`.
- `width` — integer, default `1080`.
- `height` — integer, default `1080`.
- `cfg_scale` — number, default `7`.
- `clip_skip` — integer, default `2`.
- `pag_scale` — number, default `0` (`0` disables).
- `guidance_rescale` — number, default `1`.
- `scheduler` — enum, default `Euler a`; 21 values including
  `DPM++ 2M SDE Karras`, `UniPC`, `DDIM`, `Euler`.
- `upscale` — enum, default `Original`. Values: `Original`, `x2`, `x4`, `x8`.
- `refiner` — boolean, default `false`, with `refiner_prompt` (string) and
  `refiner_strength` (number, default `0.4`).
- `prepend_preprompt` — boolean, default `true`. Prepends the Pony score tags
  and its own negative preamble — see Negative prompt policy above.
- `adetailer_face`, `adetailer_hand`, `adetailer_person` — booleans, all
  default `false`, each with its own `*_prompt` and `*_negative_prompt`
  string.

There is no `aspect_ratio`, `size`, `output_format`, or safety input.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "negative_prompt": "",
  "width": 832,
  "height": 1216
}
```

`prepend_preprompt`, ADetailer, the refiner, the upscaler, CFG, and scheduler
choice all ride at their provider defaults; tuning them is trial work, one
variable at a time.

## License/terms gate

No Vesper trial has been run — nobody has graded this model's output. It is a
community checkpoint, the same as [Juggernaut XL v9](juggernaut-xl-v9.md) and
the other two pinned models in this batch: before it becomes a production
default or a paid feature path, it needs a recorded review of the checkpoint
license and intended hosted/API use. Because it has no reference input at all,
no trial can ever qualify it for the variant or scene surfaces — that is a
structural fact about its schema, not an unset toggle.
