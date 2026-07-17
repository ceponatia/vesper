# E2.4 — durable scheduler and deterministic draws

Status: **shipped — 2026-07-17**

Completion note: all nine implementation steps landed, including the R1 advance seam and
the R3 lease rework. Two rulings changed during implementation and are recorded in place:
**R2** (the derivation version moved to the trigger row — `sim_events.derivation_version`
turned out to be a *perception* field, not a causation one) and **R3** (claim-time attempts
alone do not bound a crash loop; claim-time *quarantine* was added). Leftovers, none
blocking: the E2.3 outbox shares the unbounded-reclaim gap R3 fixes here (see §Followups);
draw integration and analytical rate integration are deferred with owners named below.

Depends on E2.3 at `d492e7605dc7d8d4eae9fdbed144593d26a646f1` (PR #13). This target adds durable
trigger identity, claim/retry semantics, stable simultaneous ordering, a bounded story-time
advance seam, and named random streams. It does not add movement, bodies, rates, model calls,
forks, or snapshots.

Work in progress on `engine-e2.4-scheduler` (PR #14). The branch already carries a contract and
store scaffold; this plan supersedes the assumptions that scaffold was built on. Sections marked
**correction** describe a defect in the current head `50329e3` that must be repaired, not new scope.

## Outcome

A trigger scheduled at a future story second resolves exactly once, through the same branch
command transaction that a player command uses, with the same idempotency and ordering
guarantees. A worker may crash mid-resolution, lose its lease, retry, or run concurrently with
another worker without duplicating an event, poisoning a trigger permanently, or reordering
simultaneous work.

Advancing a branch's story time is the only thing that makes a trigger due. Advancement is
therefore part of this target: without it no trigger can ever fire, and E2.5 (forks/snapshots)
and E2.6 (soak/verdict) have no credible place to add it.

## Rulings this plan makes

The first attempt left three questions unresolved. They are settled here.

### R1 — E2.4 owns a bounded advance/drain seam

The spec's normative advance algorithm (§12.2) currently has no implementation, and the store
only claims triggers already behind `sim_branches.story_second`. Nothing moves story time, so the
scheduler is unreachable in production.

E2.4 implements `advanceBranchStoryTime(branchId, toStorySecond)`:

1. find the next due trigger at or before the target;
2. process all triggers at that story second in stable order;
3. append material events and schedule resulting triggers;
4. repeat until no trigger is due;
5. set branch story time to the target.

**Analytical rate integration is explicitly out of scope** — steps 2 and 6 of §12.2 integrate
continuous rates, and no continuous rate exists in the repository until Gate 5 bodies. The seam
must be shaped so integration slots in without redesign, and the omission is recorded here rather
than silently skipped.

Catch-up bounds (§12.3) are in scope: a caller declares a maximum trigger count and wall-clock
budget; exceeding it persists a safe partial boundary and returns `CATCH_UP_REQUIRED`. Triggers
are never skipped.

**Two spec corrections came out of implementing this** (both amended in `engine.spec.md`):

- **§12.2 — the clock must step to each trigger's own due second before that trigger resolves.**
  The original step list set branch story time last, which reads as "drain, then set the clock."
  Because an event takes its story second from the branch clock, an implementation that jumps to
  the target first stamps every drained event with the target and silently violates §12.4 —
  `advance(T0,T3)` disagrees with the equivalent partitions despite draining the same triggers.
  The first implementation had exactly this bug. The spec now carries the step and the reason.
- **§12.1 — `stableOrder` was missing from the normative queue order.** The spec ordered by
  dueStorySecond → priority → trigger ID, but `priority` had no column and trigger ID is a
  derived hash, so simultaneous triggers ordered arbitrarily. `priority` now exists (default 0,
  no producer yet — headroom for Gate 3 urgency) and `stableOrder` is the documented tie-break
  ahead of ID.

### R2 — derivation version is wired now; draw integration is deferred

**Revised during implementation.** The original ruling said scheduler-caused events would stamp
`schedulerDerivationVersion` into `sim_events.derivation_version`. That was wrong:
`derivationVersion` is contractually `z.literal("gate1-perception-v1")` and records how the
event's captured `observerActorIds` were derived. It is a *perception* field, not a causation
one, and overloading it would have corrupted its meaning.

What shipped instead:

- **Trigger→command→event provenance already existed** and needed nothing new:
  `sim_triggers.result_command_id` → `sim_events.command_id` is the complete causal chain.
- **The scheduler ruleset version lives on the trigger row.** `sim_triggers.derivation_version`
  records which scheduler produced each terminal outcome. Spec §12.1 makes queue order part of
  the ruleset version, so a later scheduler revision must stay distinguishable in history.
- **Draw integration defers to the first stochastic consumer.** `transfer_item` consumes zero
  draws. Wiring one would mean inventing a stochastic element solely to exercise the primitive,
  or adding a test-only kind to a production enum. Neither is honest. The primitive and its
  property tests stay; the first real use is Gate 3 lateness/travel, which must record stream,
  index, value, and derivation version on the event that consumed it.

This accepts that "named random streams" ships as a tested primitive rather than an integrated
path. The alternative — pulling a stochastic Gate 3 trigger kind forward — widens the target
materially and was declined.

### R3 — lease and attempt semantics mirror E2.3's outbox, plus claim-time quarantine

The scheduler reinvented E2.3's consumer semantics and got them wrong. It adopts them instead:

- attempts increment **at claim time**, inside the claim transaction, via `UPDATE … RETURNING`;
- every state write is fenced on `(id, state = 'processing', lease_owner = workerId)`;
- a `lease_lost` outcome exists and is returned rather than silently overwritten;
- diagnostics carry trigger, branch, due second, attempt, and kind.

**Extended during implementation.** Claim-time increments alone do *not* bound a crash loop.
Nothing marks work terminal except the failure path, and a worker killed mid-resolution never
runs its own failure path — so an exhausted trigger would be reclaimed forever, attempts
climbing past `maxAttempts` without ever reaching `failed`. Claiming therefore either takes the
work or **retires** it: a candidate already at the ceiling is marked `failed` with a diagnostic
and skipped.

## Corrections to the current head

### C1 — the migration is orphaned and ungeneratable

`drizzle/meta/_journal.json` ends at `0055`, there is no `0056_snapshot.json`, and the canonical
migrator reads the journal — so `drizzle/0056_e2_4_durable_scheduler.sql` never runs and
`sim_triggers` does not exist on a from-zero database. The root cause is placement: `drizzle.config.ts`
points only at `schema.ts`, while `simTriggers` lives in `src/server/db/scheduler-schema.ts`, where
drizzle-kit cannot see it. That is why the SQL was hand-written.

Fold `simTriggers` into `schema.ts`, delete `scheduler-schema.ts` and the hand-written SQL, revert
the `client.ts` schema-merge and the `db/index.ts` re-export, and regenerate `0056` with a real
journal entry and snapshot. `pnpm db:generate` may hit the interactive create-vs-rename prompt;
per CLAUDE.md that is an owner decision and must not be automated around.

Delete `void simWorlds;` with the file.

### C2 — CI is red (run 29574308164)

Lint, cycles, and typecheck pass; two of four E2.4 unit tests fail, which skipped every
migration-from-zero and PostgreSQL step.

- **Backoff cap is unreachable.** `Math.min(900, 2 ** Math.min(attempt - 1, 9))` clamps the
  exponent at `2⁹ = 512`, so the declared 900-second cap can never bind and attempt 11 returns 512.
  The test is correct; the implementation is wrong. Raise the exponent clamp above the cap
  (`Math.min(attempt - 1, 20)` keeps `2ⁿ` far inside safe-integer range while letting 900 bind).
- **The command fixture uses an obsolete envelope.** `commandPrincipalSchema` is `.strict()` and
  requires `{ kind, principalId, controlledActorIds }`; the fixture passes `{ kind, id }`, which
  fails on both the unknown key and the two missing ones.

### C3 — expected-version admission poisons triggers permanently

`resolveNextDueTrigger` reads `branch.version` **outside** the command transaction. A concurrent
command advancing the branch makes the scheduler's command conflict — and because the idempotency
key is derived permanently from the trigger ID, the conflict result is **persisted under that key**.
Every later retry replays the stored conflict, so the trigger can never succeed. This is permanent
poisoning, not a delay.

Optimistic version checks exist to protect a client that read state and then acted on a stale read.
The scheduler has no stale read: it holds a lease and acts on a committed payload. Admit
scheduler-origin commands at the branch version read **inside** the command transaction. Keep the
permanent idempotency key — it is what makes retry safe.

### C4 — result status is ignored

The store marks every outcome `completed` regardless of whether the command was accepted, rejected,
or conflicted. Switch exhaustively:

| Result | Trigger state | Rationale |
| --- | --- | --- |
| `accepted` | `completed`, record `result_command_id` | resolved |
| `rejected` | terminal `failed`, record code and public reason | a business-rule refusal is permanent; retrying cannot help |
| `conflict` | retry while `retryable`, else terminal `failed` | should be unreachable after C3; if it fires, C3 has regressed |

### C5 — cross-branch dispatch

A trigger on branch A may carry a command template targeting branch B: nothing enforces matching
IDs, and resolution spreads `...template`, preserving its `branchId`. Enforce equality of both
`branchId` and `worldId` in a zod `.refine()` on the trigger schema **and** as a database check
constraint over the payload JSON, then have resolution derive routing from the trigger row rather
than trusting the template.

### C6 — the store is unreachable and untested

`scheduler-store.ts` is absent from `src/server/engine/simulation/index.ts`, so nothing can import
it through the intended public API and nothing does. (It does not currently trip the ESLint
boundary rule — the import would be relative — but the barrel is the intended surface.) Export it,
and give the 205-line database store direct PostgreSQL coverage; the four pure tests do not touch it.

## Implementation order

1. This plan, and its three rulings.
2. Fold `simTriggers` into `schema.ts`; regenerate `0056` with journal and snapshot (C1).
3. Fix backoff and the command fixture to get CI green (C2).
4. Rework claim/retry around claim-time attempts and fenced ownership (R3).
5. Fix version admission, result-status handling, and branch/template validation (C3–C5).
6. Implement the bounded advance/drain seam and `CATCH_UP_REQUIRED` (R1).
7. Stamp `schedulerDerivationVersion` on scheduler-caused events (R2).
8. Export the store; add PostgreSQL concurrency/crash/idempotency tests, `pnpm test:engine-e2-4`,
   and a CI step after the E2.3 step (C6).
9. Update `docs/database.md` and `docs/contracts/simulation.md`; correct the roadmap, which still
   lists E2.2 as active and never recorded E2.3. Run from-zero CI.

## Required tests

Pure (6 cases, `src/contracts/simulation/scheduler.test.ts`):

- backoff is deterministic, monotonic to the cap, and reaches exactly 900;
- trigger identity is delimiter-safe and stable;
- named draws are stable, isolated across streams, and isolated across draw indices;
- a trigger whose template targets another branch fails validation.

PostgreSQL (15 cases, `scheduler-store.int.test.ts`) — partition invariance moved here from the
pure list: it is a property of the durable advance seam, not of a pure function.

- a due trigger resolves exactly once and advances the branch;
- migration-from-zero creates `sim_triggers` (this is what C1 broke, and only a from-zero run catches it);
- two workers racing one due trigger produce one event and one `lease_lost`;
- a crash between command commit and trigger completion does not duplicate the event on retry;
- a repeated crash reaches `maxAttempts` and quarantines as `failed` rather than looping forever;
- an expired lease is reclaimable, and the superseded worker cannot overwrite the new owner's state;
- a concurrent command advancing the branch does not conflict, reject, or poison the trigger (C3);
- a rejected command marks the trigger terminally failed and records its code;
- simultaneous triggers at one story second resolve in stable order across repeated runs;
- catch-up exceeding its declared bound persists a partial boundary, returns `CATCH_UP_REQUIRED`,
  and skips nothing;
- triggers on different branches progress independently;
- each drained event is stamped at its own due second, not the advance target (§12.2 step 3);
- one skip and equivalent partitions produce the same material outcome (§12.4).

## Exit criteria

E2.4 advances when from-zero CI proves single resolution under concurrency, crash-safe retry
without duplication, bounded quarantine, stable simultaneous ordering, branch isolation, partition
invariance across the advance seam, and no cross-branch dispatch. Record command p95 delta,
trigger throughput, oldest pending age, and catch-up duration. A scheduler that can duplicate an
event, poison a trigger permanently, or silently skip one means revise rather than advance.

## Explicit deferrals

- Analytical rate integration inside advance waits for Gate 5 bodies (R1).
- Draw integration waits for the first stochastic consumer at Gate 3 (R2).
- Branch forks, snapshots, and cross-branch semantics belong to E2.5.
- The synthetic-month soak and the Gate 2 verdict belong to E2.6.
- Movement, commitments, and live-scene arbitration belong to Gate 3; a trigger must not set
  location directly when they arrive.
- `LISTEN`/`NOTIFY` wakeups, multi-trigger batching, and a background worker loop require measured
  volume evidence; E2.4 resolves on demand.

## Followups

**E2.3's outbox has the same unbounded-reclaim gap R3 fixes here.** Its claim query
(`outbox-store.ts`) reclaims `processing` rows whose lease expired without bounding `attempts`,
and only its catch block writes terminal state. A consumer that hard-crashes rather than
throwing is therefore reclaimed indefinitely and never quarantines. It was left alone
deliberately: it is shipped E2.3 code, and fixing it here would widen a scheduler PR into the
outbox path. It is real, it is not urgent (the crash must be a process death, not an exception),
and it should be a small dedicated change — carry the claim-time quarantine across.

## Open questions

1. **Advance authority** — may any command advance story time as a side effect, or is advancement
   an explicit operation? E2.4 assumes explicit; Gate 3's live-scene arbiter will need a ruling
   before it drains triggers mid-turn.

Resolved: *R2's draw deferral* (defer to Gate 3's first stochastic consumer — see R2).
