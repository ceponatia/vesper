# Image render quality — per-model prompts, negative steering, and faces that survive

Status: draft (brainstormed 2026-08-05 from an owner ask; open questions below
need rulings before this becomes buildable)

Technical companion: [image-render-quality.spec.md](image-render-quality.spec.md)

Sibling plans, both active: the
[image model registry](image-model-registry.plan.md) (which models exist, how to
call them) and
[image model capabilities](image-model-capabilities.plan.md) (profiles, shared
controls, version pinning — the *machinery*). This plan is the *content and
tuning* that rides on both: what we actually say to each model, what we tell it
not to draw, and how a character's face survives the trip.

## The two problems this plan exists to fix

Both were reported by the owner on 2026-08-05, after the registry grew from six
models to ten:

**Qwen Image Edit does not replicate faces well.** It is the default for scenes
and portrait variants precisely because it is the identity-preserving editor —
and the person who comes back is recognisably *similar*, but often not the same
face. Every scene image of a character the player knows well makes this worse,
because the player knows exactly what she looks like.

**The other models produce deformities.** Extra limbs, extra fingers, warped
hands, anatomy that falls apart outside the face. This clusters in the
SDXL-lineage community models (Juggernaut XL v9, Pony Realism, RealVis Hyper
LoRA) but is not exclusive to them.

## Why this happens — the diagnosis

Reading the current pipeline, these failures are not mysterious. Five causes,
all fixable:

**One prompt for ten models.** Every model receives the same long structured
prose prompt (up to 1,500 characters on the edit path, unbounded on
text-to-image). The newer models — Qwen, FLUX, Seedream, Wan, SD 3.5 — read
long prose natively. The SDXL-lineage models do not: their text encoder reads
roughly the first 75 tokens (about 300 characters) **and silently ignores the
rest**. Most of what Vesper says to Juggernaut, Pony Realism, and RealVis is
never seen, and what survives the cut-off is whatever happened to come first —
not necessarily the subject. A model acting on a fragment of a prompt
improvises the rest, and improvised anatomy is where extra limbs come from.

**Negative prompts are unused.** Five models accept a `negative_prompt` — the
industry-standard way to steer SDXL-family models away from deformities — and
Vesper sends nothing on all of them. Pony Realism ships with an *empty*
default. This is the single cheapest lever available: a curated "extra limbs,
fused fingers, bad anatomy…" block is exactly what these checkpoints expect to
be told.

**Fast-path defaults.** Juggernaut runs at its cog's default of **5 inference
steps** and guidance 2 — a speed configuration that produces soft, unstable
anatomy, and at guidance that low a negative prompt barely acts even if we send
one. Qwen Edit runs with `go_fast` on, trading fidelity for speed on the
surface where fidelity is the whole point.

**Square renders cropped to portrait.** Juggernaut has no shape input the
registry can drive yet, so it renders 1024×1024 and Vesper centre-crops a
quarter of the width away. Limbs the model painted near the frame edge get cut
mid-arm — which *reads* as deformity even when the model did nothing wrong —
and a quarter of the pixels are thrown away.

**The identity specialists are wired as generic editors.** Pony Realism and
RealVis Hyper LoRA are InstantID/HyperLoRA pipelines — purpose-built to take a
face and render that exact person. They are the best face technology in the
registry, and today they receive the same prose prompt as everyone else, their
identity-strength knobs sit at defaults, and nothing in the app uses them for
the thing they are uniquely good at.

## What the owner gets

**Prompts written in each model's native dialect.** The same render plan — who
is in frame, what they wear, where they are — compiles differently per model.
Prose models keep today's sentences. SDXL-lineage models get a compact,
subject-first tag prompt that fits inside their token window, so the model
actually reads everything Vesper considers load-bearing. Pony-lineage models
additionally get the score-tag quality convention their training expects.

**A strong negative prompt on every model that takes one.** A curated,
task-aware block: anatomy steering (extra limbs, malformed hands) everywhere,
photorealism steering (CGI, plastic skin) on realistic renders, production
steering (text, watermark) always, single-subject steering on portraits. Day
one this ships as per-model registry data; the capabilities plan's profiles
later make it per-task.

