# World UI — the player-facing surface of the successor world

Status: next (planned 2026-07-23 from the owner's world-UI design pass; owner rulings
20–21 recorded in [engine.spec.operations.md](engine.spec.operations.md) §39)

The successor engine's world is live but invisible. The starter world really exists —
home, town square, a 5-minute walkable link, the neighbor, the keepsake
(`src/server/engine/simulation/starter-world.ts`) — but **no world state reaches the
browser at all**: no zone, destination, travel-time, locus, or inventory field appears
anywhere in `src/lib/client/api.ts`. Of the five typed player commands the API accepts
(`move` · `end_scene` · `give_item` · `start_activity` · `advance_time`,
`src/app/api/chats/[chatId]/sim-command/route.ts:26-42`), only `advance_time` is wired
to a client method. This plan installs the sidewalks: a read surface, in-chat controls,
and the small set of game systems those controls force into existence.

## Findings that shape the plan (verified 2026-07-23)

- **Movement mid-scene is not refused — it lawfully interrupts.** `resolveMoveActor`'s
  only claim gate is a *body* claim held by an activity
  (`src/server/engine/simulation/space-store.ts:563-577` queries `simActivities` only;
  engagements hold attention claims and are never consulted). An accepted move breaks
  the mover's co-present scene in the same transaction
  (`interruptCoPresentEngagementsForActor`, `space-store.ts:657-676`, per spec §18.2).
  The R5 leftover "scene-exit choreography for language-driven departures"
  (`finished/engine.rollout.plan.md`) is therefore about **grace, not permission**:
  today's departure is a hard `engagement_interrupted` with no farewell beat. This plan
  adopts that leftover (slice 4).
- **Natural-language travel already works — abruptly.** Input admission runs after the
  scene opens (`src/server/engine/sim-exchange.ts:725-739`); an admitted move commits,
  interrupts, and reaches the narrator as a world-truth note.
- **The turn loop is scene-mandatory.** `runSimTurn` 409s ("the scene could not open")
  when a co-present player+primary engagement can't be established
  (`sim-exchange.ts:721-723`). Traveling away from the primary today likely soft-locks
  the chat until something reunites the pair. Slice 0 removes this cliff before any
  travel affordance ships.
- The per-actor **whereabouts phrase** is already computed and explicitly "held for the
  roster panel's later use" (`readSimChatPresence`,
  `src/server/engine/sim-surfaces.ts:51`) — slice 1 finally draws it.
- Zones have **no name column**; display labels derive from `kind` via the display-noun
  map. Kind labels suffice for the two starter zones (see OQ3).

## Rulings

- **Rollout ruling 1** (finished/engine.rollout.plan.md §Resolved rulings): chat IS the
  play surface — no standalone play page. Everything here lands inside `/chat/[chatId]`.
- **Ruling 20** (§39, 2026-07-23): travel is **skip-style** — player-initiated travel
  resolves within the same interaction by composing `move` with a bounded
  `advance_time` to earliest arrival. The §17 journey machinery still runs underneath.
- **Ruling 21** (§39, 2026-07-23): solo turns are **dual-block narration** — a
  second-person player-side block (looking around, examining held items, local NPCs
  engaging) plus a third-person **away vignette** of the primary living their routine,
  grounded in engine-provided routine MUSTs, narrator free within limits (no aimless
  travel, no incessant texting/calling). The Narrator composer toggle is the player's
  steering channel. The vignette is audience knowledge, never player-character
  knowledge.
- Ruling 12 (route-estimate uncertainty exposure) stays **open**; v1 phrases link
  minimums as "~5 min walk" (see OQ4).

## Design overview — three layers

