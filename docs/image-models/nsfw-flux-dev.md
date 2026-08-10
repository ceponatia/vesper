# NSFW FLUX Dev

**Slug:** `aisha-ai-official/nsfw-flux-dev`
**Registered as:** `aisha-ai-official/nsfw-flux-dev:fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa`
**Probed:** 2026-08-11, version `fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa`
**Quality ruling:** 2026-08-11

The model page carries no description text. Its schema is five fields —
`prompt`, `seed`, `steps`, `width`, `height`, `guidance_scale` — with no
negative prompt, no sampler choice, no LoRA input, and no safety toggle: a bare
community FLUX Dev wrapper, not a ComfyUI-style pipeline like
[LikeReality Pony v1](likereality-pony-v1.md). Lifetime run count on Replicate
is 418,844, the highest of the three community models in this batch.

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
  schema's `required` list is empty, and `prompt` carries a provider sample
  default.
- **Edit from a reference:** no. There is no URI-typed input of any kind.
- **Reference cap:** 0.
- **Aspect handling:** free `width`/`height` integers; no `aspect_ratio` and no
  `size` input.
- **Output format control:** none.
- **Safety toggle:** none.
- **Output:** array of URIs.

## Native size is square, cropped to portrait

The provider defaults `width`/`height` to 1024×1024. Sent unmodified, every
render would come back square and then lose a quarter of the frame to
`cropToTargetAspect`'s 3:4 crop. `src/server/images/quality-presets.ts` instead
sends the portrait bucket this architecture is trained on:

```json
{
  "width": 832,
  "height": 1216
}
```

832×1216 is close enough to 3:4 that only a modest top/bottom trim is needed.
The registry's generic aspect modes do not model free `width`/`height` inputs,
so `chooseAspect` has no aspect key to send here; `renderWithModel` normalizes
the returned buffer to the lane's target afterward.

## Reviewed capability

- **Edit kind:** `none` — no image input exists to rate.
- **Identity preservation:** `unknown`.
- **Operator warning:** *"Community FLUX fine-tune, untried in Vesper.
  Text-to-image only — it publishes no reference input, so it cannot hold a
  character's face across renders."* Descriptive context for the admin card,
  not a moderation or reliability caveat; no surface renders it yet.

## Seeded profiles

One, not the global default:

- `portrait-standard` (Portrait Standard) — task `portrait`, `generate`,
  `text_to_image_description`, no references.

Every render resolves a profile, so picking this model for a new portrait
resolves this row.

## Inputs

- `prompt` — string. Provider default is a sample prompt; not in the
  `required` list.
- `seed` — integer, default `-1` (`-1` = random).
- `steps` — integer, default `8`.
- `width` — integer, default `1024`.
- `height` — integer, default `1024`.
- `guidance_scale` — number, default `3.5`.

There is no `negative_prompt`, `aspect_ratio`, `size`, `output_format`, or
`disable_safety_checker` input.

## Output

`{"type": "array", "items": {"type": "string", "format": "uri"}}` — Vesper
takes the first result.

## Vesper payload

```json
{
  "prompt": "<built prompt>",
  "width": 832,
  "height": 1216
}
```

## License/terms gate

No Vesper trial has been run — nobody has graded this model's output. It is a
community checkpoint, the same as [Juggernaut XL v9](juggernaut-xl-v9.md) and
the other two pinned models in this batch: before it becomes a production
default or a paid feature path, it needs a recorded review of the checkpoint
license and intended hosted/API use. Because it has no reference input at all,
no trial can ever qualify it for the variant or scene surfaces — that is a
structural fact about its schema, not an unset toggle.
