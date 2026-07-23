# Drain hardening — honest, durable, correctly-stamped time advancement

Status: **active** (promoted from `deferred/` 2026-07-23; formerly
successor-engine backlog items A5+A6+A7+C15). **Slices 1–4 and 6 shipped
2026-07-23** (C15 telemetry, A5 honesty, A6 backoff + poison-trigger
surfacing, A7 retarget + arrival check — all gated green on the pure suite
and committed). **Remaining: A5 slice 4 (durable leased time jobs) and slice
5 (staged catch-up UI)** — see §Slices. The durable-job runner and the
staged-UI both need infrastructure the shipping session lacked: Postgres to
integration-test the lease/fence/sweep concurrency (unvalidated concurrency
must not ship), and the Fly deploy for UI. The A5 detail doc's escalation
seam and A7's "escalate a still-in-transit actor to the job" both wait on
that runner; until it lands, a short drain settles the remainder on later
turns via the existing `catch_up_required` resume (honest, just not offline).

One plan, four strands, each with its own detail doc carrying the full
evidence, rulings, and per-strand sketch:

| Strand | Detail doc | One line |
| --- | --- | --- |
| Honesty + durable skips (A5) | [drain-hardening.honesty.md](drain-hardening.honesty.md) | No 500 after a committed write; long skips become staged, server-owned jobs. |
| Trigger backoff (A6) | [drain-hardening.backoff.md](drain-hardening.backoff.md) | A retrying trigger halts the drain at its due second — no more mis-stamped story time. |
| Arrival target (A7) | [drain-hardening.arrival.md](drain-hardening.arrival.md) | Drain target ≡ arrival trigger due second; post-drain check with real recovery. |
| Composition diagnostics (C15) | [drain-hardening.diagnostics.md](drain-hardening.diagnostics.md) | Half-failures recorded durably on both surfaces, admin-only. |

Owner rulings are copied into engine.spec §39 (rulings 22–25,
[engine.spec.operations.md](engine.spec.operations.md)); the detail docs keep
the full versions with alternatives-rejected context.

## Goal

Time advancement — the drains behind skips, travel, and turn preparation — is
today dishonest under partial failure (500s after committed writes), silently
wrong under transient failure (a backed-off trigger mis-stamps its event,
breaking §12.4 partition invariance), latently wrong under future travel
uncertainty (drain-to-earliest vs trigger-at-expected), and unobservable when
it degrades (log-only fallbacks). This plan makes drains honest, durable,
correctly stamped, and measured.

## Design requirements from the 2026-07-23 GPT review

