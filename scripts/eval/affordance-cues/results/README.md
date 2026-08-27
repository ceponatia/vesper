# Committed trial results

One file per live round: `<matrix>-<YYYY-MM-DD>.json`, copied from the run's
`summary.json`. Two rounds on the same matrix on the same day get a `-b`, `-c`
suffix.

```bash
pnpm eval:affordance-cues                                   # writes data/eval/affordance-cues/{trial,summary}.json
cp data/eval/affordance-cues/summary.json \
   scripts/eval/affordance-cues/results/rematch-2026-07-29.json
```

Commit that file with the round's trial-doc entry. **This is the audit record.**
`trial.json` — every prompt, reply and judge answer — stays in gitignored
`data/`: it is large, it carries full narration, and it is the thing nobody could
reproduce anyway (production temperature, no seed). `summary.json` is the half
that can live in git:

- **provenance** — fixture commit (and whether the tree was dirty), matrix,
  narrator + judge model ids and temperatures, and digests of the config and of
  each arm's prompts. Two rounds with the same `hashes.prompts.control` sent the
  control arm identical bytes; a changed `hashes.config` means the instrument
  moved, not the feature.
- **measures** — per arm: raw per-dimension verdict counts, verified vs discarded
  violations, and exchanges with any violation (the plan's primary measure).
  `physicalClaims` is optional and absent from every round so far — the
  claim-normalized instrument is future work, and the schema already has room for
  it at `version: 1`.
- **evidence** — every violation that passed quote verification, as a bounded
  excerpt with its arm, scenario and exchange, so a number in a doc can be traced
  to the sentence that produced it.
- **spend** — call counts, approximate tokens, and the OpenRouter key-usage delta
  for the round.

Schema and builder: [`../summary.ts`](../summary.ts) (`trialSummarySchema`,
`version: 1`), guarded by `../summary.test.ts` in `pnpm test`. A new measure is
an added optional field, not a rewrite — bump `version` only when an existing
field changes meaning, and never edit a committed round's file to match a new
shape.

Why this exists: the affordance-cue campaign (three live rounds, $6.29) left its
numbers only as a hand transcription into a trial document, because `data/` is
gitignored. That hole was closed before the next campaign spends anything: the
results committed here are now the durable record.
