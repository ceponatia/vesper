# Gate 0 evidence closeout

Status: **COMPLETE — ADVANCE**

- Evidence branch: `engine-gate0-closeout`
- Implementation base: `engine@95d13c4922a03119f7ced3da2b864c598346f158`
- Evidence commit: `94392d298783f409f5ed90d7b83ab5bb1666dc8e`
- Executed: 2026-07-16
- Protocol version: 1

This document closes Gate 0 of [engine.plan.md](../../finished/engine/engine-foundation.plan.md). It is an evidence
record, not a new architecture proposal. Results are recorded against exact commits and
the decision rules declared before execution. **ADVANCE** authorizes work on Gate 1's
minimum item-transfer authority seam; it does not promote any Gate 0 spike to production
or authorize Gate 2.

## Gate 0 implementation under test

| Work | Merged PR | Implementation |
| --- | --- | --- |
| G0.1 group-retake rollback integrity | #2 | complete |
| G0.2 reproducible baseline harness | #3 | complete |
| G0.3 witness eligibility spike | #4 | complete, default off |
| G0.3 schedule-kind shadow spike | #5 | complete, no effects |
| G0.3 grounded-context ablation | #6 | complete, eval only |

## Exit decision

| Criterion | Result | Evidence |
| --- | --- | --- |
| Retakes restore every member | **PASS** | Real-Postgres regression covers one primary plus two non-primary members, exact per-member rollback anchors, and removal of discarded values across the complete tested state surface. |
| Baseline is reproducible | **PASS** | Pinned 11-case manifest, stable corpus hash, prompt hashes, replay/report unit tests, and a zero-call dry run. |
| At least one spike improves a declared quality dimension | **PASS** | Witness eligibility eliminates all controlled cross-viewpoint fact and episode leaks while preserving global rows and the legacy control. |
| No experiment is silently promoted | **PASS** | Witness reads remain default off; schedule classification is read-only shadow code with effects blocked; grounding remains eval-only. |
| Repository remains healthy | **PASS** | Canonical CI passed lint, cycle detection, typecheck, 2,500 unit tests, and copy/paste detection. Database CI passed all 262 integration tests. |

Gate 0 therefore exits **ADVANCE**. The witness experiment is the evidence-bearing spike;
the other two spikes retain their narrower verdicts below.

## Evidence runs and environment

