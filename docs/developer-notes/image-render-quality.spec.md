# Image render quality — technical spec

Plan: [image-render-quality.plan.md](image-render-quality.plan.md)
Machinery this rides on: [image-model-capabilities.spec.md](image-model-capabilities.spec.md)
(profiles, control mapping, prompt fitting, multi-output). Provider facts per
model: [docs/image-models/](../image-models/).

This spec holds the content and tuning detail: dialect definitions, the
negative-prompt banks, per-model settings, the face-fidelity changes, and the
trial protocol. Contracts that already exist in the capabilities spec are
referenced, not restated.

## Current state (2026-08-05, for orientation)

- Every lane builds one prose prompt (`src/server/images/prompts.ts`) and hands
  it verbatim to `renderWithModel` → `runRegistryImageModel`. No per-model
  shaping exists anywhere.
- `buildRegistryModelInput` merges the row's `extraInput` into the payload
  last, so a static `negative_prompt` seeded into `extraInput` **ships today
  with zero code changes** — that is slice 1's whole mechanism.
- The edit-path prompt budget is 1,500 chars; text-to-image is unbounded.
- Negative-prompt support across the registry:
  - has `negative_prompt`: Qwen Image 2512, SD 3.5 Large, Juggernaut XL v9,
    Pony Realism v2.3, RealVis Hyper LoRA;
  - lacks it: Qwen Image Edit 2511, FLUX dev, Seedream 4.5, Seedream 5 Lite,
    Wan 2.7. For these, positive phrasing and sampler settings are the only
    levers.

## Prompt dialects (slice 2)

### The dialect axis

Add `promptDialect` to the `image_models` row (and schema in
`contracts/images/image-models.ts`):

```ts
export const imagePromptDialects = ["prose", "sdxl_tag", "pony_tag"] as const;
```

Default `prose`. Seeded values: `sdxl_tag` for `lucataco/juggernaut-xl-v9` and
`nsfw-api/realvis-hyper-lora`; `pony_tag` for `nsfw-api/pony-realism-v2.3`;
`prose` for everything else (both Qwens, FLUX, both Seedreams, Wan, SD 3.5 —
SD 3.5's T5 encoder reads prose fine and its CLIP branch degrades gracefully).

This is orthogonal to the capabilities spec's `promptStrategy` (which encodes
the *task shape*: description vs. edit instruction vs. multi-reference
compose). Strategy picks the segments; dialect renders them. A profile
resolves both; before profiles exist, dialect resolves from the model row
alone.

### Compilation

The compilers are pure functions in `src/server/images/prompt-dialects.ts`
(or folded into `prompts.ts` if small), consuming the segment structure the
capabilities spec already defines for prompt fitting (mandatory instruction →
identity/age anchors → scene facts → wardrobe/exposure → location/lighting →
style/quality → atmosphere).

**`prose`** — identity: exactly today's output. Golden tests pin this.

**`sdxl_tag`** —

