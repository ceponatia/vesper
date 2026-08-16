# World engine — E2.6 Gate 2 soak and verdict

Status: **shipped — 2026-07-17** (verdict: **advance** — Gate 2 closed; Gate 3 is next
and remains blocked on its 10 product rulings, engine.plan.md §"Product rulings needed
before Gate 3")

The closing target of Gate 2 in [engine.plan.md](../../finished/engine/engine-foundation.plan.md) §"Gate 2 build order".
Unlike E2.1–E2.5 this builds no new kernel capability: it stress-runs everything the
previous five targets shipped against the §"Required proofs" list, then records the
owner's **advance / revise / hold / stop** ruling before any Gate 3 (movement,
actions, live-scene) work is permitted to start.

Contract: [engine.spec.md](../../engine.spec.md) §12.4 (partition invariance), §33
(diagnostics), §35 (observability), §36.2 (property tests). Prior targets:
[engine-durable-branch-transaction.plan.md](engine-durable-branch-transaction.plan.md)
(E2.2), [engine-outbox-rebuildable-consumers.plan.md](engine-outbox-rebuildable-consumers.plan.md)
(E2.3), [engine-durable-scheduler.plan.md](engine-durable-scheduler.plan.md) (E2.4),
[engine-forks-snapshots-audit.plan.md](engine-forks-snapshots-audit.plan.md) (E2.5).

## What E2.6 must prove (from engine.plan.md)

| # | Required proof | Harness mechanism |
| --- | --- | --- |
| P1 | A large time skip and equivalent partitions produce the same material outcomes | Schedule an identical trigger workload on one root, fork children A and B at the same sequence (E2.5 fork inherits the pending alarms), advance A to month-end in one skip and B in daily partitions, compare **normalized material outcomes** (event tuples, final holdings, clock, version, head sequence — branch-identity fields stripped, entity IDs mapped to stable seed indices) by `simulationHash` |
| P2 | A scheduler retry cannot duplicate an event | Chaos-month trigger resolutions run under the derived permanent command identity; post-soak SQL scan asserts each completed trigger has exactly one event, each failed/rejected trigger has zero |
| P3 | A stale command fails with a structured conflict | Chaos month deliberately submits stale-`expectedVersion` commands; asserts `status: "conflict"` with `currentVersion` and `retryable`, then a fresh retry is accepted |
| P4 | A crashed outbox consumer resumes idempotently | Chaos month injects `crashAt: "after_projection_write"` on a drawn fraction of consumptions; asserts the failed row carries a structured `lastError`, the retry completes, and the final feed equals a from-zero rebuild row-for-row |
| P5 | Every path-dependent derived decision records the value or inputs and derivation version that caused history | Post-soak scan: every event row carries `derivationVersion`; every `item_transferred` payload carries the captured `observerActorIds`; every terminal trigger row carries `derivationVersion` and (when completed) `resultCommandId` |
| P6 | Rebuild from events matches live projections | `rebuildDurableBranchProjection` from **zero** and from **snapshot** on the chaos root and both partition children (`matches: true`, equal hashes); incremental feed rows equal `rebuildItemTransferFeed` output |

Gate 2 exit (engine.plan.md): *"The kernel can run for a simulated month of synthetic
commands and triggers with stable hashes, bounded queue growth, no duplicate outcomes,
and useful diagnostics."* Mapped to harness assertions:

- **simulated month** — story time advances 0 → 2,592,000 s in both soak worlds;
- **stable hashes** — P1 material-hash equality across partitionings + P6 rebuild
  equality; the normalized material hash is profile-deterministic, so two full runs of
  the same profile must print the same hash (demonstrated manually, reported in the
  verdict evidence);
- **bounded queue growth** — pending outbox rows and pending triggers are sampled every
  pump round; max observed depth must stay under the profile's declared cap and both
  queues must drain to zero by month-end;
- **no duplicate outcomes** — event sequences are contiguous per branch, every event
  belongs to exactly one accepted command, duplicate idempotency keys replay the cached
  result (asserted directly), injected command crashes (`crashAt` before and after
  commit) roll back or replay without a second event;
- **useful diagnostics** — every rejection carries a typed code and public reason,
  every conflict carries the current version, and every failed trigger/outbox row
  carries a `lastError` naming the ids involved (spec §33).

## Deliverables

- `src/server/engine/simulation/soak-harness.ts` — `runGate2Soak(profile)`:
  deterministic synthetic-workload generator (named draw streams via
  `deterministicDrawUnit`, seeded by the profile's world seed — reproducible across
  runs) + the proof assertions above, returning a structured `SoakReport`.
