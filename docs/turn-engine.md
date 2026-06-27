# Turn engine

`src/server/engine/` — the multi-agent orchestration core. One turn = **pre-turn fan-out → narrative stream → post-turn agent fan-out → deterministic merge → maintenance jobs**. Parallelism is the design, not an optimization: retrievals run concurrently before the narrative; four specialized agents run concurrently after it.

## Lifecycle

```
submitTurn(sessionId, input, author)
 1. recover abandoned turns; CAS sessions.status ready→narrating. A turn submitted during the
    previous turn's post-turn `processing` window (the lock lingers ~8–10s after its SSE `done`)
    **waits it out — retrying the CAS for up to `TURN_READY_WAIT_MS` — instead of 409ing** (UX-audit
    M3); only an actively `narrating` session, or a `processing` window that never clears, gets a
    409 `session_busy` (with a message pointing at the `ready` status signal)
 2. create turn row (status narrating)
 3. PRE-TURN (parallel):
      a. episode RAG retrieve        (PREVIOUS turn's brief.memoryQueries + input)
      b. fact retrieve               (same queries, facts table)
      c. lore retrieve               (retrieval-tier chunks, eligibility-filtered FIRST)
      d. INTAKE agent (`runIntake`)  (the ONLY pre-narration LLM — concurrent leg; tool model;
         player non-OOC turns only; emits IntentBrief; degrades to detectIntent)
      e. deterministic, no LLM: intent detection · scene snapshot ·
         presence channels + roster (sight/comms/absent, see perception.md) ·
         per-NPC awareness blocks · darkness read · comms staging ·
         wardrobe visibility · movement intent + follow scores ·
         canonical character facts · meter/condition surface · NPC affordances
 4. assemble prompt (see prompts.md) → streamText (per-world narrative model,
      low-latency provider routing for faster first token. No reasoning knob is
      set: the default narrator Aion 2.0 is served only by the AionLabs endpoint,
      which ignores OpenRouter's reasoning controls (2026-06-21 probe — effort and
      `reasoning.max_tokens` left usage unchanged; reasoning can't be disabled), so
      flooring effort bought nothing. Both narrator lanes share
      `narrativeProviderOptions` — server/ai/provider.ts) → speaker segmenter → SSE chunks to client
 5. persist narration + turn_messages; turn status → processing; SSE done
 6. POST-TURN (parallel, via post_turn job): simulant · archivist · continuity · director
 7. merge reducer → ONE transaction → turn status ready; session status ready
 8. maintenance: scene-image trigger, lore unlock recompute (async jobs)
```

Steps 1–5 happen inside the request (the SSE response), but **client disconnection does not abort them**: SSE writes are best-effort, the engine loop keeps consuming the model stream and persists the narration regardless. Steps 6–8 run as a `post_turn` job; the client polls `GET /sessions/:id/job` until the session is `ready`.

### Intake agent (3d) — the only pre-narration LLM

`runIntake` (`engine/intake.ts`) is a 5th leg of the pre-turn `Promise.all` in `assemblePreTurn`, **run concurrently with `preTurnRetrieve`** — so it is the **first (and only) LLM in the critical path to first token**, but adds latency to first token only when it is the long pole (`max(0, intake − retrieval)`; both legs are already network-bound, so retrieval often hides it). It reads the player's input *before* narration and emits a typed **`IntentBrief`** (contracts/turns.md §Intent brief) — what the player is trying to do, to whom, with which entities — replacing the brittle regex intent as the primary signal.