- Canonical repository run: [CI run 197](https://github.com/ceponatia/vesper/actions/runs/29520529824)
- Exact-commit evidence run: [Gate 0 Evidence run 2](https://github.com/ceponatia/vesper/actions/runs/29521388220)
- Runner: Ubuntu 24.04, Node 22.23.1, pnpm 10.12.1
- Database: disposable repository Postgres 17 + pgvector image
- Database mode: `AI_FAKE=1`; no provider-backed generation or embedding calls
- Model calls made by this closeout: **0**

The evidence workflow checked out the evidence head SHA rather than the PR merge ref. It
was temporary, branch-scoped, and removed after both archives passed. GitHub retains the
run, logs, checks, and artifacts independently of that cleanup.

## Automated repository and no-spend results

### Canonical repository gate

`pnpm verify` passed:

- ESLint with zero warnings;
- no circular dependencies across 777 processed files;
- TypeScript typecheck;
- 171/171 unit-test files and 2,500/2,500 tests;
- `jscpd` using the checked-in configuration.

Relevant permanent eval tests included:

- `scripts/eval/engine-baseline/report.test.ts`: 3/3;
- `scripts/eval/schedule-kind/classifier.test.ts`: 38/38;
- `scripts/eval/narration/grounding.test.ts`: 2/2;
- `src/server/memory/retrieval.test.ts`: 5/5.

### Pinned baseline manifest

The dry run wrote 11 assembled cases without a model call:

| Field | Value |
| --- | --- |
| Corpus version | `gate0-baseline-v2` |
| Corpus hash | `012d4b0ff38c6efd1e679fbff5ff409b6051f0f1de71198841000723fc12e24c` |
| Model setting | `aion-labs/aion-2.0` |
| Prompt profile | `concise_immersive` |
| Temperature | `0.2` |
| Seeds | `3` |
| Manifest file SHA-256 | `fefb0179933dca4dd2ab4553a306c8cfc10d6d9a901264ff587aed4b0c66c811` |

Report tests prove saved rows can be summarized and replay-scored without regenerating
prose. The manifest pins authored setup, state before and after, complete assembled
prompts, and per-prompt hashes.

### No-spend spike preparation

- schedule fixtures: 33/33 correct, 100% labeled accuracy, zero false-positive hard effects;
- grounded-context dry run: exactly two cells, one pre-shower treatment and one
  post-shower control, with one model/profile/reasoning/seed configuration;
- grounding prompt transcript SHA-256:
  `7beff7c91c62f34b6578d8a48f26c8f999aff0bd2f130791e3f72849c2037fea`;
- unit tests prove the grounding pair has byte-identical player input and assembled
  prompts that differ only in the deterministic redacted context value.

The clean no-spend archive is
[artifact 8384838884](https://github.com/ceponatia/vesper/actions/runs/29521388220/artifacts/8384838884),
digest `sha256:cf0d6cb32122bc951c9427f3b992be8730c50714473d5cdb7ee53d1675ebd5dd`.
Its internal checksum manifest excludes itself and covers every payload file. GitHub's
configured retention expires 2026-08-15.

## Database and authored-data results

The isolated database job built the repository image, created and migrated the database,
ran every integration suite without file parallelism, seeded the authored world, audited
its schedule prose, captured database diagnostics, uploaded evidence, and removed the
container and volume.

### Integration regressions

- 22/22 test files passed;
- 262/262 tests passed;
- zero skipped files or tests;
- duration: 42.74 seconds.

The group-retake regression creates Mara, Nia, and Oren, giving every member distinctive
baseline state. It contaminates the discarded take across scalar regard, familiarity,
mind note, outfit, memory queries, open loops, surfaced cues, callback history,
relationship history, milestones, feeling, and drives. After regenerate, every member's
rollback anchor equals their original baseline and no settled member contains their
discarded marker. The same suite also proves an older reach-back rerun returns
`rerun_requires_branch` without changing transcript or state.

### Witness treatment/control

The real-Postgres memory fixture passed all declared checks:

- the observer retrieves observer-only facts and episodes;
- the other participant cannot retrieve those rows;
- the other participant retrieves their own private rows;
- global rows with an empty witness set remain visible;
- a pinned fact cannot bypass witness eligibility;
- eligibility runs before recent-window and top-k limits;
- the legacy no-viewpoint control retrieves all three visibility classes;
- facts and episodes follow the same fence.

Result: **zero deterministic cross-viewpoint leaks in the controlled fixture**, with no
new model call and no regression in the legacy control. This is a measurable improvement
to the declared perspective-leak dimension and satisfies the Gate 0 spike criterion. It
does not claim that the spike is a complete belief or disclosure system.

### Seed and schedule audit

The deterministic Harbor House seed completed with 6 locations, 2 characters, 25 items,
10 lore chunks, 10 pseudo-embedded lore chunks, and 33 refreshed pseudo search
embeddings.

The authored schedule audit found:

| Classification | Rows |
| --- | ---: |
| Matched | 1 |
| Ambiguous | 2 |
| Unknown | 7 |
| Total | 10 |
| Coverage | 10% |

The only match was explicit `sleeping`. The ambiguous rows were the compound shower/radio
description and coffee/toast/tide-tables description. Three rows entered the hard-effect
manual-review queue. This is the desired safe failure mode, but **10% coverage is strong
evidence against using text inference as runtime authority**. New and edited schedules
still need a typed kind; the adapter should be deleted after migration.

The clean database archive is
[artifact 8384866281](https://github.com/ceponatia/vesper/actions/runs/29521388220/artifacts/8384866281),
digest `sha256:3a31a79dd3d5d7d6b065b2ae5dd7eba0194ed28f235e94fe5995c3407c11c0fd`.
Its integration log SHA-256 is
`a854a04d741f75d4b6dc3f49e37a2d67660799e924d6e1c74bec094f2465fee1`.
GitHub's configured retention expires 2026-08-15.

## Per-spike verdicts

| Spike | Verdict | Consequence |
| --- | --- | --- |
| Witness eligibility | **PASS as Gate 0 evidence** | Supports the successor's perspective-first architecture. Keep the old-lane flag default off; Gate 4 still owns normalized beliefs, disclosure, contradiction, and production rollout. |
| Schedule-kind inference | **PASS as a shadow safety probe; reject runtime promotion** | The classifier abstains safely, but authored coverage is only 10%. Add typed schedule contracts rather than expanding regex authority. |
| Grounded-context ablation | **READY, not quality-scored** | Prompt isolation and the dry run pass. Do not adopt the treatment based on fixture construction alone; live paired narration and blind review remain required. |

## Live model and manual quality evidence

No live narrator or judge calls were made because there was no explicit spend ceiling or
available `OPENROUTER_API_KEY`. This does not block Gate 0: the predeclared witness
treatment/control independently satisfies the spike exit rule, and the grounded-context
result is explicitly not promoted.

Before Gate 1 can claim its latency and narration acceptance criteria, run the pinned live
baseline and record p50/p95 latency, tokens, call count, degraded legs, transcripts, and
manual review. If the grounded-context experiment is reconsidered for production, run its
five paired seeds and blind judge under the already declared 80% identification rule; do
not reuse this Gate 0 verdict as narrative-quality evidence.

## Promotion safety

- `MEMORY_WITNESS_ELIGIBILITY` remains opt-in and defaults to the legacy unfiltered path;
- schedule classification lives under `scripts/eval`, performs no writes, and emits
  `productionEffectsAllowed: false`;
- grounded context lives only in the eval corpus and adds no runtime model leg;
- no schema or feature default was changed by evidence collection;
- the disposable evidence database and volume were removed;
- the temporary evidence workflow was removed from the closeout branch.

## Final verdict

**ADVANCE to Gate 1.**

Gate 0 repaired the known rollback invariant, produced a reproducible baseline corpus,
demonstrated a controlled perspective-leak improvement, and kept every spike behind its
declared boundary. Gate 1 may now build only the minimum item-transfer authority seam in
the plan. This verdict does not enable a spike in production, authorize Gate 2, or erase
the requirement for a cost-approved live latency and narration baseline before Gate 1
acceptance.
