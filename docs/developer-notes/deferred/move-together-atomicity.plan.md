# travel_together atomicity — a real move_together command

Status: draft (stub — successor-engine backlog item A4, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

The walk-with-me choreography commits scene-end, player move, and NPC move as
three independent transactions (`sim-exchange.ts:1309-1383`). A process death
after the player's move strands the pair: player in transit, primary at the
origin, scene ended, no beat — and a retry refuses with `not_copresent`
("isn't here to walk with you"). The in-process `traveled_alone` degrade never
runs on a crash. (MED · M)

Review note for confidence: the `npc_policy` accompany envelope itself
(`principalId:"sim-accompany"`) was audited and is lawful — authorization keys
on `controlledActorIds`; nothing assumes npc_policy envelopes originate only
from the arbiter.

## Why it matters

The marquee romance feature has a crash window whose failure state is
unrecoverable through the UI.

## Sketch

A dedicated branch-locked `move_together` command committing scene-end + both
moves atomically — or resumable step sequencing on stable idempotency keys
(ties into [sim-command-idempotency.plan.md](sim-command-idempotency.plan.md)).

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
