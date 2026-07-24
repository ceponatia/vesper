# World UI — the player-facing surface of the successor world

Status: shipped — 2026-07-23 (planned 2026-07-23 from the owner's world-UI design pass;
owner rulings 20–21 recorded in [engine.spec.operations.md](engine.spec.operations.md)
§39. **Slices 0, 1, 2, 3, 4, and 5 all shipped 2026-07-23.** Slice 4 closed the NL-move
parity that was deferred out of slice 1; slice 5 delivered walk-with-me v1 — see each
slice's "How it shipped". Leftovers: the §19.3-deliberator upgrade of the acceptance seam
and the §14.2 remote-invite family (inviting an ABSENT partner) are noted in Slice 5.)

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

### Slice 0 — scene-optional turns (dual-block solo narration) — SHIPPED 2026-07-23

The prerequisite for every travel affordance. When `findOrOpenStandingEngagement`
cannot produce a co-present player+primary scene, the turn runs a **solo cut** instead
of 409ing:

- Player-side context: current zone, co-present NPCs, held items — second person.
- Primary away-projection: locus, active activity, due commitments — the **routine
  MUSTs** — rendered as the third-person vignette per ruling 21, under charter law
  (display labels, no raw ids; audience-not-character knowledge).
- Degradation: vignette-build failure ⇒ player-side block alone + diagnostic
  (per `docs/resilience.md`); never a failed turn.

**How it shipped (decisions):**

- **Fork point.** `runSimTurn` (`server/engine/sim-exchange.ts`) forks to
  `runSimSoloTurn` when `findOrOpenStandingEngagement` fails with a *genuinely not
  co-present* code — `SOLO_CUT_OPEN_CODES = {participants_not_co_located,
  participant_in_transit}`. Every other open failure (`branch_mismatch`,
  `participant_not_found`, …) still 409s as before. `participant_unavailable` /
  `participant_already_engaged` (primary present but busy / engaged elsewhere) stay
  409 in v1 — the vignette's "not here with you" framing would misread a same-zone
  primary; promoting them to solo needs the co-location-aware framing deferred below.
- **The solo path never touches the cut machinery.** There is no committed
  `NarrativeCut` for a solo turn (no engagement), so it does **not** call
  `prepareEngagementTurn`/`renderCommittedCut`. Instead it advances the branch clock
  by the ordinary 60s span via `advanceBranchStoryTime` (draining due triggers — how
  an in-transit player eventually arrives), reads the space/activities/commitments/held
  projections, and renders through a **dedicated** lean loop `renderSoloNarration`
  (`sim-narrator.ts`) over a **new** dual-block prompt
  (`prompts/sim-solo-render.ts`). No handles/armed effects (a solo cut enacts none),
  so the output schema is `{prose}` (`soloNarrationSchema`).
- **Pure shaping** lives in `src/lib/simulation/solo-cut.ts` (`buildSoloPlayerSide`,
  `buildSoloVignette`, `buildSoloFallbackProse`, unit-tested); the store/IO layer
  (`buildSoloCutContext` in `sim-exchange`) only loads projections and resolves
  display labels from the space projection's zone **kinds** (the same humane source
  `sim-render` uses — no raw id reaches the prompt). Humanizers were extracted to
  `src/lib/simulation/humanize.ts` and are now shared by both prompt builders.
