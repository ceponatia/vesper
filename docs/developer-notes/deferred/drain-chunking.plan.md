# Drain honesty — no 500 after commit, chunked long skips

Status: draft (stub — successor-engine backlog item A5, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building. Owner ruling 2026-07-23:
graduates **bundled with A6 + A7** as one drain-hardening plan — see
[arrival-target-mismatch.plan.md](arrival-target-mismatch.plan.md)
§Owner rulings.)

## What

Two related dishonesty modes in the sim-command drains. (1) `drain_diverged`
returns HTTP 500 from `travel` / `do_activity` / `advance_time` *after* the
world writes already committed, while the exchange path treats the same
condition as warn-and-continue — two paths disagree, and the client sees a
scary error for a world that did change. (2) `advance_time` accepts up to 30
days (`43200` minutes) and drains every due trigger synchronously in-request;
a populated world's multi-day skip can outlive the proxy timeout while the
drain keeps running server-side. (MED · S–M)

## Why it matters

"Degraded defaults over failed turns" is resilience law; a 500 after a
committed write violates it and teaches players the world is flaky.

## Sketch

Never 500 after a committed write — return 200 with `drainedShort: true` + a
diagnostic (the §17 arrival trigger settles on a later turn regardless).
Chunk large skips: drain a bounded window per request and let the client
continue, or hand long drains to the outbox/worker.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
