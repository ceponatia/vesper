# Autonomous NPC travel toward due commitments

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item B13, parked 2026-07-23; promote
per [CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can leave a character behind, come back later,
and find her somewhere else because she actually went there, so that "she went
to the square" describes where she is rather than something the story only said.

## What

No code path ever moves an NPC between zones on its own. Routines can't travel
(`routine.ts:390-408` — `begin_sleep|eat_meal|hold` only), and departure policy
only runs inside engagements (`arbiter-store.ts:241-245`). This is the
difference between a narrated illusion and a world that actually relocated her
while the player was gone. (L)

## Why it matters

If the primary never physically moves without the player present, the world is a
backdrop. Autonomous travel toward due commitments is what makes "she went to the
square" true rather than merely narrated.

## Sketch

Give the routine / departure machinery a way to move an NPC toward a due
commitment's destination on its own. Presupposes
[starter-world-seeds.plan.md](../finished/starter-world-seeds.plan.md) (commitments carrying
a `destinationZoneId` to travel toward) and interacts with the
[primary-lod-ruling.plan.md](primary-lod-ruling.plan.md) ruling — whether the
primary's LOD ever arms routine boundaries decides if she can travel at all.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