A cross-model review of the fleshed stubs surfaced real architectural gaps,
verified against the code the same day and adopted here (details in each
strand's doc):

1. **A dedicated job table, not `sim_outbox`.** `sim_outbox` rows are keyed to
   a committed source event with a sequence range and per-consumer uniqueness
   (`schema.ts:1357-1396`) — disposable delivery coordination, not general
   jobs. A skip is durable player intent plus progress: it gets its own small
   `sim_time_jobs`-shaped table (or a committed `time_advance_requested`
   event with an atomically-created obligation — decide at build; leaning
   the table).
2. **The runner needs leasing and fencing.** There is no production outbox
   worker loop to reuse (the claim/lease functions exist but only the memory
   indexer and the soak harness consume them, lazily). The detached-promise +
   boot-sweep runner must therefore carry its own discipline: one active job
   per branch, claim owner + lease expiry, retry availability, fenced
   progress writes, and clean behavior across deploy/restart.
3. **A durable job-active guard, not just UI blocking.** Once the original
   request returns, the in-process `chat_exchange` lock is released while the
   job keeps draining — so every mutation entry point (send, sim-command,
   headless sim-turn, admin branch commands) must consult the durable job
   state and turn away while a time job is active on the branch. The composer
   disable is polish on top, not the mechanism.
4. **A poison-trigger policy.** Triggers have a terminal `failed` state
   (`scheduler-store.ts:468, 594`); a drain that skips over a terminally
   failed trigger and calls the skip complete would, for an arrival trigger,
   strand the traveller permanently. A failed trigger inside a job's window
   blocks the job's completion and surfaces through C15 + the admin
   inspector for repair — never a silent success.
5. **Mid-drain retargeting.** A `journey_delayed` firing during a drain can
   push `expectedArrivalAt` past the job's target; the runner re-reads the
   journey target between steps and extends, rather than completing to a
   stale second.
6. **Recovery, not just observability, for stranded arrivals.** The A7
   post-drain check escalates a still-in-transit traveller to the durable
   job (which resumes until arrival) rather than only logging — that is what
   makes "never a stuck character" true rather than aspirational.
7. **Public-safe diagnostics in message meta.** Transcript meta reaches the
   client; persisted meta carries only stable public-safe codes, with
   exception text and private causes confined to the admin telemetry rows.

## Slices (build order — live defects first)

C15 lands first deliberately: it baselines how often live turns degrade
before the fixes change the numbers.

1. **C15 — contract + recorder + reply-meta + inspector tally** (S/M) —
   **SHIPPED 2026-07-23** (`300e8d9`): `contracts/turns/composition-fallback.ts`
   (vocabulary + tally + labels, pure-tested), `server/engine/composition-diagnostics.ts`
   (recorder + `CompositionFallbackCollector`), the eight warn sites wired,
   reply meta at both persist sites (public-safe codes + the previously-dropped
   solo render diagnostics), `server/memory/composition-fallback-log.ts` + admin
   route + `ChatInspectorCompositionHealth` panel.
2. **A5 slice 1 — honesty** (S) — **SHIPPED 2026-07-23** (`dbcc955`):
   `drainBranchTo` returns an honest `DrainResult` (reached second + short
   reason); the three composites return 200 + `drainShort` instead of a
   `drain_diverged` 500, recorded via C15.
3. **A6 — `trigger_backoff`** (S) — **SHIPPED 2026-07-23** (`dbcc955`): the
   distinct catch-up reason (carrying `availableAt`); `drainBranchTo` /
   sim-shadow / rollout-world / admin loops stop on it; poison-trigger
   surfacing (`terminalFailures` → `trigger_failed` code). Deterministic
   poison-continue int test added; the retry-parking/partition-invariance int
   test needs a dispatch-throw mock (follow-up).
6. **A7 — retarget + arrival check** (S) — **SHIPPED 2026-07-23** (`38b4b6a`):
   `moveArrivalTarget` → `expectedArrivalAt`; `noteStillInTransit` after every
   travel drain records + warns (the job-escalation half waits on slice 4). The
   divergent-journey int test (synthetic `expectedArrivalAt > earliestArrivalAt`)
   is follow-up.
4. **A5 slice 4 — durable time jobs** (M) — **REMAINING**: the `sim_time_jobs`
   table (migration), leased/fenced runner, boot/next-request sweep, escalation
   seam in `advance_time`, the branch job-active guard at every mutation entry
   point, the poison-trigger block. **Blocked on infra:** needs `pnpm db:generate`
   for the migration and a Postgres run to integration-test the lease/fence/sweep
   (unvalidated concurrency must not ship). A7's arrival-check escalation and the
   A5 detail doc's mid-drain retarget both hang off this runner.
5. **A5 slice 5 — staged catch-up UI** (S) — **REMAINING**: world-card progress
   while a job runs; landing beat on completion. Follows slice 4 and is
   UI-tested against the Fly deploy.

_Slice numbering keeps the original build-order labels (1, 2, 3, 6 shipped;
4, 5 remaining) rather than renumbering, so commit messages and the detail
docs still resolve._

## Open questions

Carried in the detail docs (each §Open questions): runner drive mechanism,
job-status surface, mid-skip interaction, travel's need for the job path
(honesty), sub-second backoff deferral (backoff), diagnostic code naming and
walk-with-me uncertainty coverage (arrival), code granularity and beat-write
recording ownership (diagnostics).

## Tripwire (retained from A7 ruling 4, now a floor)

Travel uncertainty / mid-trip delays MUST NOT ship before this plan has: the
delay feature must both bump `journey.expectedArrivalAt` and reschedule the
durable arrival trigger, with ruling-2's check as the net. Recorded in
[deferred/travel-duration-authoring.plan.md](deferred/travel-duration-authoring.plan.md).
