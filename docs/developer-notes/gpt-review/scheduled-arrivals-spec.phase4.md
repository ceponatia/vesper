# GPT review: Scheduled arrivals & appointments

Source: [../scheduled-arrivals-spec.phase4.md](../scheduled-arrivals-spec.phase4.md)

## Overall opinion

The core design is sound: an appointment should be runtime state that deterministically opens a normal staged movement intent early enough for an NPC to arrive near the agreed time. It correctly avoids recurring authored schedules and avoids teleporting by prose.

The biggest change I would make is appointment creation ownership. The source spec recommends a director `scheduleArrival` proposal, but the code now has an intake-side appointment seam. `IntentBrief.appointment` stores `{ withNpc, location, timePhrase, reason }` in `src/contracts/turns/intent-brief.ts:68`, and the intake prompt explicitly extracts appointments at `src/server/engine/prompts/intake.ts:20`. That should be the primary proposal source for player-arranged appointments.

## Gaps and mismatches

- The spec is behind the current code on creation. Director-only `scheduleArrival` now duplicates the pre-narration classification work. The current blocker is that merge does not receive the persisted brief: `src/server/engine/pipeline.ts:799` calls `applyTurnResults` without `intentBrief`, and `src/server/engine/merge.ts:2021` (`ApplyTurnInput`) has nowhere to put it.

- The proposed appointment record lacks lifecycle fields. The spec sketches `{ id, participantId, destinationLocationId, arrivalMinute, reason, onArrival, threadId? }`, but without `status`, `openedStagedIntentId`, `createdAtTurn`, `resolvedAt`, or `cancelledReason`, a completed appointment can be hard to dedupe or audit. `runtime.stagedIntents` is pruned on arrival by `src/server/engine/movement.ts:231`, so an appointment record needs its own lifecycle if it persists.

- There is an ordering trap around staged movement. Existing staged intents advance before new director intents are appended at `src/server/engine/merge.ts:1617`, so a newly opened appointment intent would normally wait until the next turn for its first hop. Also, newly opened intents are not automatically added to the `stagedThisTick` set before the schedule tick at `src/server/engine/merge.ts:1715`. If appointment opening happens in the wrong slot, a routine schedule can still relocate the NPC in the same merge.

- Time parsing is underspecified. The intake seam stores raw `timePhrase`; `src/lib/clock.ts:36` resolves already-known clock minutes but does not parse "5:30", "after dinner", or the intended day. The spec should define the parser boundary and degraded behavior.

- "Director is time-blind" is accurate today: `src/server/engine/agents.ts:175` (`buildDirectorPrompt` call site) receives turn number, locations, threads, staged intents, and prior brief, but not the open appointment list or current clock as a scheduling surface. If the director remains involved, its prompt needs different state.

## Improvements I would make

- Treat intake as the source of player-made appointment proposals. Use the director only for director-originated appointments or for optional story payloads attached to an appointment that intake already recognized.

- Add `runtime.appointments` with a lifecycle schema:
  - `status: "pending" | "staged" | "arrived" | "missed" | "cancelled"`;
  - `arrivalClockMinutes`;
  - `createdAtTurn`, `updatedAtTurn`;
  - `stagedIntentId?`;
  - `resolvedAtTurn?`, `cancelledReason?`.

- Put appointment handling in a pure reducer next to staged movement: resolve names, parse time, dedupe, compute lead window, open staged intent, mark lifecycle, emit diagnostics. Load it through `sessionRuntimeSchema` so malformed JSONB degrades through the existing parse boundary.

- Start v1 with a forgiving hop/tick lead model. `nextHopToward` returns `travelMinutes`, but `src/server/engine/movement.ts:223` (`applyStagedIntents`) still moves one hop per tick. The first version should use hop count plus an ordering buffer, not promise exact minute arrival.

- Define missed/blocked behavior as data, not only narrator guidance. If no path exists or the appointment is too late, persist that status and surface one next-turn communication or directive.

## Things I do not think are a good idea

- Do not make director-only `scheduleArrival` the v1 path. It sees the completed narration, not the player's raw agreement point, and it would duplicate intake's existing appointment extraction.

- Do not edit authored schedules for one-off appointments. The spec is right that schedules recur and teleport; appointments should be runtime goals.

- Do not chase to-the-minute arrivals in v1. The engine currently does one post-turn schedule tick and skips intermediate schedule windows across long rests; precise simulation belongs later.

- Do not keep the dev teleport once appointment staging is inspectable. The dev-only route at `src/app/api/sessions/[id]/participants/[participantId]/teleport/route.ts:8` is useful right now, but it bypasses exactly the rules this system is supposed to prove.

## Test additions I would expect

- Intake appointment creates a pending runtime appointment once, with name/time/location diagnostics on failure.
- A pending appointment opens a staged intent at the lead threshold and does not retrigger after arrival.
- Newly opened appointment intents are protected from same-merge routine schedule overrides.
- Blocked path produces a missed/late/cancelled appointment outcome plus a diagnostic and brief/comms surface.
- Long rest or large time jump handles appointments deterministically rather than silently skipping them.
