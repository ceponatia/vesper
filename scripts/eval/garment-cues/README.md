# Garment cue narrator comparison

This is the missing instrument for the garment-cue lane. It compares the production garment treatment against the current legacy outfit path without changing `CHAT_GARMENT_CUES` or touching a real chat.

The treatment arm receives the production authoritative wardrobe digest and the production bounded, repeat-gated garment cue block. The control arm receives the same character, premise, scene, story time, legacy outfit phrase and player turns, but neither graph block. Each arm keeps its own generated history.

The run measures four things the plan names:

- **Contradiction:** an arm-blind judge audits each exchange against the committed garment store. A counted violation requires a verbatim quote that the runner can find in the reply.
- **Repetition:** the judge identifies unchanged clothing details re-announced on consecutive exchanges; quotes are verified before counting.
- **Concrete detail and naturalness:** absolute 1–5 per-arm scores, never comparative scores anchored against the other transcript.
- **Extraction accuracy:** a separate fixed corpus runs the production continuity extractor prompt, schema, agent model route and opaque garment handles, then scores fixture-owned operation/handle fields. Narrator arms start from authoritative stores so a poor extractor call cannot confound the prompt comparison.

## Commands

```bash
# Free, model-free corpus and prompt self-check
pnpm tsx scripts/eval/garment-cues/run.ts --dry-run

# Full narrator A/B, arm audits and extraction corpus
pnpm tsx scripts/eval/garment-cues/run.ts

# One narrator scenario while tuning the instrument
pnpm tsx scripts/eval/garment-cues/run.ts --scenario wetness-false-premise

# Override models or output directory
pnpm tsx scripts/eval/garment-cues/run.ts \
  --chat-model deepseek/deepseek-v3.2 \
  --judge-model google/gemini-3.5-flash \
  --out data/eval/garment-cues/run-1
```

`OPENROUTER_API_KEY` is required for a live run. `--skip-extraction` is available for narrator-only troubleshooting, but a promotion decision should not use a run that skipped the extraction corpus.

The runner writes `trial.json` with prompts, replies, raw audits and extraction proposals, plus a compact `summary.json`. It deliberately does **not** flip the production flag or manufacture a pass/fail promotion rule. The owner reviews the evidence, fixes the treatment or corpus if necessary, and records the eventual ship/park ruling in the plan.

## Fixed corpus shape

The narrator matrix includes:

- a one-sided rolled sleeve followed by an unchanged turn;
- a soaked-to-damp progression with an explicitly false dry premise;
- a local mud deposit on the player's left jean cuff followed by an unchanged turn;
- an ordinary stable-clothing control where the treatment has a digest but no cue.

The extraction matrix includes roll, local deposit and doff/left-in-room operations. Every case builds its handle table from the production store; fixture text never supplies a hidden name matcher.

## Reuse

Campaign-neutral mechanics live in `scripts/eval/narrator-comparison/harness.ts`: production streaming, independent histories, deterministic arm ordering and quote verification. A later visual-state or narrator-guidance campaign should add its own fixtures and judge rather than copy this runner or reopen the closed affordance-cue campaign.
