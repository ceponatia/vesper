# Drain honesty — no 500 after commit, server-owned long skips

Status: detail doc of [drain-hardening.plan.md](drain-hardening.plan.md)
(successor-engine backlog item A5; fleshed out and ruled 2026-07-23;
**promoted 2026-07-23** with A6 [backoff](drain-hardening.backoff.md), A7
[arrival](drain-hardening.arrival.md), and C15
[diagnostics](drain-hardening.diagnostics.md) — was
`deferred/drain-chunking.plan.md`.)

## What

Two related dishonesty modes in the sim-command drains. Verified evidence
(file:line captured 2026-07-23 — re-verify on promotion):

1. **500 after committed writes.** `travel` / `do_activity` / `advance_time`
   return `drain_diverged` as HTTP 500 (`sim-command/route.ts:242, 288, 369`)
   *after* the world writes (the move, the started activity, the clock
   advance) already committed — while the exchange path treats the identical
   condition as warn-and-continue (`sim-exchange.ts:1171, 1368`). Two
   contradictory policies for the same event; the client shows a scary error
   for a world that did change.
2. **Unbounded in-request skips.** `advance_time` accepts up to 30 days
   (`.max(30 * 24 * 60)` minutes — `route.ts:51`) and drains every due
   trigger synchronously inside one HTTP request. A lived-in world
   accumulates real triggers over that span (meter crossings, condition
   expiries, circadian re-arms — `lib/simulation/bodies.ts`), and
   `drainBranchTo`'s own budgets allow far longer than any proxy holds a
   connection: the client sees a dead request while the server keeps
   grinding. (MED · S–M)

## Why it matters

"Degraded defaults over failed turns" is resilience law; a 500 after a
committed write violates it and teaches players the world is flaky. And the
skip cap is a product feature (skip a season) sitting on a mechanism that
cannot honor it at scale.

## Owner rulings (2026-07-23 — copy into engine.spec §39 at promotion)

1. **Long skips are staged catch-up.** A skip runs as short server steps;
   while the app is open, the world card shows the world catching up
   ("Day 12 of 30…") until the landing beat arrives. No one-shot request that
   must survive the whole stretch.
2. **The server owns completion.** Once a skip (or travel) starts, the server
   finishes the job whether or not the app is open; when the player returns
   they get whatever the server ended with. Feasibility verified 2026-07-23:
   the Fly machine never auto-stops (`fly.toml`: `auto_stop_machines = 'off'`,
   `min_machines_running = 1`), the durable-job pattern already exists
   (`sim_outbox` — pending/processing/completed/failed with retry delays), and
   the drain is already interruption-proof (every advance persists the branch
   clock; triggers are durable; `catch_up_required` is the built-in resume
   protocol) — a deploy or crash mid-skip loses nothing.
3. **Never a 500 after a committed write.** The routes return 200 with an
   honest shape (what committed, how far time actually moved, whether the
   drain ran short) and the degradation is recorded through C15's
   `composition_fallback` telemetry (`drain_short` / `drain_diverged` codes).
   This one follows from resilience law rather than a product choice — recorded
   for completeness.

## Sketch

- **Fast path stays synchronous:** the route drains one bounded window
  in-request (most travels and short skips finish there) and returns 200 with
  the reached story second. Travel drains are minutes of story time and
  should rarely escalate.
- **Escalation to a durable job:** when the bounded window doesn't reach the
  target, write a durable skip-intent row and hand the remainder to a
  detached server-side runner (fire-and-forget continuation; the machine is
  always on). A boot-time / next-request sweep re-launches unfinished jobs so
  deploys can't strand one.
  - **A dedicated table, not `sim_outbox` rows** (2026-07-23 GPT review,
    verified): `sim_outbox` is event-delivery coordination — rows key to a
    committed source event with a sequence range and per-consumer uniqueness
    (`schema.ts:1357-1396`). A skip is durable player intent + progress, a
    different thing. Ruling 2's feasibility citation stands as *pattern*
    precedent (pending/processing/completed/failed with retry delays), but
    the job gets its own small table (`sim_time_jobs`-shaped: branch, target
    second, state, claim owner, lease expiry, progress) — or a committed
    `time_advance_requested` event with an atomically-created obligation;
    leaning the table.
  - **Leasing and fencing are load-bearing, not polish** (same review):
    there is no production outbox worker loop to copy — the claim/lease
    functions exist (`outbox-store.ts`) but only the memory indexer and the
    soak harness consume them, lazily. The detached-promise + sweep runner
    must itself guarantee: ONE active job per branch, claim owner + lease
    expiry, retry availability on lease lapse, fenced progress writes (a
    stale claimant's write must not land), and clean deploy/restart
    behavior. Without this, a second request or a restart sweep double-runs
    the same job.
  - **A durable job-active guard at every mutation entry point** (same
    review): the in-process `chat_exchange` lock releases when the original
    request returns, while the job keeps draining — so the send route,
    sim-command, headless sim-turn, and admin branch commands must consult
    the job state and turn away (`world_catching_up` face) while a time job
    is active on the branch. The composer/UI block (the open question below)
    is presentation on top of this, not the mechanism. The A2 tolerant turn
    advance ([turn-clock-race](deferred/turn-clock-race.plan.md) ruling 1)
    remains the semantic backstop if a gap slips through.
- **Client staged catch-up (ruling 1):** while a job runs, the world card
  polls (world read or a small job-status read) and renders progress; the
  landing "Time passes…" beat is written by whichever side finishes the
  drain. On reopen after an offline completion, the player simply finds the
  settled world and the beat (ruling 2).
- **Honest response shape (ruling 3):** all three routes stop returning
  `drain_diverged` 500s; the beat already reads the clock, so a short drain
  produces an honest "how far time actually moved" beat with no extra work.
- Interlocks with the bundle: A6 fixes which second a paused drain stops at;
  A7 fixes the drain target; C15 records every short/diverged drain durably.

## Slices

Sized for the bundled drain-hardening plan.

1. **Honesty first (S):** replace the three 500s with the 200 shape +
   C15 recording. No behavior change to draining itself.
2. **Durable skip jobs (M):** the skip-intent row, the detached runner, the
   re-launch sweep, and the escalation seam in `advance_time`.
3. **Staged catch-up UI (S):** world-card progress while a job runs; refresh
   to the landing beat on completion.

## Open questions

- What drives the runner between requests: a detached promise chain kicked at
  job creation + re-launch sweep (leaning), or a small interval tick in the
  server process? (No separate worker process — single-machine deploy.)
- Job-status surface: piggyback on the world read vs a dedicated
  `GET .../sim-jobs` read — decide with the UI slice.
- Can the player interact mid-skip? Settled in mechanism by the review
  addition above (the durable job-active guard turns mutations away
  server-side; the UI disable mirrors it) — what remains open is only the
  face: does the composer grey out with a "world catching up" hint, or stay
  enabled and swallow the bounce into a card refresh?
- Does `travel` ever need the job path, or is bounded-window + honest-short
  sufficient there? (Journey drains are short by construction.)
