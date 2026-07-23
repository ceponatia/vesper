# Drain honesty — no 500 after commit, server-owned long skips

Status: draft (successor-engine backlog item A5, parked 2026-07-23; **fleshed
out 2026-07-23 — owner rulings 1–3 recorded below**; still parked — promote per
[CLAUDE.md](CLAUDE.md) before building. Graduates **bundled with A6
[drain-trigger-backoff](drain-trigger-backoff.plan.md), A7
[arrival-target-mismatch](arrival-target-mismatch.plan.md), and C15
[composition-diagnostics](composition-diagnostics.plan.md)** as one
drain-hardening plan — see A7 §Owner rulings.)

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
  target, write a durable skip-intent row (branch, target second — the
  `sim_outbox` shape) and hand the remainder to a detached server-side runner
  (fire-and-forget continuation; the machine is always on). A boot-time /
  next-request sweep re-launches unfinished jobs so deploys can't strand one.
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
- Can the player interact mid-skip? A message sent while a skip job is
  draining lands on a mid-skip clock. Leaning: the skip UI blocks input while
  a job is active on this chat's branch (matches today's modal skip feel);
  revisit if skips ever run long enough to matter.
- Does `travel` ever need the job path, or is bounded-window + honest-short
  sufficient there? (Journey drains are short by construction.)
