# Regenerate for solo replies

Status: draft (stub — successor-engine backlog item A3, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

A solo (primary-absent) reply persists with no `cutId`, and `runSimRetake`
(`sim-exchange.ts:1768-1803`) gates on a standing co-present scene before its
fallback — but a solo turn happened precisely because there is no standing
scene. Regenerate therefore always 409s ("no open scene to re-render") while
the primary is away — broken for exactly the replies the world-UI slices made
possible. (MED · S/M)

## Why it matters

Regenerate is a core affordance (ruling 18: same-cut re-render); it silently
failing in solo play reads as a broken app.

## Sketch

Branch `runSimRetake` for a solo/`cutId:""` target: re-render via the solo
renderer (no engagement required), same take-browsing semantics.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
