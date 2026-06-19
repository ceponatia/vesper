# Scene-image eval harness

Fixture-driven, **human-scored** quality harness for scene rendering
(scene-images.spec.md §9). This is **not** a `pnpm test` gate — image identity and
quality can only be judged by eye.

## What's here

- `fixtures.ts` — ~14 fixed scenes spanning the routing matrix (one character;
  two clothed; two partial; three characters; character+location; location-only;
  high-risk wardrobe/exposure; uploaded-anchor safety case).
- `run.ts` — offline runner. Computes each fixture's provider routing decision and
  the exact prompt(s) the executor would build, and writes:
  - `data/eval/scene-images/manifest.json` — inputs / chain / primary provider / prompts
  - `data/eval/scene-images/scores.csv` — one row per fixture with blank manual-score columns

```
pnpm tsx scripts/eval/scene-images/run.ts        # writes manifest + scores template
EVAL_OUT=/tmp/eval pnpm tsx scripts/eval/scene-images/run.ts
```

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
  expected (anchored → `venice_edit → venice_generate`; no-avatar → `venice_generate`;
  multi mode with ≥2 anchors → `venice_multi_edit → venice_edit → venice_generate`).
- The Qwen reference-sheet spike has its own script under `scripts/spikes/`
  (the Flux-multiref spike was dropped with the Flux removal — scene-images.plan.md).
