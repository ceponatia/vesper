# Scene-image eval harness

Fixture-driven, **human-scored** quality harness for scene rendering.
This is **not** a `pnpm test` gate — image identity and
quality can only be judged by eye.

## What's here

- `fixtures.ts` — ~24 fixed scenes. The routing matrix (one character; two
  clothed; two partial; three characters; character+location; location-only;
  high-risk wardrobe/exposure; uploaded-anchor safety case), plus the
  orientation/staging block — a non-default camera
  on the `orientation` rows, a registry staging entry on the `staging` ones, and
  the frontal rows above them as the identity-regression control.
- `beats.ts` — the seven orientation/staging beats (`behind`, `glance`, `kneel`,
  plus the four intimate acceptance scenes `doggy`, `oral`, `oral_guided`,
  `missionary`, owner-specified 2026-08-10) as resolved specs + context, shared
  so `composer-model-ab.ts` grades the exact same beats a render A/B would —
  two probes disagreeing about what "doggy" is would make their gradings
  incomparable. The render-side A/B that used to own these definitions
  (`orientation-ab.ts`) and the model A/B that graded them on Qwen/PuLID/LoRA
  arms (`intimate-model-ab.ts`) were deleted (#356): both were paid, manually
  run harnesses whose only inputs were portraits under a `docs/` eval-asset
  directory retired by #352, gone on every machine. Git history preserves
  them; a future evaluation resurrects one deliberately, with inputs that
  exist and `eval-images/` outputs.
- `composer-model-ab.ts` + `composer-model-score.ts` — the **composer-model** A/B,
  and the odd one out in this folder: it grades TEXT, so
  it is scored in code rather than by eye. It takes the seven beats from
  `beats.ts` — imported, never restated — and asks each candidate
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

The composer-model A/B prints its prompts with no provider key configured, so the wording is
free to review; only the calls cost anything. The owner entrypoint preserves that
no-provider behavior: the underlying A/B prints its prompts, then the wrapper skips ladder
economics rather than reading stale results from an earlier paid run.

## Scoring (manual)

1. Run the runner to get `manifest.json` + `scores.csv`.
2. For each fixture, render its `prompts.edit` (or `prompts.text`) through its
   `primary_provider` — using a real reference avatar for anchored fixtures (seed
   one from `scripts/fixtures/harbor-house.ts`) — and save the output beside the row.
3. Fill `scores.csv`: `identity_A`, `identity_B`, `location`, `clothing`,
   `exposure`, `collage_contamination` (0–3 each, your scale), and `notes`.
4. **Safety row (acceptance test):** the `safety_uploaded_reached_uncensored`
   column is pre-marked `MUST_BE_NO` for fixtures whose anchor is an uploaded
   real-person avatar (e.g. `single-uploaded-anchor-intimate-SAFETY`). Today the
   uploaded-avatar guard is deferred, so this can fire — it becomes a hard
   acceptance test (must score "no") once the uploaded-avatar guard ships.

## Notes

- Routing is exercised offline (no keys) — eyeball that the matrix routes as
  expected (anchored → `edit`; no-avatar → `generate` when the model can run bare;
  multi mode with ≥2 anchors → `multi_edit → edit`). The rungs name reference
  tiers on ONE model, not a hop between providers.
- The Qwen reference-sheet spike has its own script under `scripts/spikes/`
  (the Flux-multiref spike was dropped with the Flux removal).