- **Model & resilience**: `generateChecked` on the **in-session agent model** (`agentModelId(world.agentModel)` — the per-world override set from the World tab, default `deepseek/deepseek-v4-flash`; shared with the post-turn agents), temperature 0, small schema, `maxOutputTokens` ~512, **reasoning disabled** (`reasoning: false`). Intake is a fast classifier, not a reasoner; left on, a reasoning model spends the latency/output budget thinking — the cause of a 91% timeout-fallback rate on the former gemini-3.5-flash default ([pre-narrator-agents.followups.md](developer-notes/pre-narrator-agents.followups.md)). The full ladder applies (typed output → degraded default; intake **skips the repair round-trip** — see below).
- **Timeout → regex fallback**: wrapped in a hard timeout (`INTAKE_TIMEOUT_MS = 1500`) backed by an `AbortSignal`. On timeout, failure, demo mode, or when disabled (`INTAKE_DISABLED` env), it **degrades to today's regex `detectIntent`** via `intentBriefFromSceneIntent(...)`. The fallback is the *previously-live* code path, so "intake off" is byte-for-byte today's behavior — a clean new-trust-boundary example (resilience.md §3). On timeout the in-flight call is **aborted** (not orphaned): it stops mid-request and emits no further diagnostics, so a timed-out turn carries exactly one `agent.intake.timeout` (and intake's degrade logs at `warn`, not `error` — it is best-effort by contract). Intake also runs a **single attempt** (no repair round-trip): the repair is a second sequential call whose result the timeout would discard anyway.
- **When it runs**: player-authored, non-OOC turns only. Companion-authored and OOC turns get an empty brief (no LLM call).
- **Persistence**: the `IntentBrief` is stored on the turn row in a new `intent_brief` jsonb column (mirroring `agent_results`), so it survives the turn and the post-turn agents read it back.
- **Consumers**: the brief is adapted to a `SceneIntent` via `sceneIntentFromBrief(brief)` (lossless — the brief's `lookTarget`/`touchTarget`/`smellTarget`/`examineItem`/`enterLocation` mirror the regex `SceneIntent`) and fed to the three existing pre-turn consumers unchanged in signature — `raiseExposureForIntent`, `buildGlanceImpressions`, `buildAwarenessBlocks`. Post-turn, the continuity agent's awareness rebuild (`engine/agents.ts`) reuses the **persisted** brief instead of re-running `detectIntent`, removing a duplicated derivation and guaranteeing the pre- and post-turn awareness blocks match. `buildTurnDigest` does not consume intent and is unchanged; `stagedLocationAnchor` keeps its own internal regex (movement enforcement is a downstream phase-4 spec, not v1).
- **Scope**: v1 ships the classifier and its plumbing only. The brief's `movement`, `appointment`, and `check` fields are **persisted seams** — written but not yet enforced; the movement-authority and scheduled-arrivals specs (and future skill-check resolution) consume them later.
- **Social acts** (personality §6): the brief's `socialActs` (a `{ concept, target }` array — concept from the interaction-concept vocabulary, target a present character; v1 plays the **primary** entry) drive the **authored-disposition reaction**, consumed both pre-turn (`buildReactionLine`) and post-turn (merge step 5). The regex fallback leaves it empty ⇒ no reaction fires.
- **Narrated NPC behaviour** (personality §6, Note 2): the brief's `narratedNpcBehaviors` (a `{ npc, concept?, summary? }` array) flags dialogue/affection/action the player's prose put on a present character — the **puppet-guardrail** seam, classified to a concept so the deterministic rule can judge it. Distinct from `socialActs` (the player's own acts toward an NPC) and from `movement.kind:"narrated_npc"` (physical relocation). Empty on the regex fallback ⇒ the guardrail never fires.

### Pre-turn deterministic steps (3e)

- **Intent detection** (`engine/intent.ts`, regex-based — fast and deterministic): classifies the input for `look/examine`, `touch`, `smell`, `enter`, with targets resolved against participant display names and in-scope item names. Drives full-impression rendering (a looked-at character gets their complete glance block) and sensory snippet inclusion. With intake on, this is the **degraded fallback** for the brief, not the primary signal; it still runs (the brief is built from it on intake failure).
- **Scene snapshot**: first visit to a location → full description + all items; revisits → one-line summary + items that changed. Tracked via `runtime.visitedLocationIds`.
- **Movement staging + access**: an enter intent toward an adjacent location stages that location in the prompt — unless the connecting link fails the same `checkLinkAccess` rule the merge enforces (locked, closed time window, sealed door), in which case the movement-guidance block tells the narrator to play the blocked threshold and never describe the far side. The merge re-checks and drops the move regardless (belt and suspenders; the narrator is guidance, the merge is law).
- **Follow scores**: when the player moves, each co-located NPC gets a deterministic follow likelihood from: relationship **stage** when a `participant_relationships` edge exists (active `relationship` fact count is the fallback; hostile/wary/stranger are gated below likely-follows regardless of score), interaction recency (`runtime.lastInteractedTurn`), activity stickiness (busy NPCs stay), and whether the input addressed them. Surfaced as movement guidance for the narrator, not a hard rule.
- **Relationship stages**: present NPCs get a stage line in the turn context (feeling toward the player + the perceived edge) — stages, never raw affinity values, go in prompts.
- **Social reaction** (`buildReactionLine`, `engine/scene.ts`): the player's primary `socialActs` entry is resolved against the target NPC's bespoke disposition (`resolveSocialReaction`) and run through the affinity-aware curve over the NPC's turn-start *feeling* edge **and turn-start mood** (the curve's `μ`, from the mood meter via `moodMeterToFactor` — a bad mood sharpens a slight), scaled by the NPC's traits (`socialTraitScale` — agreeableness/composure soften a dislike, possessiveness sharpens a jealousy trigger); on a match, a **Reaction** line in the volatile turn context tells the narrator the verdict (band + hint). The same resolve/evaluate/scale runs in the merge over the same turn-start feeling + mood, so the hint and the applied affinity delta cannot disagree.
- **Disposition** (`buildDispositionBlock`, `engine/scene.ts`): each cast member's **non-intimate** trait bands render as stable behavioural guidance in the **cached** static-rulebook region (closes character-schema audit C1; core traits don't change, so the prefix stays stable). Intimate trait bands (`buildIntimateDispositionLine`) surface in the **volatile** turn context only when the turn's exposure reaches the intimate appearance tier — the same gate intimate attributes ride.
- **Puppet deflection** (`buildPuppetDeflection`, `engine/scene.ts`; personality §6, Note 2): each `narratedNpcBehaviors` entry against a present character is run through `checkPuppetContradiction`. A behaviour that **contradicts** disposition adds a **Disposition guardrail** directive to the volatile turn context — the narrator must not honour it and answers with a brief in-voice meta aside ("…raises an eyebrow — those are their words to choose, not yours."); consistent (in-disposition) puppeting passes silently. A behaviour naming a non-present character logs `scene.puppet.unresolved_target` and is skipped (the absence notice handles voicing). v1 ships the directive only — **no merge-level state strip**: the narrator's refusal means the puppeted act never reaches the post-turn agents, so there is nothing to drop. The broader puppet-handling system is deferred (`npc-puppeting.deferred.md`).
- **Presence & perception** (`contracts/perception/` + `engine/scene.ts`, see [perception.md](perception.md)): every participant is classified into a presence **channel** (`sight` co-located · `comms` active call/text link · `absent`); the roster renders Present / On call/text / Nearby / Elsewhere. Per sight-present NPC a deterministic **awareness block** (attention × salience) tells the narrator what they can perceive, plus capped pairwise NPC↔NPC blindspot lines. A **comms** staging step: a detected "I call/text X" intent (`detectCommsIntent`) stages that NPC as `comms`-present for the turn and adds them to the speaker-tag list. A **darkness** read (`darknessVerdict(band, ambient.light)`) downgrades visual salience and adds a scene line.
- **Chain cap**: player input matching ≥ `MAX_CHAINED_ACTIONS` registered actions adds a pacing directive — narrate at most the first two, end the beat there (stop, don't compress).
- **NPC schedules**: `CharacterProfile.schedule` entries (start/end minute-of-day → location, activity, optional `days` weekday mask) apply to **off-screen** NPCs on clock advance, shifted by a seeded per-character daily jitter (±`SCHEDULE_JITTER_MINUTES`, FNV-1a over `participantId::dayIndex`); on-screen NPCs are never teleported by schedule.

## Post-turn agents

All four: AI SDK `generateChecked` (validate → 1 repair → degraded default, per [resilience.md](resilience.md)), the **in-session agent model** by default (`agentModelId(world.agentModel)` — per-world override from the World tab, default `deepseek/deepseek-v4-flash`; shared with intake), temperature 0, **small single-concern schemas**, world entities referenced by display name, and **low-latency provider routing** (`provider:{sort:"latency"}` — the four fan out in parallel, so trimming each one's first-token tail returns the session to "ready" sooner; same model weights, no quality change). Unlike intake, the post-turn agents keep the repair round-trip and do **not** force reasoning off — they reason over the finished narration and their result is worth a second try. Inputs: the narration, the player input, and a per-agent slice of state — never the whole world. The agent-model switch is **in-session only** — the world/character authoring agents and the image pipeline (scene composer + image models) stay on the plain `state`/`tool` defaults.

### simulant — what physically changed

```ts
{
  minutesAdvanced: number,                       // clamped 1–480 in reducer
  movements: [{ participantName, toLocationName, reason? }],
  itemEvents: [{ action: "wear"|"remove"|"pick_up"|"drop"|"place"|"store_in"|"take_from"|"open"|"close"|"alter",
                 itemName, byName?, locationName?, containerName?, stateNote?,
                 salience?: { visual: "obvious"|"subtle", audible: "loud"|"quiet"|"silent" } }],
  meterAdjustments: [{ participantName, meterId, delta, reason? }],          // −1–1
  conditionEvents: [{ op: "add"|"end", participantName, label, severity?, durationMinutes?, promptHint? }],
  attributeChanges: [{ participantName, attributeId, value, note? }],        // rare: haircut, injury
  activityUpdates: [{ participantName, activity, posture?,
                      salience?: { visual: "obvious"|"subtle", audible: "loud"|"quiet"|"silent" } }],
  affinityAdjustments: [{ fromName, towardName, delta, reason? }],            // trait-scaled (scaleAffinityGain) then clamped ±AFFINITY_DELTA_CLAMP per edge per turn in reducer
  commsEvents: [{ op: "open"|"close", kind: "call"|"text", withName }],       // call/text links → runtime.commsLinks (see perception.md)
}
```

### archivist — what should be remembered

```ts
{
  episodeSummary: string,                        // 2–4 sentences, past tense
  facts: FactDraft[],                            // taxonomy in contracts/facts.md
  supersedeHints: [{ factIndex, oldFactText }],  // resolver still gates by similarity
}
```

### continuity — what the narration got wrong

```ts
{
  violations: [{ subject, claim, canonical, severity: "minor"|"major",
                 kind: "general" | "narrated_absent_character" | "reacted_to_unperceived_event" }],
  cardBreaches: [{ cardId, concept, byName, witnessNames: string[] }],
  driftNotes: string[],                          // style/POV drift observations
}
```

Violations become next-turn correction directives (self-expiring — the brief is regenerated every turn). `cardBreaches` is the taboo/social-rule mechanic (`social-reaction-cards.plan.md`): the agent receives the world's `style.socialCards` and flags witnessed breaches (by **card id** + concept — it does not author the reaction); the merge's `planCardBreachReactions` resolves each witness's reaction **deterministically** (their own tags + the §6 curve → a per-witness affinity fold on the witness→player edge **when the player is the breacher**) and emits a directive per breach so NPCs respond in character next turn.

### director — where the story goes next

```ts
{
  sceneSummary: string,
  storySoFar: string,                            // rolling 3–5 sentence synopsis
  characterNotes: string[],
  directives: string[],                          // next-turn tone/pacing constraints
  memoryQueries: string[],                       // seeds next turn's retrieval
  atmosphere?: AtmosphereLabel,                  // scene tone (scene-atmosphere.spec.md); absent ⇒ hold the prior tone
  threadSignals: { touch: [{id?, title}], develop: [{id?, entry, entryKind?, summary?}], propose: [{title, kind, question?, summary, closeConditions?}], resolve: [id] },  // see story-threads.md
  imageMoment?: { worthIt: boolean, description: string },   // feeds scene-image trigger
}
```

## Merge reducer

`engine/merge/` — deterministic, fully unit-testable, no LLM. The reducer plans over a
`WorkingState` (`merge/working-state.ts`): the mutable per-turn copy of participants/items
behind an ADT that owns dirty-tracking — every world mutation goes through a method that
marks the right dirty set, so a dropped DB write from a forgotten mark is structurally
impossible (an ESLint `no-restricted-syntax` gate forbids direct field assignment outside
that file). Name→row resolution lives in `merge/grounding.ts`; `planTurnEffects` (the
orchestrator) and `applyTurnResults` (the one write transaction) in `merge/index.ts`. The
ongoing decomposition is [merge-decomposition.plan.md](developer-notes/merge-decomposition.plan.md).
Order:

1. **Ground names → rows**: participants by display name (case-insensitive; canonical casing from the row); items via the resolver (exact name → alias → embedding-fuzzy ≥0.75 against in-scope instances only — bounded search space; action-aware preference, e.g. `remove` prefers worn instances). Unresolvable references → diagnostic (`merge.item.unresolved`, `merge.participant.unresolved`), event dropped, and the dropped event is recorded in `brief.droppedEvents` so the next turn can gently correct any narration/state divergence.
2. **Validate moves** against the session location graph (adjacent links only; player never moved unless author is the player). Invalid → diagnostic, dropped. Player moves additionally pass the link-access check (`checkLinkAccess` in `contracts/world/access` — one pure rule, shared with future NPC traversal): `locked` blocks even a key-holder (`keyItemId` reserved), `timeWindow` checks the **turn-start** minute of day (windows wrap past midnight; zero-length degrades to open), a bound `doorItemId` instance whose state is closed+locked seals the link, `private` has no player effect yet. Blocked → `merge.movement.access_denied` + a `droppedEvents` note so the next narration plays the locked door instead of teleporting through it. A link without an `access` field parses to `public` at the bundle boundary — exactly today's behavior.
3. **Apply item events** to placement/state; wear/remove recompute wardrobe visibility. A `remove` honors the event's destination: a `containerName` stows the garment off-body in that container (hamper/drawer), a `locationName` drops it in the open at that location (an unresolvable phrase like "the floor" falls back to the actor's room), and a bare `remove` keeps it **held** in hand — so "kicks off her sneakers, they thud to the floor" lands them on the floor, not in her hand (followups.phase4.md §8). Placement exclusivity (held / worn / in-location / in-container) is asserted here **and** by a DB CHECK constraint.
4. **Clock**: resolve turn minutes (`resolveTurnMinutes`) as the **max** — never sum — of travel (the moved player's link `travelMinutes`), registered actions (action-duration registry, matched in the player's input via `matchActions`), **declared rest**, and the clamped `minutesAdvanced` estimate; the dominant cause persists as `agentResults.clock = { minutes, cause }`. Declared rest (`detectDeclaredRest` in `engine/intent.ts`, deterministic regex like the rest of intent detection): "I sleep" / "I go to bed" / "I sleep until morning" / "I wait until evening" resolve to a schedule-aware endpoint — an explicit wake time when stated ("until 7am", ambiguous 12-hour times pick the sooner occurrence; "for 2 hours" is a duration), else the next dawn band start (`DAYLIGHT_BAND_START_MINUTES` in `lib/clock.ts`), wrapping past midnight from the turn-start time. Its minutes clamp to `REST_CLAMP_MINUTES = 960` (`merge.clock.rest_clamped`) — the estimate keeps the normal 480 clamp — and the cause reads as rest ("slept until morning"). Bare "wait" without a parseable time, negations ("I can't sleep"), and registered actions ("I take a nap") never trigger it. Apply meter drift (toward each meter's resting baseline at `recoveryPerHour × hours`, **per-character** — traits shift the baseline/recovery via `personalizeMeters`, e.g. an optimist rests at a higher mood, a high-libido character's arousal rests elevated and decays slower; a rest span drifts in full — and **standing mood influences** further shift the mood baseline before drift: active conditions (`conditionMoodBaselineShift`) and, for NPCs co-located with the player, the scene atmosphere (`atmosphereMoodBaselineShift`, composure-damped — [scene-atmosphere.spec.md](developer-notes/scene-atmosphere.spec.md), mood.spec §5), so a tense room settles a present character lower without compounding a per-turn delta), then registered-action `meterEffects` (sleep/nap effects still apply), **then** agent meter deltas — agents ground their deltas in the narration, which already reflects elapsed time, so corrections win; expire conditions past duration; tick off-screen NPC schedules (day mask + jitter, see pre-turn). Schedules apply **once, at the post-turn clock**: intermediate slots across a rest span are skipped, not simulated — world-tick batching across the span is reserved for the offscreen-simulation phase. A tick that moves an NPC into or out of the player's location stages an arrival/departure line for the brief (step 8); ticks elsewhere stage nothing. **Director-staged movement** (see below) advances **before** this schedule tick so a committed NPC is not yanked back to its routine.
5. **Affinity**: decay first — 1 point per whole elapsed in-game week toward 0, never crossing a stage boundary (it stops at a **trait-derived floor at-or-above** the current stage's zero-side edge — `affinityDecayRetention` from the owner's warmth + composure lifts that floor toward the current value, so a constant character's regard ebbs more slowly; floor ≥ boundary keeps decay stage-preserving; a stop logs an `events` row, `type: "affinity_decay_clamped"`), tracked via `runtime.lastAffinityDecayAt` (a backwards marker resets with `merge.affinity.decay_marker_reset`). Then resolve `affinityAdjustments` pairs — each owner's summed raw delta is **trait-scaled** (`scaleAffinityGain`: warmth/agreeableness amplify gains, guardedness damps them, composure damps losses) before the ±`AFFINITY_DELTA_CLAMP` clamp — → upsert `participant_relationships` rows (value + denormalized stage; player-as-`fromName` writes the NPC's *perceived* edge — decision 41); stage transitions log an `events` row (`type: "affinity_stage"`); unresolved pairs → diagnostic (`merge.affinity.unresolved_pair`), dropped. **Social-reaction affinity** (`planReactionAffinity`, personality §6) runs alongside: the player's primary `socialActs` entry is resolved against the target NPC's disposition and the affinity-aware curve produces a deterministic delta on the NPC's *feeling* edge (from the turn-start feeling **and turn-start mood** — captured before step-4 drift — so the narrator hint and the applied number agree), clamped ±`AFFINITY_DELTA_CLAMP`. That edge is **authoritative for the turn**: `combineAffinityUpdates` drops any simulant `affinityAdjustments` on it — even when the reaction's delta rounds to 0 ("lets it slide"). The reaction also **nudges the target's mood meter** (`moodNudge` — a like lifts, a dislike lowers; affinity-scaled via the curve magnitude), applied after drift. Unresolved target → `merge.reaction.unresolved_target`, dropped. **Witnessed card breaches** (`planCardBreachReactions`, from the continuity agent's `cardBreaches`) run alongside: each perceiving witness folds its own card reaction (their tags + the curve) into the witness→player edge when the player is the breacher; those edges are owned too (simulant updates there are dropped).
6. **Facts**: embed drafts (batch); supersede same-subject actives with cosine ≥ 0.86 (subject compared lowercased); insert, stamped `witnessed_by` — the **perception-based witness set** (`[player, ...perceivers]`, attention × salience over the turn's salient actions, see [perception.md](perception.md) and [memory.md](memory.md)), not interim co-location.
7. **Episode** insert + embed (same `witnessed_by` stamp). **Threads**: apply the director's `threadSignals` to `runtime.storyThreads` — touch (keep warm), develop (append an accumulated development on a major beat + revise the summary), propose (open a new thread; near-duplicate proposals are semantically folded into the matching open/cooling thread before the pure reducer runs), resolve (close an investigation). Lifecycle: open → cooling after 8 untouched turns → resolved/archived; seeded at spawn from world plot anchors; the top 3 open threads ride in every turn context; resolved/archived drop from both the narrator context and the status payload (so a resolved thread is never re-raised as if unsettled). **Full system — kinds, dedup, developments, the detail modal, manual close: [story-threads.md](story-threads.md).** Runtime also records `lastInteractedTurn` per NPC (intent targets, the companion speaker, co-located NPCs addressed by name — never mere co-presence), which feeds the follow-score recency term. **Comms links**: the simulant's `commsEvents` open/close `runtime.commsLinks` so a call/text survives across turns (`planCommsEvents`); names resolve like other agent refs (unresolved → `merge.comms.unresolved`, dropped), and open/close log `comms_link_opened` / `comms_link_closed` events (see [perception.md](perception.md)).
8. **Brief**: build `NextTurnBrief` from director output (incl. the **sticky scene atmosphere** — `resolveAtmosphere`: the director's tone or, absent, the prior brief's, with a deterministic intimate-frame floor) + continuity corrections & card-breach reactions (max 2, prefixed `Correction:`) + crossed meter thresholds + dropped events + schedule-tick **and staged-arrival** staging (`brief.arrivals`/`brief.departures` — "Mara arrived from the market." / "Tom left toward the docks.", rendered as the turn context's "Comings and goings" block) + on-arrival directives from staged beats that fired this turn. Staging lines are per-turn and never carry forward from the prior brief; v1 assumes co-located ⇒ perceived (the same interim rule as `witnessed_by`) — the presence phase's witness machinery gates these lines when it ships.
9. Single transaction commit; persist raw `agent_results` + diagnostics on the turn.

### Director-staged movement (phase-4 npc-movement, minimal slice)

So the narrator can play beats that need an absent NPC physically relocated first — "Maya texts: I'm locked out, come let me in" while her tracked location is still the clinic — without teleporting or contradicting state. Strict separation of concerns: the **director decides** (a story decision), a **movement system executes** (`engine/movement.ts`, no story logic), the **narrator plays** what surfaces (constrained — see [perception.md](perception.md) §Comms).

- **Decide** (step 7-adjacent): the director's `stageMovement.stage` (npcName + destinationName + reason + optional on-arrival comms/directive) resolves names → ids into a `runtime.stagedIntents` entry; `stageMovement.cancel` drops one by id. Unresolved names → `merge.movement.intent_unresolved`, dropped. A newly-created intent takes its **first hop next turn** (it advances only pre-existing intents this turn — the NPC has to set out).
- **Execute** (step 4, before the schedule tick): `applyStagedIntents` advances each active intent **one hop** along the shortest passable path (`nextHopToward` — BFS over `session_links`, reusing `checkLinkAccess`, nodes-only) toward its destination, setting a "heading toward X" transit activity so the Cast tab stays honest. Commitment: a staged NPC is added to the turn's staged set and skipped by the schedule tick. No path / budget spent (`expiresInTurns`, default `STAGED_INTENT_DEFAULT_BUDGET = 6`) / participant gone → cancel with `merge.movement.unreachable` / `intent_expired` / `intent_orphaned`; never marches at a wall.
- **Fire** (on the arriving hop): resolve the intent (pruned from runtime) and surface its payload — append the comms gist to `runtime.pendingComms` (the **surface-once** queue: rendered in the next turn's "Messages & calls" line, then cleared by the following merge; reconcile preserves it; capped at `PENDING_COMMS_CAP`) and/or fold the directive into the next brief.

### Degraded defaults (exact values when an agent fails)

| Agent | Fallback |
| --- | --- |
| intake (pre-turn) | `intentBriefFromSceneIntent(detectIntent(input))` — the brief reconstructed from today's regex; movement/appointment/check seams empty. So timeout/failure/demo ⇒ exactly prior behavior, with a diagnostic |
| simulant | `{ minutesAdvanced: 30, movements: [], itemEvents: [], meterAdjustments: [], conditionEvents: [], attributeChanges: [], activityUpdates: [], affinityAdjustments: [], commsEvents: [] }` — clock still advances, drift still applies |
| archivist | `{ episodeSummary: first ~300 chars of narration, facts: [], supersedeHints: [] }` + diagnostic |
| continuity | `{ violations: [], cardBreaches: [], driftNotes: [] }` |
| director | previous brief with `sceneSummary` replaced by the episode summary; `memoryQueries` carried forward |

All constants (`FALLBACK_MINUTES_ADVANCED = 30`, `MAX_CHAINED_ACTIONS = 2`, `DEFAULT_LINK_TRAVEL_MINUTES = 1`, `SCHEDULE_JITTER_MINUTES = 15`, `AFFINITY_DELTA_CLAMP = 5`, `REST_CLAMP_MINUTES = 960`, `INTAKE_TIMEOUT_MS = 1500`, clamps, thread cooling thresholds) live in `engine/constants.ts`.

## Other paths

- **Spawn** (`engine/spawn.ts`): a session is a full instantiation of its world — locations, links, cast snapshots, item instances — so play never reads world/library rows again. The world is itself already a snapshot copy of the library (the library → world → session cascade; [developer-notes/world-instances.plan.md](developer-notes/finished/world-instances.plan.md)), so spawn copies straight from each `world_*` row's `snapshot` (no joins to `characters`/`locations`/`items`; a deleted library row never breaks a spawn). The embodied player may pick any library character: if that character is **in the cast**, its cast row is promoted in place to the player participant (`is_user`, role `player`, tier `major`, keeping the `world_cast` linkage so items placed on it and the worn-outfit dedup still resolve), and its authored cast placement beats the world's generic player start; otherwise a fresh player participant is appended. Default outfits seed for every cast member **and** the player (the player seed loads before the world material so a non-cast player's `defaultOutfit` ids are in the lookup). Relationship seeding treats a played cast member per decision 41 (players own no edges): edges toward its name count as toward-player, and its own authored edges seed the NPC side instead.
- **Companion-authored turns** (`author: "companion"`): a present NPC speaks first; same pipeline with speaker context. `turns.speaker_participant_id` is set only on these turns.
- **OOC turns** (player input with a leading OOC marker, `isOocInput` in `engine/intent.ts`): the narrator answers out of character from the turn context (see [prompts.md](prompts.md)); intent detection is skipped (an OOC "can I go to the beach?" must not stage a movement), and after the answer persists the turn goes straight to `ready` — **no post-turn agents, no clock advance, no episode or facts**. A meta exchange has zero world impact.
- **Edit / rerun**: editing narration triggers a `reconcile` job — simulant + archivist re-run in end-state mode (no time advance); facts sourced from the edited turn are retracted and re-extracted. The brief is not rebuilt (no director/continuity ran), but the reconcile's dropped events and newly crossed meter thresholds fold into it (`reconcileBrief`) so an edit that references unknown entities or shifts a meter across a threshold still surfaces on the next turn instead of failing silently. Rerun = retract turn effects (facts retracted, episode deleted), then resubmit the same input. **Supersedence is not reversed**: if a now-retracted fact had superseded an older fact, the older fact stays superseded (both invisible to retrieval; `superseded_by_id` keeps the audit trail). History moved past it — resurrecting old facts causes worse continuity than losing one.
- **Restart** (`POST /sessions/:id/restart`): deletes turns, messages, episodes, facts, item instances, session locations and resets clock/runtime/brief, then re-materializes everything from the world definition — identical to a fresh spawn, same session id. Scene gallery images are kept (flagged `meta.preRestart`).
- **Demo mode**: no API key → template narrative + heuristic agent results (keyword movement detection, zero facts) so the full loop works in CI.

## Jobs and ordering

`engine/jobs.ts`: DB-backed `jobs` rows + in-process runner, **strictly serial per session** (concurrent across sessions). `post_turn` and `reconcile` jobs share the session queue, which makes their ordering trivial: an edit's reconcile finishes before the next turn's merge can start, because `submitTurn`'s CAS only succeeds when the session is `ready`, and the session only returns to `ready` when its job queue drains. `inner_note` jobs (`engine/inner-note.ts`, queued by the participant inner-note route) ride the same serial queue — so they can never interleave with a merge — but, like image jobs, never gate session readiness: one `generateChecked` extraction turns a player-authored interior note into NPC-bound facts (addFacts path) plus a self-expiring guidance line appended to `brief.characterNotes`; in demo mode or on extraction failure the note is stored verbatim (see [memory.md](memory.md) §Authored interior facts).

- Jobs are claimed atomically (`UPDATE jobs SET status='running', runner_id=$me WHERE id=$1 AND status='queued' RETURNING *`) so even an accidental second app instance cannot double-process.
- Liveness uses **heartbeats, not age**: turns and jobs carry `heartbeat_at`, refreshed every ~5s while streaming/processing. Recovery fails only rows whose heartbeat is >60s stale — a slow-but-alive narrative stream is never clobbered.
- **Recovery runs three ways**, all heartbeat-based (multi-instance-safe): (1) per-session on each `submitTurn` (`recoverAbandonedTurns`); (2) on **server boot** via `src/instrumentation.ts` `register()`; (3) a **periodic global sweep** (`sweepAbandonedSessions`, every `RECOVERY_SWEEP_INTERVAL_MS`) started by that same hook. The sweep exists because on-submit recovery can't reach a session whose UI is **blocked while wedged** — e.g. a process restart orphans an in-flight `post_turn` job (its `setInterval` heartbeat dies with the process), leaving the session pinned in `processing` ("The world is settling…") with no submit possible. The sweep reconciles every non-`ready` session, so such a session self-heals within ~stale + one sweep (~60–90s) instead of forever.
- Every job type is idempotent. The jobs table is the contract — moving to an external worker (BullMQ, pg-boss) for multi-instance deployment changes the runner only. **The in-process runner is a single-instance design**; this is an accepted constraint for now.

## Invariants (tested)

- Two concurrent `submitTurn` calls: exactly one proceeds (CAS), the other gets 409.
- A turn always terminates in `ready` or `failed`; the session always returns to `ready` (a failed turn does not wedge the session).
- A client disconnect mid-stream changes nothing server-side: narration persists, post-turn runs, the next poll shows the finished turn.
- Edit-then-immediately-submit: the new turn's merge never interleaves with the reconcile (serial session queue).
- Merge with all-agents-failed input still advances the clock by `FALLBACK_MINUTES_ADVANCED`, applies drift, and writes a synthetic episode.
- No item instance can hold two placements (CHECK constraint + reducer assertion); no participant can be in a non-existent location.
