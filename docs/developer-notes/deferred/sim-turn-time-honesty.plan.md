# Turn-time honesty — solo drains through the shared seam, beats that don't lie

Status: **draft** — parked in [deferred.plan.md](../deferred.plan.md); not
committed work. Successor-engine backlog item F23, parked 2026-07-24 from the
successor engine & chat-UI product review; promote per [CLAUDE.md](CLAUDE.md)
before building.

Outcome (provisional): A player can trust that a line saying she arrived means
she has arrived, so that the transcript stops narrating finished journeys and
completed activities the world has not actually finished.

## What

Two server-side honesty gaps left after drain-hardening shipped:

**1. Solo turns bypass the bounded drain.** `runSimSoloTurn` calls
`advanceBranchStoryTime` once and discards the returned outcome
(`sim-exchange.ts:1893-1903` — try/catch → `simLoadWarn`, no
`noteDrainDiagnostics`, no `settleStrandedInTransit`, despite
`input.fallbacks` being in scope at `:1883`). Because it's a single call
rather than the `drainBranchTo` loop (`:292-324`), a `trigger_budget` /
`trigger_backoff` return leaves the clock short of even the +60s span —
the turn renders at a silently under-advanced clock with no diagnostic and
no escalation to a durable time job. Every other flow routes through the
shared seam (departure `:1337`, accompany `:1557`, travel/skip
`sim-command/route.ts:320, 418`). (MED · S)

**2. Completion beats are written before completion.** Travel writes its
beat unconditionally before arrival is known (`sim-command/route.ts:344-351`;
"You walk to …" — `world-beat.ts:78-80`) and `do_activity` writes a
completed-sounding beat ("You rest a while.", `:91-95`) even though
completion is a scheduled trigger that may not have fired
(`route.ts:438-444`). The durable-job machinery that eventually converges the
*state* exists (A5/A7, shipped); the *transcript* still tells a finished
story up front, and nothing writes a landing beat when the job completes
later. (MED · S/M)

## Why it matters

The transcript is the record players trust. A beat that narrates an arrival
that hasn't happened — over a projection that says `in_transit` — is exactly
the class of dishonesty the drain-hardening plan was promoted to kill; these
are its two remaining leaks. The solo gap also loses diagnostics the
resilience law requires (degradation must be recorded, not swallowed).

## Sketch

- Route solo advancement through `drainBranchTo` (or a shared
  `advanceWithEscalation` helper): record fallback codes via
  `noteDrainDiagnostics`, report the actually-reached second into the render
  context, escalate to a durable time job when work remains — same contract
  as the chip paths. Coordinates with A2's tolerant-advance ruling (the
  at-least clamp) rather than duplicating it.
- Word beats by lifecycle: departure beat at accept ("You set out toward …"),
  landing/completion beat written by the durable time job when the projection
  confirms (`accepted → in_progress → completed | failed`), with F22 showing
  the in-progress state in the meantime.

## Open questions

- Does the deferred completion beat come from the time-job runner (server
  prose with no narrator call — matches current beat style) or ride the next
  turn's cut?
- Should `do_activity`'s response gain a `status: "in_progress"` member
  instead of always `"performed"` (client schema change, F22 consumes it)?

## Slices

_(Defined at promotion.)_
