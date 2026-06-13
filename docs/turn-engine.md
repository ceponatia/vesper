# Turn engine

`src/server/engine/` — the multi-agent orchestration core. One turn = **pre-turn fan-out → narrative stream → post-turn agent fan-out → deterministic merge → maintenance jobs**. Parallelism is the design, not an optimization: retrievals run concurrently before the narrative; four specialized agents run concurrently after it.

## Lifecycle

```
submitTurn(sessionId, input, author)
 1. CAS sessions.status ready→narrating (409 on conflict); recover abandoned turns
 2. create turn row (status narrating)
 3. PRE-TURN (parallel):
      a. episode RAG retrieve        (PREVIOUS turn's brief.memoryQueries + input)
      b. fact retrieve               (same queries, facts table)
      c. lore retrieve               (retrieval-tier chunks, eligibility-filtered FIRST)
      d. deterministic, no LLM: intent detection · scene snapshot ·
         presence channels + roster (sight/comms/absent, see perception.md) ·
         per-NPC awareness blocks · darkness read · comms staging ·
         wardrobe visibility · movement intent + follow scores ·
         canonical character facts · meter/condition surface · NPC affordances
 4. assemble prompt (see prompts.md) → streamText (per-world narrative model)
      → speaker segmenter → SSE chunks to client
 5. persist narration + turn_messages; turn status → processing; SSE done
 6. POST-TURN (parallel, via post_turn job): simulant · archivist · continuity · director
 7. merge reducer → ONE transaction → turn status ready; session status ready
 8. maintenance: scene-image trigger, lore unlock recompute (async jobs)
```

Steps 1–5 happen inside the request (the SSE response), but **client disconnection does not abort them**: SSE writes are best-effort, the engine loop keeps consuming the model stream and persists the narration regardless. Steps 6–8 run as a `post_turn` job; the client polls `GET /sessions/:id/job` until the session is `ready`.

### Pre-turn deterministic steps (3d)

