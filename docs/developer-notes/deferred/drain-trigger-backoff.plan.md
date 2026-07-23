# Drain vs retrying trigger — stop and settle later

Status: draft (stub — successor-engine backlog item A6, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

A transient trigger error backs the trigger off, which hides it from
`nextDueStorySecond`; `drainBranchTo` then re-loops immediately, the clock jumps
to the drain target, and the deferred event lands mis-stamped — breaking §12.4
partition invariance (`scheduler-store.ts:718-733`, `sim-exchange.ts:222-233`).
Review note: the routine re-arm uniqueness keys are sequence-versioned, so this
is a mis-stamp, not a PK collision. (MED · S)

## Why it matters

A `time_budget` catch-up can silently reorder story time against a trigger that
was only transiently unavailable, corrupting the event partition.

## Sketch

Treat `time_budget` catch-ups as stop-and-settle-later: a backed-off trigger
should halt the drain at its due second rather than let the clock leap past it,
so the deferred event re-stamps correctly on the next pass.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
