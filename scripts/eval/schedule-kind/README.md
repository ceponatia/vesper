# Schedule-kind shadow spike

Gate 0 experiment for the successor simulation engine. It asks whether the
current free-text `ScheduleEntry.activity` values can be classified precisely enough to
justify later typed schedule effects.

The answer is measured in shadow mode. This code does not change the schedule contract,
persist a kind, move a character, alter a body meter, or run in a turn.

## Run

```bash
pnpm eval:schedule-kind --fixtures-only
pnpm eval:schedule-kind
pnpm eval:schedule-kind --limit 100
```

The default run reads character profiles and writes
`data/eval/schedule-kind/audit.json`; it performs no writes. Use `--fixtures-only`
without a database.

## Classifier behavior

`inferScheduleKind` uses anchored, high-precision rules over the complete activity
phrase. It returns:

- `matched` with one kind, rule ids, and high/medium confidence;
- `ambiguous` when different semantic kinds match or a compound has an unknown part;
- `unknown` when no complete rule matches.

This is intentionally unlike loose keyword matching. “Prepare for work” is not a work
shift, “put the child to bed” is not the actor sleeping, and “shower and coffee” is
ambiguous rather than hygiene or a meal. A compound is accepted only when every segment
resolves to the same kind (“shower and brush teeth”).

The locked vocabulary is `sleep | meal | hygiene | work | travel | exercise | social |
leisure`. Sleep, meal, hygiene, and travel are marked hard-effect candidates because a
false positive could fabricate physiology or location.

## Evidence and decision rule

The audit contains:

- a labeled fixture result and confusion matrix;
- fixture accuracy and hard-effect false-positive count;
- every authored schedule row with its classification;
- matched/ambiguous/unknown coverage and kind distribution;
- a manual-review queue containing every authored hard-effect candidate.

The command exits 2 if the curated corpus is not exact or any unresolved fixture is
classified as a hard effect. Even a passing run remains blocked from production effects:
the profile rows are unlabeled, text remains an unstable authoring contract, and coverage
does not establish correctness. The spike may justify a typed `ScheduleEntry.kind`
migration and explicit author/editor support; it must not justify silently calling this
classifier from simulation code.
