# Gate 0 evidence closeout

Status: **IN PROGRESS — HOLD**
Evidence branch: `engine-gate0-closeout`
Implementation base: `engine@95d13c4922a03119f7ced3da2b864c598346f158`
Protocol version: 1

This document closes Gate 0 of [engine.plan.md](engine.plan.md). It is an evidence
record, not a new architecture proposal. Results are recorded against exact commits and
predeclared decision rules; a failed experiment remains a useful result and is not tuned
away after inspection.

## Gate 0 implementation under test

| Work | Merged PR | Implementation |
| --- | --- | --- |
| G0.1 group-retake rollback integrity | #2 | complete |
| G0.2 reproducible baseline harness | #3 | complete |
| G0.3 witness eligibility spike | #4 | complete, default off |
| G0.3 schedule-kind shadow spike | #5 | complete, no effects |
| G0.3 grounded-context ablation | #6 | complete, eval only |

## Exit criteria

| Criterion | Required evidence | Current result |
| --- | --- | --- |
| Retakes restore every member | DB integration regression for primary plus two non-primary members | pending |
| Baseline is reproducible | pinned corpus manifest/hash plus report tests | pending |
| At least one spike improves a declared quality dimension | controlled treatment/control result with no new deterministic leak | pending |
| No experiment is silently promoted | production import/flag/schema inspection | pending |
| Repository remains healthy | canonical `pnpm verify` | pending |

The Gate 0 verdict remains **HOLD** until every required row has evidence. `advance`
requires all exit criteria; `revise`, `hold`, or `stop` must name the failed seam.

## Reproducible execution protocol

### A. Canonical no-spend checks

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm eval:engine-baseline --dry-run
pnpm eval:schedule-kind --fixtures-only
pnpm eval:narration --scenarios chat-contrast-grounding --profiles concise --dry-run
```

Capture the workflow URL, commit, corpus version/hash, pass/fail result, duration, and
generated manifest hashes.

### B. Isolated database checks

```bash
docker compose up -d --wait
pnpm db:create
pnpm db:migrate
AI_FAKE=1 pnpm test:int
AI_FAKE=1 pnpm db:seed
AI_FAKE=1 pnpm eval:schedule-kind
```

The database is disposable. Record integration test totals/skips and the authored schedule
audit's matched/ambiguous/unknown distribution, hard-effect queue, confusion matrix, and
fixture false positives.

The witness experiment advances only if its controlled fixture proves:

- observer-only rows are retrievable by the observer;
- the same rows are absent for a non-observer;
- global rows remain eligible;
- pinned facts cannot bypass eligibility;
- eligibility is applied before top-k/recency limits;
- the legacy control still retrieves all rows.

This deterministic perspective-leak reduction is sufficient for Gate 0's “at least one
spike” criterion if the complete repository and integration suites find no regression.
It does not promote the feature flag or substitute for Gate 4's belief ledger.

### C. Live narrator evidence

Live calls are not part of CI. Use the pinned model/profile/seeds and preserve raw results:

```bash
pnpm eval:engine-baseline --model aion-labs/aion-2.0 --seeds 3
pnpm eval:narration --scenarios chat-contrast-grounding --profiles concise --models aion --seeds 5 --no-judge
EVAL_JUDGE_MODEL=google/gemini-3.1-pro-preview pnpm eval:narration:compare --axis contrast
```

Predeclared call envelope:

- baseline: 11 cases × 3 seeds = 33 narrator calls;
- grounding: 2 variants × 5 seeds = 10 narrator calls;
- grounding blind judge: 5 paired judgements;
- maximum planned total: 48 model calls, excluding a retry of a degraded provider leg.

Do not retry a valid low-quality output. Retry only a recorded provider/degradation failure
and retain both attempts. Before execution, confirm the provider's current price and stop if
the estimated run exceeds the owner's approved spend ceiling.

### D. Manual review

Review successful baseline and grounding rows blind to treatment where pairing permits.
Record:

- voice fidelity and chemistry;
- continuity and causal enactment;
- perspective leakage;
- contradiction or hard-state repair;
- exposition burden;
- NPC agency.

The grounding spike requires at least 80% blind identification, cue separation, no new
deterministic leak, and no median voice/chemistry decline. A grounding failure does not
block Gate 0 when the witnessedBy spike independently passes the exit criterion.

## Results

### Automated repository and no-spend checks

Pending.

### Database and authored-data checks

Pending.

### Live model and manual quality checks

Pending explicit spend authority and an available `OPENROUTER_API_KEY`.

## Final verdict

**HOLD — evidence collection in progress.**

Gate 1 must not begin from this document until the verdict is updated with exact evidence
and changed to **ADVANCE**. No Gate 3 product ruling is required to complete Gate 0 or the
minimum Gate 1 item-transfer seam.
