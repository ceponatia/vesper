# Scene-image eval harness

The composer-model A/B and the orientation/staging beats it grades. This is
**not** a `pnpm test` gate — the pure graders and helpers beside these scripts
are, and the paid probe is run by hand.

## What's here

- `beats.ts` — the seven orientation/staging beats (`behind`, `glance`, `kneel`,
  plus the four intimate acceptance scenes `doggy`, `oral`, `oral_guided`,
  `missionary`, owner-specified 2026-08-10) as resolved specs + composer context,
  shared so `composer-model-ab.ts` grades the exact same beats a render A/B would
  — two probes disagreeing about what "doggy" is would make their gradings
  incomparable. A beat's composer entry carries what the shot planner reads (name,
  outfit, coverage) and nothing about the subject's looks: a render describes a
  person from their committed visual cut, which a text-only beat has no chat to
  commit. The render-side A/B that used to own these definitions
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
- `model.ts` — the Replicate edit-model handle the Qwen reference-sheet spike
  under `scripts/spikes/` renders through.

The offline render-prompt runner (`run.ts`) and its hand-written
`SceneRenderPlan` fixtures (`fixtures.ts`) were retired with #251, the way #356
retired the render A/Bs: they built prompts through the scene prose builder,
and a chat scene's prompt is now a compiled prompt program over each cast
member's committed visual cut — there is no prose builder to run a fixture
through, and a fixture has no cut to compile. Git history preserves both. The
sent prompt for a real scene is on its image row, and the Image Lab's staged
bench (`apps/web/src/server/images/image-lab-staged.ts`) compiles the same
program for one staging on demand.

```
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

## Notes

- Scene routing is one model's degradation ladder (multi-reference edit →
  single-reference edit → bare prompt), not a hop between providers; a rung
  whose prompt program will not compile is dropped from the chain
  (`apps/web/src/server/images/scene.ts`).
- The Qwen reference-sheet spike has its own script under `scripts/spikes/`
  (the Flux-multiref spike was dropped with the Flux removal).
