# Scheduled arrivals & appointments — findings + spec

> **Resequenced 2026-06-14:** this work is now **phase 5**. A standalone **phase 4**
> (the body-model build) was inserted ahead of it — see
> [intimate-anatomy-sensory-and-species-spec.phase4.md](finished/intimate-anatomy-sensory-and-species-spec.phase4.md).
> This file was renamed from `*.phase4.md` and its body now reads "phase 5" throughout.

Status: **findings / draft for discussion** (2026-06-13). Phase 5 ("the world
moves"). Sibling of [npc-movement-spec.phase3 (drives & traversal)](finished/npc-movement-spec.phase3.md)
and [movement-authority-spec.phase5 (who may commit a move)](movement-authority.spec.md).
This one answers a third question neither poses: **how does an NPC come to be
somewhere at a particular game-clock time** — a player-arranged appointment, not
a routine and not a player-narrated shove.

When `phase-5-plan.md` is authored, the open questions at the bottom fold into
its `## Open questions` per the docs convention.

## Problem — the date nobody can keep (session `pyfb0hznglqkqj35ezjvjcxh`)

The player and Eleanor Vance arranged a date at **Brian's apartment at 5:30pm**.
Eleanor is at **Town Hall**, ~3 non-adjacent hops away on the link graph. The
question: *is there any mechanism that gets Eleanor to the apartment by 5:30?*

**No — not as a clock-driven appointment.** Off-screen multi-hop traversal
exists, but nothing aims it at a clock time. The two relevant systems and why
each misses:

### What exists

1. **Director-staged off-screen movement** — the multi-hop walker, and it works.
   `engine/movement.ts` `applyStagedIntents` advances a `StagedIntent` one hop
   per turn toward its destination; `nextHopToward` is BFS shortest-path over the
   session link graph, reusing `checkLinkAccess` (locked doors, time-windowed
   links). It fires an on-arrival comms/directive. Integrated in
   `merge.ts:1606–1713` (tick runs before the schedule tick so a committed NPC
   isn't yanked back to routine; newly-staged intents take their first hop *next*
   turn). It would walk Eleanor Town Hall → … → apartment over N turns. The
   *traversal* capability is not the gap.

2. **Schedule tick** — `merge.ts:1715–1749` + `scheduleEntryAt` (`merge.ts:689`)
   relocate an off-screen NPC to match their **authored daily routine** for the
   current minute-of-day. It's a teleport (`p.locationId = target`), keyed to
   recurring weekly windows in `ParticipantSnapshot.schedule`. A one-off,
   player-arranged date is not in Eleanor's authored schedule, so it never fires;
   and even hand-authored it would recur every day and snap rather than travel.

### The gap — three missing pieces

1. **`StagedIntent` is turn-budgeted, not clock-scheduled.**
   `contracts/state/session-runtime.ts:83–112` has `openedAtTurn` +
   `expiresInTurns` (a give-up budget in *turns*) and **no** `arrivalMinute` /
   `targetTime`. Nothing connects an intent to 5:30.
2. **The director is time-blind.** `buildDirectorPrompt`
   (`engine/prompts/agents.ts:229–271`) is fed `turnNumber`, present/absent NPCs
   + their locations, locations, threads, prior brief — but **not the game
   clock** and no structured appointment. It cannot reason "it's 5:15, she's 2
   hops out, stage her now." At best it stages on narrative vibe from a thread,
   and once staged she leaves *immediately* and arrives whenever that lands.
3. **No appointment / goal / agenda state at all.** There is no per-NPC "be at X
   by T". `npc-movement-spec` reserves the slots ("Schedule drive", "Goals/threads
   drive") but they are explicitly **not started**.

### What actually happens at 5:30

Whatever the narrative model improvises — most likely Eleanor *materialises* at
the apartment with no grounded journey. That is the same teleport-by-prose
state/narration decoupling that [movement-authority.spec.md](movement-authority.spec.md)
was written about (it post-mortems this *same* session). If the director happened
to stage her earlier off a thread, she walks over, but arrival is untied to 5:30.

## Design — clock-keyed appointment → auto-staged intent

The hard part (the multi-hop off-screen walker) already exists. The missing
piece is a **clock-keyed appointment that auto-opens a `StagedIntent` at the
right lead time**, executed deterministically in the merge (which already knows
the clock — `resolveGameTime(clockMinutes, …)` at `merge.ts:1614`). Split of
labour: the LLM recognises *that* an appointment was made; the engine does the
*when-to-set-out* math.

1. **Appointment record** (new `runtime` field, e.g.
   `runtime.appointments: Appointment[]`):
   `{ id, participantId, destinationLocationId, arrivalMinute, reason, onArrival, threadId? }`.
   `arrivalMinute` is absolute game-minutes (or minute-of-day + day) — reuse the
   clock helpers in `lib/clock.ts`.
2. **Creation** — the director gains a `scheduleArrival` proposal alongside
   `stageMovement` (it already proposes movement; this is the timed sibling), and
   is fed the **current game clock** + the open-appointments list. The director is
   good at spotting "it's a date, 5:30, my place" from the turn; making the record
   is a small contract addition.
3. **Deterministic trigger** — in the staged-intent tick, for each appointment
   compute the path length (BFS — `nextHopToward` already does the graph walk;
   expose a `distanceTo`/`hopCount`). When
   `now ≥ arrivalMinute − leadTime(hops)`, auto-open a normal `StagedIntent`
   toward the destination. This reuses `applyStagedIntents` wholesale — **no new
   traversal code**. On arrival the intent's `onArrival` beat fires as today.
4. **Forgiving timing** — off-screen hops are one-per-turn and only loosely
   coupled to minutes, so don't promise to-the-minute arrival: open the intent
   once the appointment is within a lead window and let her arrive at/near the
   time. Late-but-grounded beats teleport-on-time.

This is the concrete shape of the unbuilt "Schedule drive / Goals drive" — a
player-arranged appointment is just an externally-authored goal with a deadline.

## Interim — dev-only teleport (shipped 2026-06-13)

Until the above exists, the Cast tab has a **dev-only** "⚡ Teleport to me" button
on each off-location NPC's card (`components/play/participant-card.tsx`, gated on
`NODE_ENV !== "production"` client-side; route
`POST /api/sessions/:id/participants/:participantId/teleport` rejects in
production). It snaps the NPC to the player's location, bypassing the link graph,
adjacency, travel time, and movement authority. It is a debugging shortcut for
exactly this gap — manually keep the date the engine can't yet schedule. Remove
it (or fold it behind the appointment system's inspector) once scheduled arrivals
land.

## Open questions

- **A. Who creates the appointment** — a director `scheduleArrival` proposal
  (LLM recognises the deal, engine handles timing) vs. a deterministic detector
  over an agreed "date/plan" story thread with a parsed time. Recommended:
  director proposal, mirroring `stageMovement`.
- **B. Lead-time model** — hop-count × per-hop minutes, or "open the intent when
  within a fixed lead window (e.g. 30–60 game-min)". Interacts with the loose
  turn↔minute coupling and `resolveTurnMinutes`.
- **C. Missed/late arrival** — if she can't make it in time (path blocked, staged
  too late), does she arrive late, send an on-the-way comms, or cancel with a
  narrator beat? Couples to the on-arrival beat and `expiresInTurns`.
- **D. Player appointments** — does the same record drive *player* reminders /
  auto-routing, or NPC-only for v1?

## Docs to update when implementing

`turn-engine.md` (merge: appointment tick → staged-intent open), `prompts.md`
(director `scheduleArrival` contract + game-clock context), `contracts.md`
(`runtime.appointments` schema, director result `scheduleArrival`), and a
cross-link from [npc-movement-spec](finished/npc-movement-spec.phase3.md) (this supplies
the timed-goal driver its "Schedule/Goals drive" describes). Retire the dev
teleport button + route.