- Token budget: assume a hard 75-token CLIP window and no chunking (diffusers
  cogs truncate; nothing in these models' READMEs claims otherwise). Budget
  ~270 characters as the 75-token proxy, validated once against a real
  tokenizer count in tests. **No emphasis syntax** — `(word:1.2)` weighting is
  an A1111/Comfy front-end feature; a diffusers cog reads it as literal
  parentheses. Plain comma-separated tags only.
- Ordering: quality lead → subject phrase → identity-critical features → pose /
  action → wardrobe (compressed) → setting fragment → lighting. The tail is
  the first thing truncation eats, so nothing load-bearing goes after
  wardrobe.
- Quality lead (realistic style): `photo, photorealistic, raw photo, detailed
  skin`. Stylized style swaps in `illustration, painterly, clean lineart`.
- Compression rules: attribute values keep their value words and drop bucket
  nouns ("Bust:" etc.); wardrobe compresses to garment names + dominant
  colour/material, dropping parenthetical appearance notes; setting compresses
  to a ≤6-word fragment; mood folds into lighting or drops.

**`pony_tag`** — `sdxl_tag` plus the Pony-lineage conventions, stated as
starting hypotheses to be trialed, not gospel:

- Prepend score tags: `score_9, score_8_up, score_7_up`.
- Add a source/rating steer: `source_photo, realistic` for Vesper's realistic
  renders; on the uncensored route optionally `rating_explicit`, on the plain
  route `rating_safe`. Whether the rating tags help or hurt this particular
  merge is a trial question — Pony Realism is a realism merge and may respond
  more to `realistic` than to rating tags.
- Score tags cost ~10 tokens of the 75; the budget math must include them.

### Where dialects apply

All lanes that reach `renderWithModel` resolve the dialect from the model they
resolved: avatar generation, portrait variants, scene renders, entity lanes,
chat-look/chat-place. In practice today's tag-dialect models are
portrait/variant/edit surfaces only; the scene multi-reference path stays
prose because no tag-dialect model is scene-eligible (`forScene` off for all
three).

## Negative-prompt banks (slices 1 → 2+)

### Blocks

Composable named blocks, stored in code (`prompt-dialects.ts` or a sibling),
composed per model × task × style:

- **anatomy** (always, all negative-capable models):
  `deformed, distorted, disfigured, bad anatomy, wrong anatomy, malformed
  limbs, extra limbs, missing limbs, floating limbs, disconnected limbs, extra
  arms, extra legs, extra fingers, missing fingers, fused fingers, too many
  fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation,
  long neck, cloned face, cross-eyed`
- **photoreal** (realistic style only):
  `cgi, 3d render, airbrushed, plastic skin, waxy skin, doll, anime, cartoon,
  illustration, painting, sketch` — must NOT be sent for the stylized avatar
  style, which *wants* illustration.
- **production** (always):
  `text, watermark, signature, logo, username, jpeg artifacts, lowres, blurry,
  out of frame, cropped head`
- **single-subject** (portrait/variant tasks only):
  `multiple people, two people, duplicate, twins, second face` — must NOT be
  sent on multi-character scene renders.
- **pony-negative** (pony_tag models, alongside the blocks above):
  `score_1, score_2, score_3` (the lineage's low-quality tags).

RealVis's schema default negative is long boilerplate of similar intent; our
composed block **replaces** it (sending any `negative_prompt` overrides the
default).

### Delivery in two stages

- **Slice 1 (data only):** one static composed string per model row via
  `extraInput.negative_prompt`, set from the admin page. Static means it
  cannot vary by task or style — compose for the row's dominant surface
  (Juggernaut/Pony/RealVis are portrait-ish surfaces today, so anatomy +
  photoreal + production + single-subject), and accept the stylized-style
  mismatch until slice 2 (plan open question).
- **Slice 2+:** negative composition moves into the dialect compiler / profile
  `controlDefaults.negativePrompt` (capabilities spec), varying by task and
  style; the static `extraInput` seeds are then removed so there is exactly
  one source.

### Interactions to respect

- Negative prompts act through classifier-free guidance: at Juggernaut's
  default guidance 2 they are nearly inert. Slice 1 must pair the Juggernaut
  negative with its sampler fix (below) or it will look like negatives don't
  work.
- Never emit a key the schema lacks — the existing `extraInput` merge already
  satisfies this for slice 1 (admins edit per-row); the slice-2 mapper uses
  the capabilities probe's binding, same as every other control.

## Per-model settings (slice 1, verified by trial)

- **Juggernaut XL v9** — the load-bearing unknown: are the 5-step /
  guidance-2 defaults a Lightning-tuned checkpoint's correct settings, or just
  a fast preset on a base checkpoint? Trial ladder, same seed & prompt per
  rung: (a) 5/2 baseline; (b) 8/2.5; (c) 12/3; (d) 30/7 with `DPM++SDE` →
  `DPMSolverMultistep`-Karras if available. If (d) overbakes (fried contrast =
  Lightning), settle in the (b)–(c) band; if (d) is clean, it wins. Record the
  ruling in `docs/image-models/juggernaut-xl-v9.md`.
- **RealVis Hyper LoRA** — "Hyper" implies Hyper-SD-style distillation, yet
  its defaults are 30 steps / cfg 7 — internally inconsistent; trial both a
  low-step (6–10, cfg 1.5–2.5) and the default band. Pin `width: 832, height:
  1216` (or keep 768×1024) explicitly rather than relying on lucky defaults.
  `facedetail_strength` 0.35 default; try 0.5 if faces render soft.
- **Pony Realism v2.3** — defaults are already sane (30 steps, cfg 7.5, Euler).
  Add negatives + score tags first; only then touch
  `ip_adapter_scale`/`controlnet_conditioning_scale` (raise toward 1.0 if the
  face isn't held, per its doc).
- **SD 3.5 Large** — cfg 5 default is fine; add the negative bank; nothing
  else.
- **Qwen Image 2512** — add the negative bank (its `negative_prompt` default
  is `" "`); `guidance` 4 default stands.
- **FLUX dev** — no negative input. If FLUX portraits show anatomy issues,
  the levers are `num_inference_steps` 28→40 and `guidance` 3→3.5; but the
  doc's expectation is that FLUX rarely needs it.
- **Qwen Image Edit 2511** — no sampler knobs at all beyond `go_fast`; see
  face fidelity below.

## Qwen Edit face fidelity (slice 3)

Three independent changes, A/B'd separately on the trial matrix (the
age-anchor precedent: one measured change at a time):

1. **Face-crop reference.** The scene/variant reference list gains a tight
   face crop of the canonical portrait as a *second* reference (subject
   portrait first, face crop second, location third — displacing the "spare"
   slot within the model's cap of 3). Recommended source: crop at portrait
   save time via sharp (upper-centre heuristic first — portraits are
   waist-up, facing camera, so a fixed crop of the top ~45% centre ~70% will
   land the face without a detection dependency; a real detector is an
   upgrade, not a prerequisite), stored as a derived image kind alongside the
   avatar, backfilled once for existing casts. Render-time cropping is the
   fallback if the derived-asset route is ruled too heavy.
2. **Indexed identity binding.** `PORTRAIT_IDENTITY_LOCK` and the scene edit
   prompt bind identity by image number, matching how Qwen Edit's own docs
   phrase multi-image instructions: "The person in image 1 (and their face in
   close-up in image 2) is the subject — render the exact same face,
   unchanged." The multi-reference composition path already enumerates
   references; the single-reference path gains the same numbering.
3. **Quality mode.** `go_fast: false` on identity-critical renders. Before
   profiles exist this can only be per-row (`extraInput.go_fast: false` on the
   edit model — applies to all its renders); with profiles it becomes the
   scene/variant default with a fast opt-out. Measure both fidelity and the
   latency cost.

## Identity re-render (slice 4)

An explicit action — "fix the face" — on a rendered scene/variant image, plus
(if trials justify) an opt-in identity-locked scene profile. Never a silent
fallback (standing owner rule; same reason a refused Wan render doesn't hop
models).

- **Pipeline (Pony Realism):** `image` = canonical portrait face (or the
  slice-3 face crop), `pose_image` = the just-rendered scene output,
  `enable_pose_controlnet: true` — InstantID re-renders the person while the
  pose ControlNet holds the composition. Prompt: the scene's tag-dialect
  compilation (Pony is `pony_tag`), plus the negative bank *without*
  single-subject when the scene has multiple people — though v1 should refuse
  multi-person scenes outright: InstantID binds one face.
- **Pipeline (RealVis):** `reference_image` = face, prompt describes the
  scene; no pose input, so composition drifts more — Pony is the primary,
  RealVis the comparison arm.
- **Knob tuning:** Pony `controlnet_conditioning_scale` (identity fidelity)
  and `ip_adapter_scale` up from 0.8 toward 1.0–1.2 if the face isn't held;
  RealVis `hyperlora_weight`/`instantid_weight` up from 0.5. Record ruled
  values in the model docs.
- **Wiring:** needs references-with-roles (identity vs. pose) — the
  capabilities spec's role-aware reference selection. If slice 4 lands first,
  a narrow interim: the action's server route builds the two-slot payload
  directly against the pinned row, bypassing generic reference fitting; fold
  into the shared path when capabilities slice 3 ships.
- **Provenance:** the re-rendered image is a *new* image row whose meta records
  `sourceImageId` and the identity model — the original is kept.

## Native shapes for width/height models (slice 5)

The capabilities spec's dimension negotiation already plans custom
width/height. The narrow pull-forward, if built before that spec: a third
`aspectMode: "width_height"` whose `supportedAspects` carries `"832x1216"`
-style entries, mapped to `width`/`height` integer inputs. Serves Juggernaut —
no SDXL training bucket is exactly 3:4, so trial the two that bracket it,
896×1152 (≈0.78, crops width) and 832×1216 (≈0.68, crops height), and keep the
one that degrades less — and pins RealVis's shape as intent instead of luck.
If the capabilities plan starts first, this slice dissolves into it.

## Best-of-N and seeds (slice 6)

Rides entirely on capabilities machinery (multi-output normalization, seed
recording, image sets). This plan's content: portrait generation on models
with cheap `num_outputs` (FLUX 1–4, Juggernaut 1–4, Pony 1–8) offers "render
3, keep one"; the picker stores the chosen seed so "another like this"
re-sends it. No scene-path involvement.

## Trial protocol (all slices)

- Fixed matrix, stored under `docs/developer-notes/images/` as
  `render-quality.<slice>.trial.md` (stakeholder-summary style per folder
  rules): 3–4 characters spanning the difficulty axes (human/non-human,
  authored heavy/sparse, realistic/stylized) × the affected tasks.
- Same seed where the model supports one; otherwise 2–3 renders per cell to
  see variance.
- Owner grades likeness / anatomy / overall on each cell, before vs. after.
  No automated face-similarity scoring in v1 (a possible later addition; not
  worth the dependency to start).
- Every settled value lands in the relevant `docs/image-models/<model>.md`
  and the registry row, in the same change as the trial report.

## Rulings needed (mirrors plan §Open questions)

1. Juggernaut Lightning-vs-base → trial rung (a)–(d) above decides; owner
   accepts the latency of the winner.
2. Face crop: derived-asset-at-save (recommended) vs. render-time crop.
3. "Fix the face": admin-first (recommended) vs. player-visible on day one.
4. Cost multipliers for best-of-N and re-render.
5. Quality-vs-speed default on identity surfaces.
6. Slice-1 static negatives on stylized-capable models: accept photoreal-block
   mismatch briefly (recommended — stylized use of those three models is rare)
   or omit the photoreal block from shared rows until slice 2.
