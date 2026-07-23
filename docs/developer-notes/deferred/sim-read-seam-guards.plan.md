# Guard the throwing sim read-seams

Status: draft (stub — successor-engine backlog item C14, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Four sim read-seams can 500 the whole state strip.
`readSimChatPresence/Meters/Outfit/Relationship` throw raw at the route
boundary (`sim-surfaces.ts:92/273/316/360`), so one malformed JSONB row kills
the entire state response with a generic 500 — a direct violation of
resilience §7 (degrade at every trust boundary). (HIGH · S)

## Why it matters

A single bad row takes down the whole state strip instead of dropping one
surface. The other three panels, and the turn itself, go dark for a fault that
should be local and diagnosable.

## Sketch

`readSimChatWorld` in the same file is the correct model to mirror: it wraps
the read, degrades to `null` plus a diagnostic on failure rather than throwing.
Apply the same wrap-and-degrade shape to the four throwing seams so a malformed
row yields a missing panel + diagnostic, never a 500.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
