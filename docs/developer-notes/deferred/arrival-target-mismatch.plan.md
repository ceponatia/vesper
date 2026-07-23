# Drain to expectedArrivalAt — latent arrival mismatch

Status: draft (stub — successor-engine backlog item A7, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Travel drains to `earliestArrivalAt` (`sim-exchange.ts:240-248`) but the §17
arrival trigger is due at `expectedArrivalAt` (`space.ts:414`). The two are
equal today because uncertainty is zero, so nothing breaks yet; the first
`journey_delayed` or any nonzero uncertainty makes them diverge and strands
players in transit — the drain stops before the arrival trigger is due.
(LOW/MED · S)

## Why it matters

A latent mismatch that is invisible now but will strand a traveller the moment
travel uncertainty becomes nonzero — a trap waiting on a future feature.

## Sketch

Drain to `expectedArrivalAt` instead of `earliestArrivalAt` so the drain target
and the arrival trigger's due second always agree.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