**Layer 1 — read surface.** `readSimChatWorld` in `sim-surfaces.ts` + one
`GET /api/chats/[chatId]/world` route (gated by `requireSimChat`, `parseOr` at the
boundary, degraded `null` ⇒ the card simply doesn't render — ruling-18-style affordance
hiding). Envelope: `place {label, privacy}` or `transit {toLabel, arrivesInSeconds}`
from the player's locus; `cast` whereabouts phrases; `destinations` (open links from
the current zone: `{zoneId, label, mode, travelSeconds}` from `minimumDurationSeconds`);
`held` (the player's held item holdings — the first inventory read anywhere);
`sceneOpen`.

**Layer 2 — UI objects.** A `ChatWorldCard` in the right "story time" aside beside
`ChatClockCard` (`src/components/chat/chat-conversation.tsx:1325-1339`), folded into
the phone roster sheet the same way. Place line, who's-here, destination chips in the
skip-chip idiom (`Button size="sm" variant="quiet"` + caption row with travel time).
Client methods `simMove` / `simEndScene` / `simGiveItem` beside the existing
`simAdvanceTime`. Refusal rendering is the first real UI consumer of the §14.4
`PublicFailurePresentation`: show `publicReason`, render `legalAlternatives` as chips.

**Layer 3 — game systems.** Scene-optional turns (slice 0), skip-style travel
settlement (ruling 20), graceful departure choreography (slice 4), walk-with-me
(slice 5). Whatever the button does, the phrase-matched path does — one choreography in
`sim-exchange`, two entry points.

## Slices

### Slice 0 — scene-optional turns (dual-block solo narration)

The prerequisite for every travel affordance. When `findOrOpenStandingEngagement`
cannot produce a co-present player+primary scene, the turn runs a **solo cut** instead
of 409ing:

- Player-side context: current zone, co-present NPCs, held items — second person.
- Primary away-projection: locus, active activity, due commitments — the **routine
  MUSTs** — rendered as the third-person vignette per ruling 21, under charter law
  (opaque handles, display labels, no raw ids; withhold contract; one confirm per cut).
- Co-present NPCs at the player's location can engage (the engagement machinery is
  actor-pair generic; presenting a non-primary engagement in the chat UI is part of
  this slice's design).
- Degradation: vignette-build failure ⇒ player-side block alone + diagnostic
  (per `docs/resilience.md`); never a failed turn.

### Slice 1 — the sidewalk: world read + ChatWorldCard + travel

- `readSimChatWorld` + `GET /api/chats/[chatId]/world` (Layer 1 envelope).
- `ChatWorldCard` (Layer 2) with destination chips; in-transit display ("Walking to
  the town square — there in ~4 min").
- Travel per ruling 20. Prefer a server-side composed `travel` sim-command kind
  (move + arrival drain atomically) over client-side sequencing — it keeps NL parity
  in one place and the client dumb.
- §14.4 refusal rendering (publicReason + legalAlternatives chips).
- No schema migration; no new message kind (feedback is toast-parity with skips until
  slice 2).

### Slice 2 — visible trace: transcript world-beats

A new transcript line kind for departed / arrived / scene-ended / time-skipped beats,
replacing toast-only feedback. The one structural UI change: extend `ChatLine`
(`src/components/characters/chat-message.tsx:11`), `chatMessageSchema`
(`src/lib/client/api.ts:304`), `toLine`, and a `MessageBubble` branch.

### Slice 3 — pocket & actions

Held-items row on the world card with "Hand to {primary}" (`give_item` — today's only
legal transfer is player→primary held→held) and a "Rest (10 min)" chip
(`start_activity`; the seeded rest action's `at_zone_kind: home` precondition
shows/hides it). Shares the slice-1 refusal surface.

### Slice 4 — graceful departure choreography (adopts the R5 leftover)

An admitted departure routes through `winding_down` with a farewell beat before the
move commits, instead of a hard interrupt — shared by the button path and the NL path.
The turn that carries a departure narrates the goodbye and the setting-out.

### Slice 5 — walk-with-me

The §14.2 invite/accompany family (`InviteActor` is specced but absent from the
command registry), NPC acceptance via the policy/deliberator seam, shared journeys,
and engagement continuity across co-travel. For a romance-first product this is the
marquee travel feature — traveling *together*; solo travel is plumbing for it.

## Open questions

- **OQ1 — vignette epistemics & privacy.** Ruling 21 fixes audience-vs-character
  knowledge, but the privacy interaction is undesigned: what may the vignette show when
  the primary's activity is private (zone privacy policy, ruling 13 redaction law)?
  And memory indexing must provably not fold vignette facts into the player's §20
  partitions.
- **OQ2 — look/examine admission.** Extend input admission with observation intents
  ("I look around", "I check my pockets") as presentation directives (no durable
  command), or leave observation entirely to narrator context? Lean: directives — they
  make the player-side block responsive without new state.
- **OQ3 — zone display names.** Kind-derived labels suffice at two zones; a nullable
  `displayName` on `simZones` (forward-compatible headroom) waits until worlds grow.
- **OQ4 — ruling 12** (route-uncertainty exposure) remains open; "~5 min walk" phrasing
  keeps v1 compatible with any future ruling.
- **OQ5 — routine substrate.** Does the starter primary have enough routine for a
  non-empty vignette (body rhythms exist; the only action definition is rest)? The
  starter world may need a small routine seed so the vignette has MUSTs to render.
- **OQ6 — solo-turn presentation in the transcript.** Dual-block renders inside one
  assistant bubble (segments) or as two beats? Decide with slice 0's prompt work under
  charter law.

## Docs to update when slices ship

`docs/ui.md` (ChatWorldCard, world card idiom), `docs/contracts/simulation.md` (world
read envelope, composed travel command), `docs/character-chat/README.md` +
`prompts.md` (solo-turn prompt shape), `docs/README.md` direction paragraph, and
`docs/guide/locations.md` (stale post-R6; repoint or rewrite when locations return
"simpler" per world-engine-refactor OQ2).