**Settings that favour anatomy over speed.** Reviewed step counts, guidance,
and native portrait resolutions per model — including teaching the registry to
drive width/height models like Juggernaut at a true 3:4 so nothing is cropped
away. Where a model offers a quality/speed trade (Qwen Edit's fast mode), the
identity-critical surfaces get a quality option.

**Faces that survive scenes.** Three attacks on the Qwen Edit face problem, in
escalating order of ambition:

1. *Better evidence* — send the face itself, not just a waist-up portrait where
   the face is a hundred pixels: a tight face crop travels as a second
   reference, and the instruction binds identity to it by image number.
2. *Better asking* — a quality profile with fast mode off, and identity-lock
   phrasing tuned the way the age-anchor work was (measured A/B, not vibes).
3. *A specialist for the face* — a new **identity re-render** step that uses
   RealVis/Pony's InstantID machinery to put the character's real face onto a
   scene Qwen composed. Offered as an explicit "fix the face" action on a
   rendered image (and later, possibly, an opt-in scene profile) — never a
   silent substitution.

**A repeatable way to judge any of it.** A small fixed trial matrix (a few
characters × portrait / variant / scene), rendered before and after each
change, graded by the owner. Every tuning claim in this plan is cheap to test
and none should be trusted untested — the registry's own docs note the
community models' reliability is unproven.

## What this plan deliberately does not do

- No machinery. Profiles, control mapping, version pinning, multi-output
  normalization, and LoRA plumbing belong to
  [image-model-capabilities.plan.md](image-model-capabilities.plan.md). Where a
  slice here needs that machinery, it says so and waits for it.
- No automatic cross-model fallback. A failed or refused render on one model is
  never quietly re-run on another (standing owner rule from the registry plan).
  The identity re-render is an explicit action, not a fallback.
- No per-character LoRA training, no video, no ControlNet beyond what the
  registered models already expose (Pony's pose input). The
  [spatial scene images plan](spatial-scene-images.plan.md) owns the
  pose/depth-controlled future; this plan only leaves seams it can use.

## Delivery slices

1. **Registry data pass (no code).** Seed curated negative prompts and reviewed
   sampler settings into the existing per-model `extraInput` from the admin
   page: anatomy negatives on all five negative-capable models, steps/guidance
   on Juggernaut, explicit width/height where a row supports it. Verify each by
   trial renders. Cheapest slice, targets the deformity complaint directly.
2. **Prompt dialects.** A per-model dialect tag (prose / SDXL-tag / Pony-tag)
   and compilers that turn the existing structured render plan into each
   dialect, with hard token budgets and subject-first ordering for the tag
   dialects. Golden-tested so prose-model prompts do not change at all.
3. **Qwen Edit face fidelity.** Face-crop second reference, numbered-reference
   identity binding in the instruction, and a fast-mode-off quality option.
   A/B trial against the current output on the fixed matrix.
4. **Identity re-render.** The "fix the face" action: re-render a finished
   image through RealVis or Pony with the character's canonical face as the
   identity input (Pony additionally reusing the image as its pose reference).
   Includes a tuning pass over the identity-strength knobs. Depends on the
   capabilities plan's role-aware references or a narrow interim binding.
5. **Native shapes for width/height models.** The registry learns a
   width/height aspect mode so Juggernaut renders 832×1216 instead of a cropped
   square, and RealVis's lucky 3:4 default becomes pinned intent. (This is the
   capabilities plan's dimension negotiation, pulled forward narrowly if that
   plan has not started.)
6. **Best-of-N portraits.** Where a model returns multiple outputs cheaply,
   portrait generation can request 2–4 and let the player pick, with stored
   seeds making "another like this one" reproducible. Depends on the
   capabilities plan's multi-output normalization and seed recording.
7. **Strengths routing.** Reviewed per-model guidance recorded in the registry
   and surfaced in pickers: what each model is actually for, which warnings
   apply (Wan's moderation, community-model reliability), and recommended
   defaults per surface. Content for the capabilities plan's semantic-facts
   fields.

Slices 1–3 need nothing from the capabilities plan and can start immediately;
4–7 each name their dependency.

## Success criteria

- A Juggernaut / Pony / RealVis portrait renders with no more limbs than the
  character has, at a rate the owner accepts across the trial matrix.
- The prompt a tag-dialect model receives fits inside its token window with the
  subject stated first; nothing load-bearing is past the cut-off.
- Every negative-capable model receives a curated negative prompt; no model
  receives an input its schema lacks.
- A scene rendered through the face-fidelity slice is judged a better likeness
  than today's output on the same fixed inputs, by the owner, on the majority
  of the matrix.
- The identity re-render action produces the character's recognisable face on
  a scene Qwen composed, without changing pose or setting beyond tolerance.
- No existing render path changes behavior for prose models until a trial says
  it should (golden tests hold).

## Open questions

- **Juggernaut's true configuration.** Is the registered v9 checkpoint the
  Lightning-style fast variant (its 5-step / guidance-2 defaults suggest so) or
  a base checkpoint run fast? The answer decides whether slice 1 raises steps
  modestly (8–12) or fully (25–35 with guidance 5–7). Resolved by one trial
  ladder, detail in the spec.
- **Where the face crop comes from.** Auto-detect at render time, or crop once
  at portrait save and store it as a derived asset? (Spec recommends: store at
  save time, one-off backfill for existing casts.)
- **Player-visible or admin-first.** Is "fix the face" a player action on day
  one, or does it prove out on the admin/dev surface first?
- **Cost ceilings.** Best-of-N and identity re-render both multiply spend per
  image. Acceptable multipliers per surface need an owner number before slices
  4 and 6 ship defaults.
- **Latency tolerance.** Fast-mode-off Qwen Edit and 30-step SDXL renders are
  seconds slower. Is slower-but-right the default on identity-critical
  surfaces, or an opt-in?
- **Stylized portraits.** The photorealism negative block fights the *stylized*
  avatar style. Per-style negative composition is easy in slice 2+, but slice
  1's static per-model data cannot vary by style — accept the mismatch briefly,
  or gate slice 1's style block to realistic-only models?
