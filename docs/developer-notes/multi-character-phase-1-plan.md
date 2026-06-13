# Multi-character Phase 1 (foundations) — implementation plan

Status: **completed** (2026-06-12) — three leftovers moved to phase 2;
see the completion note below.

Scope: build-order phase 1 from
[multi-character-overview.phase3.md](multi-character-overview.phase3.md) —
**time-and-travel + cast-tiers-and-affinity + the day-one stamps** that
every later phase consumes. Exact field shapes:
[multi-character-data-model.phase3.md](multi-character-data-model.phase3.md). File
references are starting points, not exhaustive change lists. Later
phases get their own plan authored at phase start.

Everything here is shippable with zero behavior change for worlds that
don't set the new fields (defaults reproduce today's behavior — the
degraded-default discipline applied to a feature rollout).

> **Completion status (2026-06-12).** Shipped, with three leftovers
> moved to [phase-2-plan.md](phase-2-plan.md): the T6 spawn-seeding
> bullet never landed (no authored-relationship structure existed to
> seed from — `stageMidpoint()` shipped unconsumed; now phase-2 T1
> including the authoring surface); the zero-config no-regression
> integration test from the testing section was never written (phase-2
> T4); and affinity decay — specced in the defaults doc, not listed
> here — goes with it (phase-2 T2). Everything else in T1–T12 landed,
> including the stage-transition `events` rows, the clock-delta UI,
> and the relationships panel.

## Task plan

### P0 — Schema & registries (everything else builds on these)

**T1. Migration: link/location/cast/world columns.**
`src/server/db/schema.ts`: `travel_minutes`, `audibility` (reserved),
`access`, `door_item_id` on both link tables; `scale`, `area`,
`affordances` on locations (library + session; world overrides too —
`spawn.ts:56–60` overrides schema); `tier` on `world_cast` +
`session_participants`; `player_start_world_location_id` on worlds;
`canon` + `witnessed_by` on facts. One migration. Spawn copies the new
link/location fields world → session (`spawn.ts:242–271`).

**T2. New tables: `participant_relationships`.**
Directional rows, `kind: feeling | perceived` (perceived only for
player edges — decision 41). `fact_knowers` / `character_episodes`
are **phase 6** — do not create them yet; `witnessed_by` jsonb carries
the interim history.

**T3. Action-duration registry.**
`src/contracts/actions/registry.ts` + tests, following the meters
pattern (`contracts/meters/registry.ts`): schema, readonly array
(start: shower, bathe, nap, sleep, meal, snack, workout, groom),
`actionById`, `matchAction(text)` (alias matching, longest-first like
intent.ts). Include `meterEffects` and the (unused-until-proximity)
`requiredTier?` field.

**T4. Relationship-stage registry.**
`src/contracts/relationships/stages.ts` + tests: stage boundaries as
data, `stageForValue()`. Log stage transitions as `events` rows for
tuning evidence (decision: thresholds are guesses until observed).

### P1 — Engine behavior

**T5. Turn-time resolution in the merge.**
`merge.ts` step 4 (~line 840): travel cost (path sum over
`travel_minutes` when the player moved — movement validation already
resolves the path) → registered action (`matchAction` over player input
+ simulant `activityUpdates`) → estimate; compose
**max(registered, clamped estimate)** (decision 40); apply registry
`meterEffects` deterministically (before drift, so drift+effects order
is defined — document the choice in the code). Constants:
`DEFAULT_LINK_TRAVEL_MINUTES`, `MAX_CHAINED_ACTIONS` in
`engine/constants.ts`. Chain cap v1 = narrator directive only (brief
line when 2 registered actions matched), per decision 9's
don't-over-engineer caveat.

**T6. Affinity: simulant field + merge + seeding + stage surfacing.**
- `contracts/turns/agent-results.ts`: `affinityAdjustments` with
  `.default([])`, delta clamped ±`AFFINITY_DELTA_CLAMP` in the reducer
  (clamp in merge, not schema — agents exaggerate).
- Merge: resolve pair → upsert relationship rows (feeling for the
  actor-direction; perceived for player-edges per the evidence
  direction); recompute `stage`; diagnostic on unresolved names
  (`merge.affinity.unresolved_pair`).
