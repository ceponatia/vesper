# The primary's LOD story — an owner ruling

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item B9, parked 2026-07-23; promote
per [CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can watch the character they spend all their
time with sleep, eat, and move through her own day, so that the one person
always on screen stops being the only one the living world never touches.

## What

The primary defaults to `exact` LOD, but the routine controller only arms at
`event` LOD (`lib/simulation/routine.ts:334-336`,
`lib/simulation/lod.ts:313-325`). At `exact` she is mechanically inert forever
(never sleeps/eats/moves); at `event` her rhythms fire but she sits on the
background tier built for non-co-stars. Which way to resolve this is an owner
ruling. (ruling + S–M)

## Why it matters

This is the review's headline pathology: the primary — the one NPC the player is
always with — is the one NPC the living-world machinery never touches.

## Sketch

Depends entirely on the ruling below; the "real fix" option (arm routine
boundaries at `exact` too) is the largest and lets the primary keep `exact`
fidelity while still living.

## Open questions

Resolve the LOD story for the primary:

- Stay `exact` and lean on B8's seeded commitments for her aliveness.
- Accept the `event` fidelity trade — her rhythms fire on the background tier.
- Let routine boundaries arm at `exact` too (the real fix).

(owner ruling required at promotion)

## Slices

_(Defined at promotion.)_
