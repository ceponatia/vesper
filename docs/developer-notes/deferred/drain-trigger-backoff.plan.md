# Drain vs retrying trigger — stop and settle later

Status: draft (successor-engine backlog item A6, parked 2026-07-23; **fleshed
out 2026-07-23 — engineering ruling below, no product rulings needed**; still
parked — promote per [CLAUDE.md](CLAUDE.md) before building. Graduates
**bundled with A5 [drain-chunking](drain-chunking.plan.md), A7
[arrival-target-mismatch](arrival-target-mismatch.plan.md), and C15
[composition-diagnostics](composition-diagnostics.plan.md)** as one
drain-hardening plan — see A7 §Owner rulings.)

## What

A transient trigger error mis-dates the trigger's event by letting the clock
leap past it. Verified mechanism (file:line captured 2026-07-23 — re-verify on
promotion):

- A transiently failing trigger backs off on the WALL clock:
  `availableAt = now + schedulerRetryDelaySeconds(attempts)`
  (`scheduler-store.ts:617-634`), which hides it from `nextDueStorySecond`
  (`lte(availableAt, now)` — `:652`) until the backoff elapses.
- `advanceBranchStoryTime` itself is correct per call: on retry it stops with
  the clock parked exactly at the trigger's due second (`:729-731`) — but it
  reports the stop as `"time_budget"`, indistinguishable from genuine budget
  exhaustion.
- The looping callers therefore defeat it: `drainBranchTo`
  (`sim-exchange.ts:222-233`) treats every `catch_up_required` as "keep
  draining"; the next call cannot see the backed-off trigger at all, finds no
  due work, and jumps the clock to the drain target — over the hidden
  trigger's head. When the backoff elapses the trigger resolves at whatever
  the clock now reads, stamping its event at the wrong story second and
  breaking §12.4 partition invariance (advance-in-one-go no longer equals
  advance-in-parts). The same defeat exists in `sim-shadow.ts:274-283` and
  `rollout-world.ts:326-335`'s loops.
- The co-present turn path (`arbiter-store.ts:185`) calls advance ONCE without
  looping — it is accidentally correct today: the clock stays parked at the
  due second and the next turn's advance resolves the trigger at exactly that
  second.
- Review note kept from parking: the routine re-arm uniqueness keys are
  sequence-versioned, so this is a mis-stamp, not a PK collision. (MED · S)

## Why it matters

A transiently unavailable trigger — one bad DB round-trip — silently reorders
story time: the event it was holding lands minutes or days after the moment it
was due, and replay/fork determinism (§12.4) no longer reproduces live
history.

## Ruling (engineering, 2026-07-23 — dictated by §12.4, no owner decision)

Stop-and-settle-later, exactly as the stub sketched: a backed-off trigger
halts the drain at its due second. The player-facing consequences are already
governed by the bundle's owner rulings — A5's honest-short response and
server-owned job (which waits out the backoff and resumes), and C15's durable
recording of the pause.

## Sketch

- **Name the stop distinctly:** `advanceBranchStoryTime` returns a third
  catch-up reason, `"trigger_backoff"` (alongside `trigger_budget` /
  `time_budget`), carrying the retrying trigger's `availableAt` so callers
  know when resuming is worthwhile. One-line change at
  `scheduler-store.ts:731` plus the outcome contract.
- **Loops stop on it:** `drainBranchTo` (and the sim-shadow / rollout-world
  loops) break on `trigger_backoff` instead of re-looping, returning an
  honest short result with the reached second. The clock stays parked at the
  due second, so when the backoff elapses the trigger resolves at exactly the
  second it was due — correct stamp, invariance restored. Genuine
  `trigger_budget` / `time_budget` catch-ups keep re-looping (their remaining
  triggers are visible; resuming immediately is correct).
- **Callers need no new UX:** choreographies already warn-and-continue on a
  short drain; post-A5 the routes return the honest 200 shape (reason
  included) and the skip job retries after `availableAt`; post-C15 the pause
  is recorded (`drain_backoff` code).

## Slices

Sized for the bundled drain-hardening plan — this is one S slice.

1. The `trigger_backoff` outcome + loop changes + tests: an int test seeding a
   transiently-failing trigger asserts the clock parks at the due second (not
   the target), the event stamps at its due second once the backoff elapses,
   and a partition-invariance case (advance-in-one-go vs advance-in-parts
   around a mid-drain backoff) converges to identical histories. Degradation
   test asserts the fallback and the recorded diagnostic code
   (docs/resilience.md law).

## Open questions

- Should the drain retry in-request once if `availableAt` is nearly
  immediate (sub-second), or always defer to the next pass? Leaning always
  defer — simpler, and the A5 job makes deferral cheap.
