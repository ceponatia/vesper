# Scene-image eval harness

Fixture-driven, **human-scored** quality harness for scene rendering
(scene-images.spec.md §9). This is **not** a `pnpm test` gate — image identity and
quality can only be judged by eye.

## What's here

- `fixtures.ts` — ~24 fixed scenes. The routing matrix (one character; two
  clothed; two partial; three characters; character+location; location-only;
  high-risk wardrobe/exposure; uploaded-anchor safety case), plus the
  orientation/staging block (scene-composition.spec.md) — a non-default camera
  on the `orientation` rows, a registry staging entry on the `staging` ones, and
  the frontal rows above them as the identity-regression control.
- `orientation-ab.ts` — the paid, manually run A/B for that block: one beat
  rendered twice, today's front-facing prompt against the same plan with its
  camera and staging set. Prompts print with no provider key configured, so the
  wording can be reviewed for free; only the renders cost anything.
- `intimate-model-ab.ts` — the paid, manually run MODEL A/B that follows it. The staging
  geometry renders on Qwen Edit 2511; explicit anatomy does not (owner report 2026-08-14),
  so this one takes the same four intimate beats — imported from `orientation-ab.ts`, never
  restated — and renders each across `qwen` (that baseline), `pulid` and `pulid_compact`
  (`nsfw-api/sdxl-pulid`, the registry's identity-preserving adult model, on the pipeline
  prompt and on a hand-written ~60-word SDXL-dialect prompt that fits inside CLIP's window),
  and an optional `lora` arm. Grades the ACT and the LIKENESS: sdxl-pulid's row records that
  its likeness is unmeasured in Vesper, and it is single-reference, so identity rides one
  portrait. Prompts print and every honesty check runs before anything is sent.
- `composer-model-ab.ts` + `composer-model-score.ts` — the **composer-model** A/B
  (composer-model.plan.md), and the odd one out in this folder: it grades TEXT, so
  it is scored in code rather than by eye. It takes the seven beats from
  `orientation-ab.ts` — again imported, never restated — and asks each candidate
  shot-planning model the real question (`sceneComposerSystem`,
  `buildSceneComposerPrompt`, `sceneSpecSchema`, `generateChecked`), then grades
  the answer by resolving it through the production `resolveScenePlan`: camera
  ids, staging id, verbatim evidence, roster clamps and the skin-colour scrub are
  the app's own gates, not a paraphrase. Reports measured latency and measured
  dollars alongside the score. `composer-model-score.ts` is pure and covered by
  `pnpm test` — a grader nobody tests is an instrument nobody can trust.
- `composer-model-eval.ts` + `composer-model-economics.ts` — the owner-facing
  entrypoint and its pure economics helper. The entrypoint runs the existing
  composer A/B unchanged, then separates the quality `answered` rate from the
  exact production fallback trigger, reports primary and effective two-rung cost,
  flags the owner-set 10% fallback-review threshold, and writes
  `ladder-summary.json`. The arithmetic helper is covered by `pnpm test`.
- `run.ts` — offline runner. Computes each fixture's provider routing decision and
  the exact prompt(s) the executor would build, and writes:
  - `data/eval/scene-images/manifest.json` — inputs / chain / primary provider / prompts
  - `data/eval/scene-images/scores.csv` — one row per fixture with blank manual-score columns

```
pnpm tsx scripts/eval/scene-images/run.ts        # writes manifest + scores template
EVAL_OUT=/tmp/eval pnpm tsx scripts/eval/scene-images/run.ts

# the orientation/staging A/B — PAID once a provider key is configured
AB_BEAT=behind pnpm tsx scripts/eval/scene-images/orientation-ab.ts [anchor.webp] [variants]
# beats: behind | glance | kneel | doggy | oral | oral_guided | missionary   (AB_RUNS=n per variant)

# the intimate MODEL A/B — PAID; all four beats × 3 arms × AB_RUNS by default
pnpm tsx scripts/eval/scene-images/intimate-model-ab.ts [anchor.webp]
AB_BEAT=all|doggy|oral|oral_guided|missionary   AB_RUNS=n
EVAL_LORA_WEIGHTS=owner/model EVAL_LORA_SCALE=1 pnpm tsx scripts/eval/scene-images/intimate-model-ab.ts
# ↳ the 4th `lora` arm runs only when EVAL_LORA_WEIGHTS is set; unset, it says so and is skipped.
# Renders land in screenshots/intimate-model-ab/<beat>/<arm>-<n>.webp

# the composer-model A/B — PAID, but TEXT: the full 8×7×2 matrix is well under $2
# Use the owner entrypoint so the unchanged A/B is followed by production-ladder economics.
pnpm tsx scripts/eval/scene-images/composer-model-eval.ts
AB_BEAT=doggy AB_RUNS=3 pnpm tsx scripts/eval/scene-images/composer-model-eval.ts
AB_ARMS=aion3,dsflash-off pnpm tsx scripts/eval/scene-images/composer-model-eval.ts
# arms: aion3 (control, required) | aion3mini | aion2 | dsflash-off | dsflash-low
#       | qwen37flash | glm47flash | ling3flash
# Raw results: data/eval/composer-model-ab/results.{csv,json}
# Ladder report: data/eval/composer-model-ab/ladder-summary.json   (EVAL_OUT overrides both).
```

The image A/Bs print their prompts with no provider key configured, so the wording is free to
review; only the renders cost anything. `intimate-model-ab.ts` additionally refuses to send
ANYTHING when its own honesty checks fail — two arms sharing a prompt they should not, a
`lora` arm that has drifted off the `qwen` arm's prompt, a staging sentence missing from a
pipeline prompt, or a compact prompt over its word budget. The composer-model owner entrypoint
also preserves no-provider behavior: the underlying A/B prints its prompts, then the wrapper
skips ladder economics rather than reading stale results from an earlier paid run.

## Scoring (manual)

1. Run the runner to get `manifest.json` + `scores.csv`.
2. For each fixture, render its `prompts.edit` (or `prompts.text`) through its
   `primary_provider` — using a real reference avatar for anchored fixtures (seed
   one from `scripts/fixtures/harbor-house.ts`) — and save the output beside the row.
3. Fill `scores.csv`: `identity_A`, `identity_B`, `location`, `clothing`,
   `exposure`, `collage_contamination` (0–3 each, your scale), and `notes`.
4. **Safety row (§3 acceptance test):** the `safety_uploaded_reached_uncensored`
   column is pre-marked `MUST_BE_NO` for fixtures whose anchor is an uploaded
   real-person avatar (e.g. `single-uploaded-anchor-intimate-SAFETY`). Today the
   uploaded-avatar guard is deferred, so this can fire — it becomes a hard
   acceptance test (must score "no") once the §3 guard ships.

## Notes

- Routing is exercised offline (no keys) — eyeball that the matrix routes as
  expected (anchored → `edit`; no-avatar → `generate` when the model can run bare;
  multi mode with ≥2 anchors → `multi_edit → edit`). The rungs name reference
  tiers on ONE model, not a hop between providers.
- The Qwen reference-sheet spike has its own script under `scripts/spikes/`
  (the Flux-multiref spike was dropped with the Flux removal — scene-images.plan.md).