- **Intent detection** (`engine/intent.ts`, regex-based — fast and deterministic): classifies the input for `look/examine`, `touch`, `smell`, `enter`, with targets resolved against participant display names and in-scope item names. Drives full-impression rendering (a looked-at character gets their complete glance block) and sensory snippet inclusion.
- **Scene snapshot**: first visit to a location → full description + all items; revisits → one-line summary + items that changed. Tracked via `runtime.visitedLocationIds`.
- **Movement staging + access**: an enter intent toward an adjacent location stages that location in the prompt — unless the connecting link fails the same `checkLinkAccess` rule the merge enforces (locked, closed time window, sealed door), in which case the movement-guidance block tells the narrator to play the blocked threshold and never describe the far side. The merge re-checks and drops the move regardless (belt and suspenders; the narrator is guidance, the merge is law).
- **Follow scores**: when the player moves, each co-located NPC gets a deterministic follow likelihood from: relationship **stage** when a `participant_relationships` edge exists (active `relationship` fact count is the fallback; hostile/wary/stranger are gated below likely-follows regardless of score), interaction recency (`runtime.lastInteractedTurn`), activity stickiness (busy NPCs stay), and whether the input addressed them. Surfaced as movement guidance for the narrator, not a hard rule.
- **Relationship stages**: present NPCs get a stage line in the turn context (feeling toward the player + the perceived edge) — stages, never raw affinity values, go in prompts.
- **Presence & perception** (`contracts/perception/` + `engine/scene.ts`, see [perception.md](perception.md)): every participant is classified into a presence **channel** (`sight` co-located · `comms` active call/text link · `absent`); the roster renders Present / On call/text / Nearby / Elsewhere. Per sight-present NPC a deterministic **awareness block** (attention × salience) tells the narrator what they can perceive, plus capped pairwise NPC↔NPC blindspot lines. A **comms** staging step: a detected "I call/text X" intent (`detectCommsIntent`) stages that NPC as `comms`-present for the turn and adds them to the speaker-tag list. A **darkness** read (`darknessVerdict(band, ambient.light)`) downgrades visual salience and adds a scene line.
- **Chain cap**: player input matching ≥ `MAX_CHAINED_ACTIONS` registered actions adds a pacing directive — narrate at most the first two, end the beat there (stop, don't compress).
- **NPC schedules**: `CharacterProfile.schedule` entries (start/end minute-of-day → location, activity, optional `days` weekday mask) apply to **off-screen** NPCs on clock advance, shifted by a seeded per-character daily jitter (±`SCHEDULE_JITTER_MINUTES`, FNV-1a over `participantId::dayIndex`); on-screen NPCs are never teleported by schedule.

## Post-turn agents

All four: AI SDK `generateChecked` (validate → 1 repair → degraded default, per [resilience.md](resilience.md)), `STATE_MODEL` by default, temperature 0, **small single-concern schemas**, world entities referenced by display name. Inputs: the narration, the player input, and a per-agent slice of state — never the whole world.

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
  affinityAdjustments: [{ fromName, towardName, delta, reason? }],            // clamped ±AFFINITY_DELTA_CLAMP per edge per turn in reducer
  commsEvents: [{ op: "open"|"close", kind: "call"|"text", withName }],       // call/text links → runtime.commsLinks (see perception.md)
}
```

### archivist — what should be remembered

```ts
{
  episodeSummary: string,                        // 2–4 sentences, past tense
  facts: FactDraft[],                            // taxonomy in contracts.md
  supersedeHints: [{ factIndex, oldFactText }],  // resolver still gates by similarity
}
```

### continuity — what the narration got wrong

```ts
{
  violations: [{ subject, claim, canonical, severity: "minor"|"major",
                 kind: "general" | "narrated_absent_character" | "reacted_to_unperceived_event" }],
  normBreaches: [{ normRule, byName, witnessNames: string[], suggestedReaction }],
  driftNotes: string[],                          // style/POV drift observations
}
```

Violations become next-turn correction directives (self-expiring — the brief is regenerated every turn). `normBreaches` is the generalized taboo/social-rule mechanic: the agent receives the world's `style.norms` list and flags witnessed breaches; the merge folds suggested witness reactions into the brief's directives so NPCs respond in character next turn.

### director — where the story goes next

```ts
{
  sceneSummary: string,
  storySoFar: string,                            // rolling 3–5 sentence synopsis
  characterNotes: string[],
  directives: string[],                          // next-turn tone/pacing constraints
  memoryQueries: string[],                       // seeds next turn's retrieval
  threadSignals: { touch: [{id?, title, summary?}], propose: [{title, summary}], resolve: [id] },
  imageMoment?: { worthIt: boolean, description: string },   // feeds scene-image trigger
}
```

## Merge reducer

`engine/merge.ts` — deterministic, fully unit-testable, no LLM. Order:

1. **Ground names → rows**: participants by display name (case-insensitive; canonical casing from the row); items via the resolver (exact name → alias → embedding-fuzzy ≥0.75 against in-scope instances only — bounded search space; action-aware preference, e.g. `remove` prefers worn instances). Unresolvable references → diagnostic (`merge.item.unresolved`, `merge.participant.unresolved`), event dropped, and the dropped event is recorded in `brief.droppedEvents` so the next turn can gently correct any narration/state divergence.
2. **Validate moves** against the session location graph (adjacent links only; player never moved unless author is the player). Invalid → diagnostic, dropped. Player moves additionally pass the link-access check (`checkLinkAccess` in `contracts/world/access` — one pure rule, shared with future NPC traversal): `locked` blocks even a key-holder (`keyItemId` reserved), `timeWindow` checks the **turn-start** minute of day (windows wrap past midnight; zero-length degrades to open), a bound `doorItemId` instance whose state is closed+locked seals the link, `private` has no player effect yet. Blocked → `merge.movement.access_denied` + a `droppedEvents` note so the next narration plays the locked door instead of teleporting through it. A link without an `access` field parses to `public` at the bundle boundary — exactly today's behavior.
3. **Apply item events** to placement/state; wear/remove recompute wardrobe visibility. Placement exclusivity (held / worn / in-location / in-container) is asserted here **and** by a DB CHECK constraint.
4. **Clock**: resolve turn minutes (`resolveTurnMinutes`) as the **max** — never sum — of travel (the moved player's link `travelMinutes`), registered actions (action-duration registry, matched in the player's input via `matchActions`), **declared rest**, and the clamped `minutesAdvanced` estimate; the dominant cause persists as `agentResults.clock = { minutes, cause }`. Declared rest (`detectDeclaredRest` in `engine/intent.ts`, deterministic regex like the rest of intent detection): "I sleep" / "I go to bed" / "I sleep until morning" / "I wait until evening" resolve to a schedule-aware endpoint — an explicit wake time when stated ("until 7am", ambiguous 12-hour times pick the sooner occurrence; "for 2 hours" is a duration), else the next dawn band start (`DAYLIGHT_BAND_START_MINUTES` in `lib/clock.ts`), wrapping past midnight from the turn-start time. Its minutes clamp to `REST_CLAMP_MINUTES = 960` (`merge.clock.rest_clamped`) — the estimate keeps the normal 480 clamp — and the cause reads as rest ("slept until morning"). Bare "wait" without a parseable time, negations ("I can't sleep"), and registered actions ("I take a nap") never trigger it. Apply meter drift (`perHour × hours` — a rest span drifts in full), then registered-action `meterEffects` (sleep/nap effects still apply), **then** agent meter deltas — agents ground their deltas in the narration, which already reflects elapsed time, so corrections win; expire conditions past duration; tick off-screen NPC schedules (day mask + jitter, see pre-turn). Schedules apply **once, at the post-turn clock**: intermediate slots across a rest span are skipped, not simulated — world-tick batching across the span is reserved for the offscreen-simulation phase. A tick that moves an NPC into or out of the player's location stages an arrival/departure line for the brief (step 8); ticks elsewhere stage nothing.
5. **Affinity**: decay first — 1 point per whole elapsed in-game week toward 0, never crossing a stage boundary (it stops at the current stage's zero-side edge; a stop logs an `events` row, `type: "affinity_decay_clamped"`), tracked via `runtime.lastAffinityDecayAt` (a backwards marker resets with `merge.affinity.decay_marker_reset`). Then resolve `affinityAdjustments` pairs → upsert `participant_relationships` rows (value + denormalized stage; player-as-`fromName` writes the NPC's *perceived* edge — decision 41); stage transitions log an `events` row (`type: "affinity_stage"`); unresolved pairs → diagnostic (`merge.affinity.unresolved_pair`), dropped.
6. **Facts**: embed drafts (batch); supersede same-subject actives with cosine ≥ 0.86 (subject compared lowercased); insert, stamped `witnessed_by` — the **perception-based witness set** (`[player, ...perceivers]`, attention × salience over the turn's salient actions, see [perception.md](perception.md) and [memory.md](memory.md)), not interim co-location.
7. **Episode** insert + embed (same `witnessed_by` stamp). **Threads**: apply signals to `runtime.storyThreads` (lifecycle: open → cooling after 8 untouched turns → resolved/archived). Threads are seeded at session spawn from world plot anchors; the top 3 open threads ride in every turn context. Runtime also records `lastInteractedTurn` per NPC (intent targets, the companion speaker, co-located NPCs addressed by name — never mere co-presence), which feeds the follow-score recency term. **Comms links**: the simulant's `commsEvents` open/close `runtime.commsLinks` so a call/text survives across turns (`planCommsEvents`); names resolve like other agent refs (unresolved → `merge.comms.unresolved`, dropped), and open/close log `comms_link_opened` / `comms_link_closed` events (see [perception.md](perception.md)).
8. **Brief**: build `NextTurnBrief` from director output + continuity corrections & norm-breach reactions (max 2, prefixed `Correction:`) + crossed meter thresholds + dropped events + schedule-tick staging (`brief.arrivals`/`brief.departures` — "Mara arrived from the market." / "Tom left toward the docks.", rendered as the turn context's "Comings and goings" block). Staging lines are per-turn and never carry forward from the prior brief; v1 assumes co-located ⇒ perceived (the same interim rule as `witnessed_by`) — the presence phase's witness machinery gates these lines when it ships.
9. Single transaction commit; persist raw `agent_results` + diagnostics on the turn.

### Degraded defaults (exact values when an agent fails)

| Agent | Fallback |
| --- | --- |
| simulant | `{ minutesAdvanced: 30, movements: [], itemEvents: [], meterAdjustments: [], conditionEvents: [], attributeChanges: [], activityUpdates: [], affinityAdjustments: [], commsEvents: [] }` — clock still advances, drift still applies |
| archivist | `{ episodeSummary: first ~300 chars of narration, facts: [], supersedeHints: [] }` + diagnostic |
| continuity | `{ violations: [], normBreaches: [], driftNotes: [] }` |
| director | previous brief with `sceneSummary` replaced by the episode summary; `memoryQueries` carried forward |

All constants (`FALLBACK_MINUTES_ADVANCED = 30`, `MAX_CHAINED_ACTIONS = 2`, `DEFAULT_LINK_TRAVEL_MINUTES = 1`, `SCHEDULE_JITTER_MINUTES = 15`, `AFFINITY_DELTA_CLAMP = 5`, `REST_CLAMP_MINUTES = 960`, clamps, thread cooling thresholds) live in `engine/constants.ts`.

## Other paths

- **Spawn** (`engine/spawn.ts`): a session is a full instantiation of its world — locations (overrides win), links, cast snapshots, item instances — so play never reads world/library rows again. The embodied player may pick any library character: if that character is **in the cast**, its cast row is promoted in place to the player participant (`is_user`, role `player`, tier `major`, keeping the `world_cast` linkage so items placed on it and the worn-outfit dedup still resolve), and its authored cast placement beats the world's generic player start; otherwise a fresh player participant is appended. Default outfits seed for every cast member **and** the player (the player seed loads before the world material so a non-cast player's `defaultOutfit` ids are in the lookup). Relationship seeding treats a played cast member per decision 41 (players own no edges): edges toward its name count as toward-player, and its own authored edges seed the NPC side instead.
- **Companion-authored turns** (`author: "companion"`): a present NPC speaks first; same pipeline with speaker context. `turns.speaker_participant_id` is set only on these turns.
- **OOC turns** (player input with a leading OOC marker, `isOocInput` in `engine/intent.ts`): the narrator answers out of character from the turn context (see [prompts.md](prompts.md)); intent detection is skipped (an OOC "can I go to the beach?" must not stage a movement), and after the answer persists the turn goes straight to `ready` — **no post-turn agents, no clock advance, no episode or facts**. A meta exchange has zero world impact.
- **Edit / rerun**: editing narration triggers a `reconcile` job — simulant + archivist re-run in end-state mode (no time advance); facts sourced from the edited turn are retracted and re-extracted. The brief is not rebuilt (no director/continuity ran), but the reconcile's dropped events and newly crossed meter thresholds fold into it (`reconcileBrief`) so an edit that references unknown entities or shifts a meter across a threshold still surfaces on the next turn instead of failing silently. Rerun = retract turn effects (facts retracted, episode deleted), then resubmit the same input. **Supersedence is not reversed**: if a now-retracted fact had superseded an older fact, the older fact stays superseded (both invisible to retrieval; `superseded_by_id` keeps the audit trail). History moved past it — resurrecting old facts causes worse continuity than losing one.
- **Restart** (`POST /sessions/:id/restart`): deletes turns, messages, episodes, facts, item instances, session locations and resets clock/runtime/brief, then re-materializes everything from the world definition — identical to a fresh spawn, same session id. Scene gallery images are kept (flagged `meta.preRestart`).
- **Demo mode**: no API key → template narrative + heuristic agent results (keyword movement detection, zero facts) so the full loop works in CI.

## Jobs and ordering

`engine/jobs.ts`: DB-backed `jobs` rows + in-process runner, **strictly serial per session** (concurrent across sessions). `post_turn` and `reconcile` jobs share the session queue, which makes their ordering trivial: an edit's reconcile finishes before the next turn's merge can start, because `submitTurn`'s CAS only succeeds when the session is `ready`, and the session only returns to `ready` when its job queue drains. `inner_note` jobs (`engine/inner-note.ts`, queued by the participant inner-note route) ride the same serial queue — so they can never interleave with a merge — but, like image jobs, never gate session readiness: one `generateChecked` extraction turns a player-authored interior note into NPC-bound facts (addFacts path) plus a self-expiring guidance line appended to `brief.characterNotes`; in demo mode or on extraction failure the note is stored verbatim (see [memory.md](memory.md) §Authored interior facts).

- Jobs are claimed atomically (`UPDATE jobs SET status='running', runner_id=$me WHERE id=$1 AND status='queued' RETURNING *`) so even an accidental second app instance cannot double-process.
- Liveness uses **heartbeats, not age**: turns and jobs carry `heartbeat_at`, refreshed every ~5s while streaming/processing. Recovery (on boot and on each turn submit) fails only rows whose heartbeat is >60s stale — a slow-but-alive narrative stream is never clobbered.
- Every job type is idempotent. The jobs table is the contract — moving to an external worker (BullMQ, pg-boss) for multi-instance deployment changes the runner only. **The in-process runner is a single-instance design**; this is an accepted constraint for now.

## Invariants (tested)

- Two concurrent `submitTurn` calls: exactly one proceeds (CAS), the other gets 409.
- A turn always terminates in `ready` or `failed`; the session always returns to `ready` (a failed turn does not wedge the session).
- A client disconnect mid-stream changes nothing server-side: narration persists, post-turn runs, the next poll shows the finished turn.
- Edit-then-immediately-submit: the new turn's merge never interleaves with the reconcile (serial session queue).
- Merge with all-agents-failed input still advances the clock by `FALLBACK_MINUTES_ADVANCED`, applies drift, and writes a synthetic episode.
- No item instance can hold two placements (CHECK constraint + reducer assertion); no participant can be in a non-existent location.