- **Co-present NPCs: prose-only, no formal non-primary engagement (OQ answer).** Wiring
  a non-primary engagement through `prepareEngagementTurn` was judged disproportionate
  for v1 (per the slice's own allowance). Co-present NPCs (e.g. the starter neighbor)
  appear in block (a) as visible, reactive prose with their live activity; they hold no
  engagement. Revisit if/when the chat UI needs to *present* a non-primary scene.
- **Presentation (OQ6 answer).** Dual-block renders as **one assistant bubble, two
  paragraphs** — block (a) then a paragraph break then block (b). No new message kind
  (that is slice 2). The reply persists with `meta.solo = true` (no `cutId`).
- **Degradation ladder.** space-read failure ⇒ minimal safe narration
  (`engine.sim.solo.space_read_failed`); activities/commitments failure ⇒ block (a)
  alone (`engine.sim.solo.vignette_degraded`); held-items failure ⇒ empty pocket
  (`engine.sim.solo.held_read_degraded`); a failed model render degrades to the
  deterministic `buildSoloFallbackProse` (`sim.narrator.solo.degraded_to_fallback`).
  A solo turn is architecturally *never* withheld (§18.5 "deterministic minimal
  transition") — there is always a non-empty fallback.
- **Narrator input mode threaded end-to-end.** It previously reached NO successor turn
  (the route dropped `inputMode`). Now `route.ts → runSimChatExchange → runSimTurn /
  runSimSoloTurn` carries it; a `narrator` send **skips input admission** (storyteller
  narration is not the player-character's own command) and reframes the player-turn
  block in BOTH the co-present builder (`sim-render`) and the solo builder. The user
  row records `meta.inputMode = "narrator"` for register parity with the legacy lane.

**Deferred out of slice 0 (documented, not built):**

- **Retake of a solo turn.** A solo reply has no `cutId`; `runSimRetake` finds no
  standing scene and returns 409 "there is no open scene to re-render". Acceptable
  (not a dead chat) but a wart — a solo-aware retake would re-render from re-read
  projections.
- **Autonomous primary departure during a solo turn.** `advanceBranchStoryTime` drains
  triggers but the solo path runs no engagement, so the departure/deliberator policy
  (`prepareEngagementTurn`) never fires for the primary. The vignette *shows* a due
  shift as a routine MUST but the engine will not actually move the primary — matches
  ruling 21 ("the narrator cannot move the primary"); real autonomous NPC travel is a
  later slice.
- **`humanizeActivity` id wart.** A namespaced/stamped action id (`stw-…-action-rest`)
  humanizes poorly — pre-existing and shared with the co-present path; the starter
  primary auto-starts no activity, so v1 rarely hits it.
- **Past narrator-mode tail labels.** The dialogue tail still labels a past
  narrator-mode line as `PLAYER (as …)` rather than narration (the legacy lane wraps
  them). Minor fidelity; only the *current* turn's framing is corrected here.

### Slice 1 — the sidewalk: world read + ChatWorldCard + travel — SHIPPED 2026-07-23

- `readSimChatWorld` + `GET /api/chats/[chatId]/world` (Layer 1 envelope).
- `ChatWorldCard` (Layer 2) with destination chips; in-transit display ("Walking to
  the town square — there in ~4 min").
- Travel per ruling 20. Prefer a server-side composed `travel` sim-command kind
  (move + arrival drain atomically) over client-side sequencing — it keeps NL parity
  in one place and the client dumb.
- §14.4 refusal rendering (publicReason + legalAlternatives chips).
- No schema migration; no new message kind (feedback is toast-parity with skips until
  slice 2).

**How it shipped (decisions):**

- **The world envelope** (`readSimChatWorld`, `sim-surfaces.ts`; gated exactly like the
  sibling reads — routed non-shadow chats only, else `null`): `place {label, privacy}`
  when the player is `at` OR `transit {toLabel, arrivesInSeconds}` when `in_transit`
  (ETA = `journey.earliestArrivalAt − storySecond`, floored at 0, journey-then-locus
  fallback); `cast [{name, whereabouts, present}]` for every non-player sim actor;
  `destinations [{zoneId, label, mode, travelSeconds}]` (open, **walkable** links, empty
  in transit); `held [{itemId, name}]`; `sceneOpen`. Labels are zone **display nouns**
  (`zoneDisplayNoun` off the kind, `humanizeId` last resort — never a raw id). The read
  is wrapped fail-open: a malformed projection logs `engine.sim world read degraded to
  null` and returns `null` (the card hides), never throws.
- **Pure shaping in `src/lib/simulation/world-read.ts`** (unit-tested):
  `buildWorldPlaceOrTransit`, `buildWorldDestinations` (links are **undirected** for
  travel, matching the route planner's adjacency — a home→square link also offers
  square→home), `actorWhereabouts` (the present / on-the-move / elsewhere decision —
  now **shared** with `readSimChatPresence`, which was refactored to call it, so the
  roster chip and the world card can never drift), and the card phrasing
  (`approxWalkMinutes`, `placeGoPhrase`, `goChipLabel`, `capitalizeFirst`).
  `isStandingCoPresentEngagement` (the "is a scene open?" test) was extracted to
  `lib/simulation/engagements.ts` and is shared by `findStandingEngagement` (sim-exchange)
  and the world read's `sceneOpen` — this also broke the sim-surfaces↔sim-exchange cycle
  a direct `findStandingEngagement` import would have created.
- **Server-composed travel** (`travel` kind on the sim-command route, ruling 20): submit
  the player `move`; on acceptance read the space projection for the player's journey and
  drain the clock to its `earliestArrivalAt` via the SAME bounded `advanceBranchStoryTime`
  loop `advance_time` uses (extracted to a shared `drainBranchTo` helper — no duplication).
  The standing scene is **not** ended first (an accepted move already lawfully interrupts
  it — space-store `interruptCoPresentEngagementsForActor`). Response `{status:"traveled",
  toStorySecond, arrived}` (arrived re-read from the settled loci). A refusal returns the
  §14.4 shape at **200** (not the `respond` 409) — the client's error path flattens a 409
  body, so the card, the first real refusal consumer, needs the structured shape in the
  `ok` channel.
- **NL move parity — DEFERRED (documented).** Ruling 20's "for parity" clause (drain an
  admitted natural-language move to arrival in `submitAdmittedCommand`) is **not** shipped.
  The clause's stated intent — "the slice-0 solo path then naturally renders the player at
  the destination" — does not hold within one turn: `runSimTurn` opens the engagement
  BEFORE admission and then calls `prepareEngagementTurn` **unconditionally**, so an
  admitted mid-turn move never routes to the solo renderer that same turn. Draining alone
  would jump the clock to arrival while the turn still renders the co-present cut (primary
  narrated as present though the player has walked away) — incoherent, and arguably worse
  than today's abrupt-but-honest "set off walking" note. The coherent fix (re-checking
  co-presence after an admitted move and re-routing the turn to `runSimSoloTurn`) is a
  turn-flow restructure that cannot be integration-tested locally (no local Postgres for
  UI/turn work — Fly is the surface), so it is disproportionate for slice 1. **NL moves
  keep today's behavior** (move interrupts, co-present render, "set off walking"); the
  next turn after an NL move renders solo naturally. The button `travel` command delivers
  full ruling-20 skip-style travel. Unifying the two paths ("one choreography, two entry
  points") lands with the Layer-3 game-systems slices (4/5), where the turn-flow
  restructure is in scope and testable on Fly.
- **Client + card.** `chatsApi.world` / `simTravel` / `simGiveItem` / `simEndScene`
  (give/end are wiring-only — their card UI is slice 3). `ChatWorldCard`
  (`components/chat/chat-world-card.tsx`) renders in the desktop right aside below
  `ChatClockCard` AND — since it is the **only** travel surface and the desktop aside is
  hidden below `lg` — in the **phone Roster sheet** (a deliberate divergence from the
  clock, which mobile-ux rulings 1–2 removed from that sheet as redundant with the ambient
  clock chip; the world card has no other mobile home). It self-hides when `world === null`.
  A tapped destination calls `simTravel`, shows a per-chip busy state, toasts the landing
  in skip-parity via the **shared** `formatSimLanding` helper (extracted to
  `lib/simulation/clock.ts`; the skip toast now reuses it too), then refreshes world +
  chat state. A `{status:"rejected"}` renders `publicReason` inline with
  `legalAlternatives` as plain text (none are card-actionable in slice 1 — honest over
  clever). The world envelope is fetched with `useAsyncData` and re-fetched wherever
  `refreshState` runs (post-exchange, post-skip, post-travel); travel chips disable while
  `sending`/`skipBusy`.

### Slice 2 — visible trace: transcript world-beats — SHIPPED 2026-07-23

A durable, rendered **world-beat line** in the successor-chat transcript for the events
the player causes or witnesses — traveled / time-skipped / scene-ended — replacing
slice 1's toast-only feedback. The one structural UI change: extend `ChatLine`
(`src/components/characters/chat-message.tsx`), `chatMessageSchema`
(`src/lib/client/api.ts`), `toLine`, and a `MessageBubble` branch.

**How it shipped (decisions):**

- **Encoding — no migration.** A beat is an ordinary `character_chat_messages` row:
  `role = "assistant"` (a legal enum value; `speakerCharacterId` null), `meta.worldBeat
  = { kind }` (`"traveled" | "time_skipped" | "scene_ended"`) marking it, and the
  **phrased line stored verbatim on `content`**. The transcript GET already carries
  `meta` through untouched, so the client re-parses the marker with zod and renders;
  no schema change, no new `role` value.
- **Phrasing is server-side + pure** (`src/lib/simulation/world-beat.ts`,
  unit-tested): `worldBeatText` composes the destination phrase (`placeGoPhrase` — "home"
  bare, else article'd, the goChipLabel idiom in prose) with the **shared
  `formatSimLanding` stamp** — the one time surface the skip/travel toasts already name
  their landing through; the beat invents no new formatter. `traveled` → "You walk to
  the town square. · <landing>"; `time_skipped` → "Time passes — it's now <landing>.";
  `scene_ended` → "The scene ends. · <landing>". The text is frozen at write time with
  the authoritative **post-command** clock (a durable trace, not a live re-render).
- **Render** — a `MessageBubble` early branch (after all hooks, for the strict
  hooks-lint) draws a **muted, centered, non-bubble system line** (`text-xs
  text-paper-500 italic`) — no portrait, no speaker label, no hover actions. `ChatLine`
  gained `worldBeat?: WorldBeatKind` and `toLine` maps `meta.worldBeat.kind`;
  `lastAssistantId` skips beats so "Another take" still targets the last real reply.
- **Write points, server-side** — a new guarded `writeWorldBeat`
  (`src/server/engine/sim-beats.ts`, successor-lane only) reads the post-command clock,
  phrases, and inserts. The **sim-command route** writes the beat when `travel` /
  `advance_time` / `end_scene` **commit** (after acceptance); a skip **folds** a wrapped
  standing scene into its one "Time passes" beat (never a second `scene_ended`).
  **sim-exchange** (`runInputAdmission`) writes the traveled beat when an **admitted NL
  move** commits — a *departure* beat here, since slice 1 keeps NL moves abrupt (no
  drain to arrival), alongside the narrated turn. `readBranchClock` moved from
  `sim-exchange` to `sim-beats` so the writer owns its clock read with no import cycle;
  `zoneLabelFromKind` was extracted in `sim-surfaces` (shared by the world read and the
  beat writer — one kind→noun seam, no raw id). Beat rows are **excluded from the
  narrator dialogue tail** (`loadSimDialogueTail`, via `isWorldBeatMeta`) — a UI trace,
  never narration the model should echo.
- **Client feedback flip** — for sim chats the travel + skip **success toasts are
  gone**; a shared `reloadTranscript` (extracted from the post-send reconcile) pulls the
  server-written beat into the transcript after the command returns (travel via
  `onTraveled`/`refreshWorldAndState`, skip inline). **Refusal** feedback
  (publicReason / legalAlternatives) is unchanged from slice 1. Legacy-lane skip toasts
  stay (`formatChatMoment` path untouched). The `calendarStart` prop the card only used
  for its old toast was removed.
- **Degradation** (docs/resilience.md) — `writeWorldBeat` is fully self-guarded: a
  failed beat write logs the `engine.sim.world_beat` diagnostic and returns, so the
  command that already committed still returns success.
- **Deferred / notes.** `docs/contracts/simulation.md` needed no change — the
  `travel`/`advance_time`/`end_scene` **response shapes are unchanged**; the beat is a
  transcript side effect. No local Postgres, so `pnpm test:int` (the sim-routes
  integration tests) was **not** run here — the added coverage is the pure
  `world-beat.test.ts` (phrasing + schema round-trip). Unit + lint + cycles + typecheck
  + jscpd all pass.

### Slice 3 — pocket & actions — SHIPPED 2026-07-23

Held-items row on the world card with "Hand to {primary}" (`give_item` — today's only
legal transfer is player→primary held→held) and a "Rest · ~10 min" chip
(`do_activity`; the seeded rest action's `at_zone_kind: home` precondition
shows/hides it). Shares the slice-1 refusal surface.

**How it shipped (decisions):**

- **Co-location is resolver-enforced — NO route precheck added.** The transfer resolver
  (`resolveTransferItemFromView`, `lib/simulation/materials.ts` §26.4 step 7) already
  requires the destination chain's root zone to equal the acting actor's zone; a
  `give_item` to the primary's held locus therefore refuses `root_not_colocated` ("That
  destination is not within reach.") whenever the primary is away — a §14.4 public face
  with no instant co-location effect (§14.2 spirit). So the route adds no co-location
  precheck. **Independently** the card disables the "Hand to {primary}" affordance when
  `cast[].present` is false (with a muted "{name} isn't here to take it." caption), so the
  refusal is rarely even reachable.
- **`give_item` returns the §14.4 face at 200** (matching `travel`, not the old `respond`
  409) so the card renders `publicReason` + `legalAlternatives` from the `ok` channel; on
  success it writes a **`gave_item` world beat** ("You hand {primary} {item name}. ·
  <landing>") via the slice-2 `writeWorldBeat` seam and returns `{status:"gave"}`.
- **`do_activity {actionDefinitionId}` — a new composed skip-style kind** (ruling 20's
  spirit), pattern-matched on the slice-1 `travel` composition: submit the player's
  `start_activity`; on a `rejected` outcome return the §14.4 face at 200 (a **claim
  conflict** — e.g. resting mid-scene, since rest claims body + full attention against the
  standing engagement's attention claim — surfaces here and renders on the card); on
  acceptance read the just-started activity's `expectedCompleteAt` (deterministic id via
  `deriveActivityId(branchId, commandId)`) and drain the branch clock to it through the
  shared `drainBranchTo` helper. **Completion is trigger-scheduled AT start** (activity-
  store schedules the completion trigger at `expectedCompleteAt`), so the drain fires it —
  the route never submits `complete_activity` itself; the activity never dangles active.
  Response `{status:"performed", toStorySecond}` + a **`rested` world beat** phrased
  generically from the action's display label ("You rest a while." — a future "Nap"/
  "Meditate" reads right for free).
- **The `actions` envelope field** (`readSimChatWorld`): each branch action definition the
  **player** may control, shaped `{id, label, durationSeconds, available, unavailableReason?}`.
  `available` is the pure `buildWorldActions` decision — the player is `at` a zone whose
  kind satisfies every `at_zone_kind` precondition (reusing the same law
  `resolveStartActivity` enforces, not a duplicate), and a `consent_covered`-gated action is
  marked unavailable (the card can't gather targeted consent yet). The card renders only
  `available` actions as chips (ruling-18 affordance hiding); unavailable ones round-trip
  but are hidden, not disabled.
- **Action display label as authored data.** Added an OPTIONAL `label` field to
  `simulationActionDefinitionSchema` (jsonb payload — **no DB migration**; older rows
  without it still parse and fall back to an id-derived title-cased label). The starter
  world seeds `label: "Rest"`, so the chip reads "Rest" instead of humanizing the stamped
  `stw-…-action-rest` id (the slice-0 humanize wart, sidestepped for player-facing chips).
- **Cast carries `isPrimary`** so the card knows the fixed give target's name + presence
  without a redundant envelope field. The card's `onTraveled` prop was renamed
  `onWorldChanged` (it now refreshes after travel / handoff / action alike).
- **No `end_scene` on the card** — departure choreography is slice 4; `simEndScene` stays
  wired-but-unused.
- **Tests / deferrals.** New pure coverage: `buildWorldActions` availability shaping,
  `actionChipLabel` fallback, `approxActivityMinutes`, the `gave_item`/`rested` beat
  phrasings, and the envelope round-trip (`actions` + `isPrimary`). `pnpm test:int` was
  **not** run (no local Postgres) — the composed-command paths (`give_item` beat,
  `do_activity` start→drain→complete) are integration-shaped and want a Fly/Postgres pass.
  Lint + cycles + typecheck + unit + jscpd all pass.

### Slice 4 — graceful departure choreography (adopts the R5 leftover) — SHIPPED 2026-07-23

A player-CHOSEN departure (the travel chip, or an admitted natural-language "I walk to
the town square") now ENDS the standing scene as a choice and narrates the parting,
instead of leaning on the move's hard `engagement_interrupted`. One choreography, two
entry points (the button and the NL path). This **closes** the R5 leftover "scene-exit
choreography for language-driven departures" (`finished/engine.rollout.plan.md`) and
ruling 20's "for parity" clause (`engine.spec.operations.md` §39), which slice 1 had
explicitly deferred.

**How it shipped (decisions):**

- **End as a CHOICE, not `winding_down`.** The original slice sketch said "route through
  `winding_down`"; the owner's build direction settled it as an **END** (`end_engagement`,
  reason `participant_choice`) taken BEFORE the move — the same lawful two-step
  `advance_time` already performs. An ended scene holds no claim (spec §18.2), so the move
  that follows fires **no** `engagement_interrupted`: a parting, not a rupture. (A future
  slice can still add the playable `winding_down` transition where the NPC gets a beat to
  react before the player leaves; slice 4 is the clean-exit case.)
- **The choreography (both entry points).** When a scene stands: `end_engagement`
  (participant_choice) → `move_actor` → drain the clock to the journey's earliest arrival
  (ruling 20, via the shared `drainBranchTo` + `moveArrivalTarget` helpers) → **one**
  `traveled` world-beat phrased with the parting → render at the destination. When no scene
  stands (already solo): the same move → drain → beat → render, minus the end and the
  farewell framing.
- **Button travel** (`travel` kind, `sim-command/route.ts`): ends the standing scene first
  (was: relied on the move's interrupt), threads a `parted` flag into the beat, and reads
  the drain target through the shared `moveArrivalTarget`. The response shape is unchanged
  (`{status:"traveled", toStorySecond, arrived}`).
- **NL departures route to the SOLO renderer** (`sim-exchange.ts`, the turn-flow restructure
  slice 1 deferred as un-testable-locally). `runSimTurn` now pattern-matches admission
  (match only, no submit) BEFORE the scene fork; a pure `planDepartureChoreography`
  (`lib/simulation/departure.ts`, unit-tested — scene-stands × admitted-kind → steps)
  decides the shape. An admitted MOVE runs `runSimDepartureTurn`, which ends/moves/drains
  then renders through `runSimSoloTurn` (the slice-0 dual-block machinery) with a new
  **departure context**: block (a) narrates the goodbye, the walk, and the arrival as one
  continuous beat; block (b) is the primary's vignette. The solo turn **skips its own 60s
  span advance** when a departure already drained to arrival (no double-count). The pure
  departure line (`buildSoloDepartureLine`) and the `SoloDeparture` shape live in
  `lib/simulation/departure.ts`; `sim-solo-render.ts` gained a `departure?` context field.
- **Give / rest and everything else are untouched.** Non-move admissions keep the co-present
  submit + render (extracted verbatim to `runCoPresentTurn`, reused by the departure
  fallback). `advance_time` / `end_scene` / `give_item` / `do_activity` are unchanged.
- **One beat per departure, guaranteed.** The old NL-move beat (written inside the retired
  `runInputAdmission`) is gone; the beat is now written exactly once — by the route (button)
  or by `runSimDepartureTurn` (NL), phrased `parted` when a scene was ended. A move that
  reaches the co-present FALLBACK writes the ordinary (non-parted) beat there, still once.
- **Degradation (docs/resilience.md), never a dead turn:** an unexpected end-engagement
  failure logs `engine.sim.departure` and falls back to today's interrupt path (the accepted
  move interrupts the still-standing scene; the co-present cut renders "set off walking",
  no farewell, no parted beat). A refused/undone move keeps today's behavior (no world
  change) and renders a plain solo turn. A divergent arrival drain degrades to the current
  clock (the arrival trigger settles a later turn).
- **Smallest-lawful edge (documented).** A move REFUSED *after* a successful scene-end
  (scene stood, then the walk was rejected) renders a plain solo turn — factually the pair
  is still co-present, so the "primary elsewhere" framing is slightly off. This is
  **unreachable in the starter world** (a standing co-present scene rules out the body claim
  a walk could refuse, and the two zones are adjacent); a future multi-zone world where
  admission can name an unreachable/multi-hop zone would want a reachability pre-check before
  the end (reusing `buildWorldDestinations`).
- **Tests / deferrals.** New pure coverage: `departure.test.ts` (the decision matrix + the
  arc line), `world-beat.test.ts` (parted phrasing), `sim-solo-render.test.ts` (the
  departure-context block). The choreography itself is integration-shaped;
  `pnpm test:int` was **not** run (no local Postgres) — the end→move→drain→solo path wants a
  Fly/Postgres pass. Lint + cycles + typecheck + unit + jscpd all pass.

### Slice 5 — walk-with-me — SHIPPED 2026-07-23

When the player and the co-present primary set off TOGETHER, one composed
interaction (ruling 20) walks them both to the destination: the primary's
acceptance is NPC agency, both journeys settle, and co-presence is restored so the
scene continues at the far end. For a romance-first product this is the marquee
travel feature — traveling *together*; solo travel (slices 1/4) is plumbing for it.
Two entry points, one choreography (a "walk together" chip and a natural-language
invite).

**How it shipped (decisions):**

- **Acceptance is NPC agency via a bounded DETERMINISTIC policy, no model call**
  (`decideAccompany`, `lib/simulation/accompany.ts`, PURE + unit-tested). The exact
  matrix: **accept UNLESS** (a) a claim-holding activity occupies the primary's
  **body** right now (the same body-claim gate `resolveMoveActor` enforces —
  `claimHoldingActivityPhases` × a `body` claim), or (b) a **`firm`/`hard`**, still-open
  commitment's `window.latestArrival` falls at or before the walk's earliest arrival
  **plus a 300 s buffer** (`ACCOMPANY_ARRIVAL_BUFFER_SECONDS`). Soft/negotiable
  commitments, attention-only claims, another actor's claim/commitment, and resolved
  commitments never decline. A decline returns an honest §14.4-style PUBLIC face —
  `"{primary} can't come with you right now."` + `["go on your own", "wait a while"]`
  — **identical whether (a) or (b) blocks her**, so the private cause never leaks
  (asserted in the test). The acceptance seam does NOT touch the §21.4 consent ledger
  (§39 ruling 16). **A future pass upgrades acceptance to the §19.3 deliberator seam**
  (bounded legal candidates, deterministic fallback = decline); the decision shape was
  chosen to survive that upgrade.
- **The composed choreography** (`runAccompanyTogether`, `sim-exchange.ts`; world
  writes only — the ONE seam both entry points call, ruling 20): read pre-move space +
  activities + commitments → estimate arrival from the current zone's open link (the
  same pure `buildWorldDestinations` the travel chip reads) → `decideAccompany` → on
  accept, **END the standing scene as a CHOICE** (`participant_choice`, §18.2 grace) →
  submit the **player's** `move` (player principal) → submit the **primary's** `move`
  under an **`npc_policy` principal controlling the primary** (`principalId:
  "sim-accompany"`, the arbiter's precedent) — the player principal is **never**
  authorized to move an NPC (`resolveMoveActor` rejects `unauthorized_actor`; §14.2) →
  drain to the **later** of the two journeys' earliest arrivals (`moveArrivalTarget`
  ×2, `drainBranchTo`) → write **ONE** `together` world beat. Both actors are then
  `at` the destination; the next `findOrOpenStandingEngagement` reopens the scene
  there naturally.
- **Button** — a **`travel_together {toZoneId}`** sim-command kind
  (`sim-command/route.ts`) calls `runAccompanyTogether` and maps its outcome to the
  card: a landing (`accompanied`/`traveled_alone`) refreshes world + transcript; a
  decline / refusal returns the §14.4 face at 200 (`status: "rejected"`). The card
  pairs each destination with a **"Walk together"** chip, rendered **only when the
  primary is `present`** (`cast[].isPrimary` + `present`), beside the existing "Go
  to …" chip — layout kept uncluttered (chip pair + one caption row per destination).
  Client method `chatsApi.simTravelTogether` + `simTravelTogetherResultSchema`.
- **NL** — input admission gained an **`accompany`** admitted-command kind
  (`input-admission.ts`, deterministic, one command max): first-person **plural** or
  **invite** phrasing (`ACCOMPANY_LEADS` = `let's` / `let us` / `we` / `with me`) plus
  a move verb (incl. `come`) over a known `ZONE_KIND_WORDS` zone → accompany, checked
  **before** solo move so "let's walk to the square" reads as an invite while a plain
  "I walk to the square" stays a solo move. Silence over cleverness: quoted speech,
  third-person, and no-zone-word all stay null (tested). In the turn
  (`runSimAccompanyTurn`): an admitted accompany **while co-present** runs the
  choreography, then on **accept** REOPENS the scene at the destination and renders the
  **CO-PRESENT** turn with a travel-context line ("{player} and {primary} have just
  walked to … together from …") threaded through the existing `admittedAction` seam
  (portrayed as done — the scene continues in prose); on **decline** renders the
  ordinary co-present turn with the decline as a §14.4 **failure presentation** (she
  answers in character). Admitted **while NOT co-present** ⇒ a plain solo move (slice 4
  path) — **inviting an ABSENT partner is future work** (the §14.2 remote-invite family:
  `InviteActor`/`CallActor`/`RequestVisit`, specced but absent from the command
  registry).
- **Degradation (docs/resilience.md), never a dead turn / never fabricated co-travel:**
  if the **NPC move fails after the player's move committed** (divergence), the player
  still travels — their move stands — the beat is the **plain** traveled beat (not
  `together`), `engine.sim.accompany` logs, the outcome is `traveled_alone`, and the NL
  render falls to the **solo** path. An unexpected scene-end failure degrades to the
  interrupt path (the accepted moves still lawfully interrupt). A refused player move
  keeps today's behavior (no travel) and returns the §14.4 face.
- **Together beat phrasing** — `world-beat.ts` gained a `together` flag: `traveled` →
  "You walk to {place} together." (bare "You walk home together."), **superseding**
  `parted` (you don't take your leave of someone you walk with). Threaded through
  `writeWorldBeat`.
- **Tests / deferrals.** New pure coverage: `accompany.test.ts` (the full decision
  matrix incl. the privacy invariant), accompany admission grammar (positives +
  negatives) in `input-admission.test.ts`, and the together-beat phrasing in
  `world-beat.test.ts`. The choreography itself is integration-shaped; **`pnpm test:int`
  was NOT run (no local Postgres)** — the end→move×2→drain→reopen→render path wants a
  Fly/Postgres pass. Lint + cycles + typecheck + unit + jscpd all pass.

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