- `src/server/engine/simulation/gate2-soak.int.test.ts` — runs the CI-sized profile
  once, then one `it()` per proof domain over the report. Wired as
  `pnpm test:engine-e2-6` and a CI step after E2.5 (zero-state migration, same as the
  other engine suites).
- `scripts/eval/engine-gate2-soak/run.ts` — the full-scale synthetic month (thousands
  of triggers/commands) as a manual developer tool printing the report; never part of
  `verify` or CI.
- The verdict record below, plus the engine.plan.md Gate 2 status note and roadmap
  update.

## Profiles

| Parameter | CI profile | Full profile |
| --- | --- | --- |
| Story-month span | 2,592,000 s (30 d) | 2,592,000 s (30 d) |
| Scheduled triggers (partition world) | 60 | 600 |
| Scheduled triggers (chaos world) | 60 | 600 |
| Direct commands (chaos world) | 60 | 600 |
| Partitions (child B / chaos rounds) | 10 | 30 |
| Injected command-crash fraction | ~1 in 6 | ~1 in 6 |
| Injected outbox-crash fraction | ~1 in 6 | ~1 in 6 |
| Stale + duplicate submissions | ~1 in 8 each | ~1 in 8 each |

Cast: 4 actors, 6 containers (one deliberately capacity-1 to exercise
`destination_full`), 8 items. The generator tracks a due-order in-memory mirror so most
transfers are legal at fire time; deterministic rejections are expected, counted, and
identical across partitionings.

## Exit criteria

E2.6 closes when: the CI profile passes from a zero-state migration in CI; the full
profile passes locally with the evidence recorded here; and the owner's ruling is
recorded below. Any failed proof means **revise** (fix the offending target, rerun)
rather than advance.

## Verdict

**Ruling: advance** — recorded 2026-07-17 by the owner (in-session questionnaire) on
the evidence below. Gate 2 is closed. Gate 3 (space, actions, schedules, live-scene
arbitration) is unblocked as the next engine target, pending its 10 product rulings.

Evidence (full profile, 2026-07-17, local Postgres 17 — 21/21 proof checks, ~44 s):

- **Synthetic month** — both worlds advanced 0 → 2,592,000 s; all clocks landed
  exactly at month-end.
- **P1 partition invariance** — fork children A (one skip) and B (30 partitions) each
  drained 600 inherited triggers; normalized material hashes identical (`80421ced`),
  and a second independent full run reproduced the same hash (cross-run stability).
- **P2/no-duplicates** — all 600 chaos triggers reached terminal state (143 completed,
  457 deterministically rejected — see caveat); sequences contiguous on every branch
  (chaos root head 1152 = 1152 own events = 1152 accepted commands); per-trigger event
  multiplicity exact.
- **P3** — 66 stale submissions all returned structured retryable conflicts carrying
  `currentVersion`; no sequential submit conflicted unexpectedly.
- **P4** — ~100 injected consumer crashes per run resumed idempotently; the 552
  incrementally consumed feed rows equaled the from-zero feed rebuild row-for-row.
- **P5** — zero events and zero terminal triggers missing `derivationVersion`;
  captured `observerActorIds` schema-enforced on every read.
- **P6** — from-zero and from-snapshot rebuilds matched live hashes on the partition
  root, both children, and the chaos root.
- **Queues** — open outbox peaked at 395 (declared cap 700), pending triggers never
  exceeded the 600 scheduled, and every month-completed branch drained to zero.
- **Idempotency** — 54 duplicate idempotency keys replayed cached results
  identically; 79 injected command crashes (rotating all six failpoints) replayed
  exactly once.
- **Diagnostics** — every rejection carried a typed code + public reason
  (`same_container` 91, `destination_full` 46 on the direct lane), every failed
  trigger and crashed outbox row a structured `lastError` naming its ids.
- **Latency** — direct submit p50 2.4 ms / p95 4.1 ms / max 7.8 ms; trigger
  resolution ≈5.6 ms average through the advance loop.
- **Audit** — all 8 chaos items explained causally end-to-end (8 event chains, 3
  through a trigger and its scheduling command).

CI: `pnpm test:engine-e2-6` (12 cases over the CI profile, ~5 s) runs after the E2.5
step from the same zero-state migration; E2.2–E2.5 suites all stayed green alongside.

**Known caveat (accepted, not a defect):** under interleaved direct load, 457 of the
chaos world's 600 triggers were deterministically rejected at fire time — direct
commands had already moved their items, so the templates' source containers were
stale (`source_mismatch`). That is correct kernel behavior (a rejection is a
committed deterministic refusal, quarantined without burning retries) and it
exercised the rejection path at scale, but it means Gate 3's commitment/action design
should expect trigger templates fixed at schedule time to go stale under a live
world — re-validation belongs at fire time, as the kernel already does.

## Open questions

None.