- Spawn: seed edges from authored world-cast relationships; strangers
  get no row (sparse = stranger).
- Surface: replace the follow-score warmth term (fact-count,
  `scene.ts:430–439`) with stage lookup; add stage lines to the turn
  context's present-NPC state block. **First impressions (decision 43)
  are NOT in this phase** — they need the perception/encounter machinery;
  flat-start ships first, the seed mechanism lands with phase 2.

**T7. `witnessed_by` stamping (interim semantics).**
Merge step 5: stamp each inserted fact with the participant ids
**co-located with the player** at insert time. Coarse — perception
(phase 2) refines the semantics to true witness sets; the column and
write path are what phase 6 needs to exist *now*. Same stamp on
episodes. Document the interim semantics in `memory.md` when shipped.

**T8. `lastInteractedTurn` runtime tracking.**
`session.runtime` + merge writes: intent-detected targets
(`intent.ts` results), companion-authored speaker turns. Feed
`turnsSinceInteraction` at the existing call site (`pipeline.ts:452`,
currently `{}`). This activates a follow-score term that has never
fired — expect follow behavior to change; eyeball it in play before
tuning constants.

**T9. Schedule day-mask + seeded jitter.**
`contracts/world/profile.ts`: optional `days?: number[]` on schedule
entries (old rows parse unchanged); `scheduleEntryAt`
(`contracts/world/profile.ts:472`) gains a day argument from the time
context. Jitter: FNV-1a over `participantId::dayIndex` →
±`SCHEDULE_JITTER_MINUTES`, applied in `scheduleEntryAt` callers
(merge `~:944`). Time-context helper (`minuteOfDay`, `dayOfWeek`,
`daylightBand`) lands here — one module, consumed by schedules now,
perception darkness in phase 2.

### P2 — Authoring & UI

**T10. Forge map-field suggestions + editors.**
World forge location agent suggests `scale`, `area`, link
`travelMinutes` (`server/authoring/world-forge.ts` locations/links
sections — same grounding discipline as link validation); cast agent
suggests `tier` and `startWorldLocationId` (it already places items;
same pattern). Map/cast editors expose all of it; world editor gains
the player-start picker. Defaults everywhere — an untouched world
behaves exactly as today.

**T11. Clock-delta UI.**
Session header: show per-turn time advance with cause ("+15m — walked
downtown"; "+20m — shower"). The merge already knows the resolution
path; persist `{ minutes, cause }` on the turn row (or in
`agent_results`) and render it. Decision 48.

**T12. Relationships panel (stages only).**
Session UI: per-NPC stage toward the player + perceived stage ("she
seems fond of you / she thinks you dislike her"). Read-only v1.
Decision 48.

## Testing (per testing.md conventions)

- Pure: resolution-order matrix (travel/action/estimate × max rule);
  `matchAction` aliasing; stage boundaries; affinity clamp + upsert
  direction semantics (feeling vs perceived); jitter determinism (same
  participant+day ⇒ same offset); day-mask matching incl. wrap-past-
  midnight windows; time-context derivation from `calendarStart`.
- Degradation (assert fallback AND diagnostic): unknown meterEffect
  meter id; unresolved affinity pair; schedule with unknown location
  (existing diagnostic, new day-mask path).
- Integration: spawn copies new link fields + seeds relationships;
  fact insert carries `witnessed_by`; a turn with travel + registered
  action advances max(...); zero-config world reproduces today's clock
  behavior exactly (the no-regression gate).

## Out of scope for this phase (resist the temptation)

Presence/perception (phase 2 — including first-impression seeding and
encounter semantics), proximity tiers, drives/traversal (the new
`travel_minutes` data is consumed by phase 4), world-tick, affordance
*behavior* (the column ships empty; the forge fills it in phase 5),
access-control *enforcement* (column ships in T1; enforcement is
phase 4 with movement), `fact_knowers`/`character_episodes` tables.

## Docs to update when shipping

`turn-engine.md` (merge step 4, new simulant field, constants),
`contracts.md` (two new registries, profile fields), `database.md`
(columns + table), `memory.md` (witnessed_by interim semantics),
`authoring.md` (forge suggestions), `ui.md` (clock delta, relationships
panel).
