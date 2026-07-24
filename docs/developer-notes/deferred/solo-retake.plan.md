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

Re-confirmed by the 2026-07-24 product review, which added a second, worse
branch: because the retake's `cutId` falls back to
`latestCutIdForEngagement(...)` (`sim-exchange.ts:2043`), a solo/post-departure
reply that is the last row *while a standing engagement happens to exist*
(e.g. accompany reopened the scene, `:1682-1695`) retakes a **stale, unrelated
cut** over the solo reply instead of 409ing — silently wrong prose, not just a
refusal. The fix should pin the retake to the target message's own
`meta.cutId` (absent ⇒ solo path), never the engagement's latest.

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
