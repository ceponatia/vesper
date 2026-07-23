# Composed sim-commands — idempotency + per-chat lock

Status: draft (stub — successor-engine backlog item A1, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Every sim-command POST mints fresh envelope ids server-side
(`sim-shared.ts:56-67`, fresh `newId()` per composed step), so the
command-runner's idempotency fast-path can never dedupe two submissions of the
same user action, and the route takes no per-chat lock (the send path's
`chat_exchange` keyed lock has no analog). Double-tapping a skip chip advances
time twice and writes two beats; the same class applies to `travel`,
`do_activity`, and `travel_together`. (HIGH · S/M)

## Why it matters

The most likely bug to be hit in normal play — one impatient double-tap
doubles a time skip.

## Sketch

Client-minted idempotency key in the request body, threaded with per-step
suffixes into each composed envelope so a retry hits the cached result; take
the same keyed per-chat lock the send path uses. Ties into
[move-together-atomicity.plan.md](move-together-atomicity.plan.md) (resumable
steps want stable keys).

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
