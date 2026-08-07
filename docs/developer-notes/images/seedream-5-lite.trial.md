# Seedream 5 Lite — live trial

Status: closed — passed 2026-08-05

## Decision

`bytedance/seedream-5-lite` works and is safe to ship in both the portrait
studio and the scene generator. Replicate lists only the "lite" edition of
Seedream 5 (there is no plain `bytedance/seedream-5`), which raised the question
of whether the lite model was a cut-down preview that could not hold a
character's face across a scene change. It is not. Both things we need from it
work on the first try.

## What we checked

Two real Replicate predictions, run back to back against the live model.

**Making a portrait from nothing.** Given only a written description — dark red
hair, green eyes, a lantern-lit stone corridor at night — it produced a clean,
photographic portrait with the right hair colour, the right eye colour, and the
right setting. Nothing about it reads as a lower-tier model.

**Keeping the same person in a new scene.** We handed that portrait back to the
model as a reference and asked for the same woman, now seated in a warm tavern
holding a cup of tea. She came back recognisably the same person: same face
shape, same green eyes, same dark red waves, same faint smile. The room, the
pose, the clothing, and the props all changed as asked. Hands — the usual
giveaway — came out correct.

This is the behaviour the scene generator depends on, and it is the exact thing
the old text-to-image options failed at (owner ruling 2026-07-29: style swaps
"painted a different-looking person").

## Fit with the rest of the app

- **Native 3:4.** Both images came back at 1728×2304, which is exactly the shape
  every image in Vesper uses. No cropping, no letterboxing, no special case.
- **Multiple references.** Its reference input takes a list, not a single image,
  so it can accept a character reference and a location reference together the
  way the multi-reference scene path already expects.
- **Safety checker can be turned off,** consistent with the other models we run.

## Limitations worth knowing

- **It is not fast.** The portrait took about 40 seconds and the scene edit about
  60. That is slower than what players are used to from the current default, so
  it is a good "make this one count" option rather than the everyday one. This is
  a large part of why Qwen Image Edit 2511 stays the scene default.
- **It outputs PNG or JPEG, not WebP.** Every other model we use can hand back
  WebP directly. The render path will need to convert, which we already do
  elsewhere, but it is an extra step and larger bytes over the wire.
- **Replicate does not publish a reference-image limit.** The input accepts a
  list but declares no maximum, so the cap has to be a number we choose and
  record ourselves rather than something we can read from the API. This is true
  of every array-input model, not just this one.

## Next steps

Include it in the seeded model list as an edit-capable model, available in the
portrait studio, the New Variant section, and the scene generator. It is not the
default anywhere.

---

## Evidence appendix

Run 2026-08-05 against `bytedance/seedream-5-lite`, version `eeb2857d94c4`,
using the local `REPLICATE_API_TOKEN`.

**Prediction 1 — text-to-image.** Id `6zx6q1jgj9rmt0czt8vbnqevp4`. Input:
`aspect_ratio: "3:4"`, `size: "2K"`, `output_format: "png"`, `max_images: 1`, no
`image_input`. Prompt: "Portrait of a woman with dark red hair and green eyes,
standing in a lantern-lit stone corridor at night, cinematic photography,
shallow depth of field". Result: succeeded, `predict_time` 40.35s, 1728×2304,
3736712 bytes PNG. Artifact: [seedream-5-lite-t2i.webp](seedream-5-lite-t2i.webp)
(downscaled to 768px WebP for the repo; the original PNG was not kept).

**Prediction 2 — reference edit.** Id `vgh4yxqkc5rmy0czt8v8z13n5g`. Input: same
as above plus `image_input: [<prediction 1 output url>]`. Prompt: "The same
woman, same face and hair, now seated at a wooden table in a warm tavern,
holding a cup of tea, looking at the viewer". Result: succeeded, `predict_time`
60.12s, 1728×2304, 4199102 bytes PNG. Artifact:
[seedream-5-lite-reference-edit.webp](seedream-5-lite-reference-edit.webp).

**Schema facts confirmed in the same session.** Required input is `["prompt"]`
only — the reference is optional, so this model can both generate and edit.
Reference field is `image_input`, type array of URI, default `[]`, no
`maxItems`. `aspect_ratio` enum includes `3:4`. `size` enum is `2K` / `3K`.
`output_format` enum is `png` / `jpeg` only. Lifetime `run_count` at time of
check: 3173315.

**Not covered by this trial.** No NSFW prompt was run, so the practical reach of
`disable_safety_checker` on this model is unverified. Multi-reference (two or
more images in `image_input`) was not exercised — only the single-reference
case. Both are worth a follow-up before this model is used for anything beyond
opt-in picks.
