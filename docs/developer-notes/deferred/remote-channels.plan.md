# Text and voice when apart — remote engagement channels

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item B10, parked 2026-07-23; promote
per [CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can text or call a character while the two are
apart, instead of only reading a vignette about her, so that the hours between
meetings become time they can act in.

## What

The engagement contract already defines remote channels
(`contracts/simulation/engagements.ts:28`), but the successor lane only ever
opens `co_present` engagements (`sim-exchange.ts:121`). When the player and the
primary are separated the player gets a one-way audience vignette and cannot
text or call her — the highest-value missing interaction for a romance product.
(M–L)

## Why it matters

Being apart is the normal state between meetings; today it is a dead zone.
Remote channels turn the time-apart from a narrated void into live, reachable
contact — the core of a romance experience.

## Sketch

Open a remote engagement (text / voice) when the two are not co-present, driving
narration through the already-defined remote channel rather than the co-present
path. Relates to [../deferred.plan.md](../deferred.plan.md) §"Comms expansions"
(the legacy-lane texting ideas parked there).

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
