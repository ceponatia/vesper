# Make composition half-failures observable

Status: draft (stub — successor-engine backlog item C15, parked 2026-07-23;
promote per [CLAUDE.md](CLAUDE.md) before building)

## What

Half-failures in turn composition are invisible in production.
`engine.sim.departure` / `engine.sim.accompany` / `engine.sim.world_beat` are
log-only, and the solo diagnostics are collected but dropped before
persistence (`persistAssistantReply` omits them). When choreography degrades
live — `traveled_alone`, an interrupt fallback — nothing queryable records that
it happened. (HIGH · S/M)

## Why it matters

Degradation is silent: the turn still ships, but there is no signal that a
composition leg fell back. Diagnosing "why did she travel alone?" after the
fact is impossible when the evidence never left the request logs.

## Sketch

Route the composition failures through the existing agent-failure telemetry, or
persist them onto reply meta alongside the reply, so degraded choreography
becomes queryable rather than log-only.

## Open questions

_(To be fleshed out in discussion at promotion.)_

## Slices

_(Defined at promotion.)_
