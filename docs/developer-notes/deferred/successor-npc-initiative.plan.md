# Successor NPC initiative — she reaches out first

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item B11, parked 2026-07-23; promote
per [CLAUDE.md](CLAUDE.md) before building.

Outcome (provisional): A player can be contacted first — a plan proposed, a
follow-up sent — without having typed anything, so that the character reads as
someone with her own day rather than something waiting for input.

## What

The legacy lane's initiative cues (`chat-initiative.ts:77`) have no successor
analog: in the successor lane `continue` just advances the span and the primary
never reaches out first. Port the cue pattern so she can open contact on her
own. (M)

## Why it matters

A partner who only ever responds feels inert. Letting the primary initiate —
send a message, propose a plan, follow up on something — is what makes the world
feel like it has a person in it, not a prompt waiting for input.

## Sketch

Port the legacy cue pattern into the successor lane, grounded in the commitments
seeded by [starter-world-seeds.plan.md](../finished/starter-world-seeds.plan.md) so her
reach-outs are anchored to real obligations and plans. Pairs naturally with
[remote-channels.plan.md](remote-channels.plan.md) — her initiative is what
carries a reach-out while the two are apart.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
