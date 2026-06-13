# Phase 2 plan — review findings + pulled-forward low-hanging fruit

Status: **completed** (2026-06-12) — all twelve tasks landed, including
the T6 tier-badge and T12 riders; migration `0003_wide_champions.sql`
applied; gates at completion: typecheck + lint clean, 749 pure + 81
integration tests green. No leftovers moved forward; post-ship fixes
and small improvements are tracked in
[followups.phase2.md](followups.phase2.md).

Second working phase, following [phase-1-plan.md](phase-1-plan.md) and
[multi-character-phase-1-plan.md](multi-character-phase-1-plan.md).
**Not** the multi-character build-order phase 2 (presence & perception —
that phase gets its own plan at phase start, per the overview). This plan
has two sources:

1. **Findings from the 2026-06-12 codebase review** — gaps left by the
   phase-1 work (one functional miss, one resilience violation, a set of
   untested behaviors).
2. **Low-hanging fruit pulled forward from the unimplemented specs** —
   items that are self-contained, need none of the heavy phase-2+
   machinery (perception channels, proximity tiers, drives, world-tick),
   and whose groundwork (schema fields, registries, constants) phase 1
   already shipped. Each donor spec carries a status note pointing here,
   so later spec phases know this work is already done.

## Review findings (2026-06-12)

Build health at review time: `pnpm typecheck` clean, 592/592 pure tests
green. Phase-1 scope (both plans) landed almost completely; resilience
patterns hold across the new code; no TODO/FIXME debt. The gaps:

| # | Finding | Where |
| --- | --- | --- |
| 1 | Affinity seeding at spawn never happens — `multi-character-phase-1-plan.md` T6 included "seed edges from authored world-cast relationships", but no authored-relationship structure exists anywhere (not on `world_cast`, not in contracts), `spawn.ts` writes no `participant_relationships` rows, and `stageMidpoint()` (`contracts/relationships/stages.ts`) is dead code. Every relationship starts at stranger/0. | `spawn.ts`, `schema.ts:157–169` |
| 2 | Affinity decay absent — the defaults doc specifies 1 pt/in-game-week toward 0, never crossing a stage boundary alone; no decay logic exists in `merge.ts`. | `merge.ts` |
| 3 | Resilience violation: `loadDefaultOutfit()` swallows DB errors with a bare `catch { return [] }` — degrades without a diagnostic, against resilience.md's "everything that degrades records a diagnostic". | `src/server/images/avatar.ts:~95–121` |
| 4 | Implemented-but-untested behaviors: `affinity_stage` event writes, `witnessed_by` stamping, `lastInteractedTurn` tracking, the chain-cap directive, player-turn-only action matching, `buildRelationshipBlock`, `reconcileSceneGen`, plus the promised zero-config no-regression integration test. | see T4 |
| 5 | Hygiene: `DEFAULT_INTER_AREA_TRAVEL_MINUTES` lives in `api/worlds.ts` while sibling travel constants live in `engine/constants.ts`; scale/tier select options are inline literals in `world-editor.tsx` instead of derived from the contract enums; `NARRATOR_OPTIONS` is a component literal in `world-tab.tsx`. | T5 |

Verified-fine during review (no action): `detailOf()` sibling merge,
`parseClockDelta` rejecting 0 ("never +0m" is by design),
`playerStartLocationName` draft-merge wiring, `reconcileSceneGen`
mutating the bundle before the response, the narrator-toggle PATCH path.

## Task plan

### P0 — Close out phase 1 (findings)

**T1. Authored relationships + spawn seeding.**
Closes finding 1 (the multi-character-phase-1-plan T6 leftover). The
seeding side was specced; the authoring side never existed — both land
here.

- Contract + column: `relationships` on world cast entries
  (`world_cast.relationships` jsonb, default `[]`):
  `[{ toward: string /* cast name or "player" */, stage: RelationshipStage }]`.
  Draft/world-detail client schemas and `world-detail-to-draft` carry it.
- Editor: cast tab gains a relationships row (toward + stage selects —
  stages, never numbers, same as everywhere).
- Forge suggestions are split out as T12 (ruled 2026-06-12: a rider in
  this phase, sequenced after T1 ships).
- Spawn: seed directional `participant_relationships` rows at
  `stageMidpoint(stage)`. Strangers get no row (sparse = stranger).
- Player edges (ruled 2026-06-12): seed from what the authored text
  establishes. A deterministic keyword pass over the relationship
  entry and the cast member's concept/bio classifies the bond —
  mutual-knowledge kinds (family/sibling/partner/friend/coworker) ⇒
  `perceived` mirrors the feeling midpoint; first-meeting/stranger
  phrasing ⇒ no row at all; indeterminate ⇒ mirror the midpoint (the
  safe default). Pure, tested keyword table; the richer LLM read of
  narrative history is the forge rider's job (T12).
- Reverse edges: an authored A→B also seeds B→A at the same midpoint
  unless that direction is itself authored (explicit always wins) —
  unrequited relationships are authored by writing both sides.
- Forward-compatibility (phase 3): an existing row at first encounter
  suppresses the future first-impression seed ("explicit authored
  relationships always override the seed" — defaults doc), so no
  provenance field is needed. Build seeding as a reusable helper: the
  emergent-cast conceptNote seeding (dynamic-character-introduction,
  later) takes the same path.
- Tests: pure (midpoint seeding, direction semantics, sparse-stranger);
  integration (spawn from a world with authored relationships produces
  the rows; relationships endpoint surfaces them turn 0).

**T2. Affinity decay.**
Closes finding 2, per the
[defaults doc](multi-character-v1-defaults.phase3.md): 1 point per in-game
week toward 0; decay alone never crosses a stage boundary (stops at the
edge); only events demote a stage. Apply in the merge from elapsed
in-game time (the clock already advances deterministically). Per the
logging contract (a constant without telemetry can never graduate),
log an `events` row when decay stops at a stage boundary — that is the
evidence for the "relationships fossilizing" revisit trigger; stage
transitions from events keep logging as today. Note the cast-tiers
spec's looser wording ("drift toward a per-stage baseline") is
implemented as the defaults doc's concrete rule — toward 0 with a
boundary stop. Tests: pure decay math (rate, boundary stop, direction
for negative values), boundary-stop event row, and a
no-decay-within-a-day case.

**T3. Avatar outfit lookup diagnostic.**
Closes finding 3. Thread the diagnostic sink into `loadDefaultOutfit()`
and emit `images.avatar.outfit_load_failed` (warn) in the catch; the
degraded no-outfit prompt behavior stays. Degradation test asserts
fallback and code, per testing.md.

**T4. Test-gap closure.**
Closes finding 4. One pass, mostly pure tests against existing code:

- `affinity_stage` event rows written on stage transition
  (`applyTurnResults`) — integration.
- `witnessed_by` stamped on facts and episodes (co-location semantics).
- `lastInteractedTurn` written from all three sources: intent targets,
  companion speaker, co-located name mentions.
- Chain-cap narrator directive renders at ≥`MAX_CHAINED_ACTIONS`
  (`pipeline.ts`) and `matchActions` runs only on player turns.
- `buildRelationshipBlock` rendering (stage lines, perceived lines).
- `reconcileSceneGen`: orphaned "generating" with no live job → failed.
- The zero-config no-regression integration test promised by
  multi-character-phase-1-plan: a world with none of the new fields set
  reproduces pre-phase-1 clock/affinity behavior exactly.
- `world-from-draft.ts` unit tests (generation cap, partial-failure
  stub policy, item reuse by name) — currently covered only via route
  integration tests.

**T5. Constants & options hygiene.**
Closes finding 5. Move `DEFAULT_INTER_AREA_TRAVEL_MINUTES` to
`engine/constants.ts` beside its siblings (api imports it). Derive the
world-editor scale/tier select options from the contract enums
(`worldLocationScaleSchema` / tier schema), not inline literals.
Narrator models (ruled 2026-06-12): replace the world-tab toggle with a
**dropdown** rendered from a shared pure `{ id, label }` list (in
`src/lib`/contracts so both the client and the server's
`narrativeModelId` resolver import it), and add the next curated
options (e.g. GLM-5.1). Shape the dropdown to render an arbitrary
list: the planned BYOK feature (user-supplied OpenRouter key ⇒
live-queried model catalog, untested-model caveat shown) later
replaces the static list as the source — which also gives dev easy
model hot-swapping.

### P1 — Pulled forward from specs (low-hanging fruit)

**T6. Major-tier soft cap diagnostic.**
From [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
(decision 46). `MAJOR_TIER_SOFT_CAP = 6` in `engine/constants.ts`;
warn-never-block: world editor shows a notice when authored majors
exceed the cap; spawn emits a diagnostic. Pure test on the count rule.
Optional rider (spec suggestion): tier badges on the cast-tab cards —
the session UI surfacing tier distribution.

**T7. Declared rest.**
From [time-and-travel-spec.phase3.md](time-and-travel-spec.phase3.md) (decision 38) —
the biggest unmodeled time jump in play; everything it needs (action
registry, time-context helper, clock resolution) shipped in phase 1.

- `REST_CLAMP_MINUTES = 960` (defaults doc); normal turns keep the
  480 clamp.
- Detection: rest/sleep/wait-until intents ("I sleep", "I wait until
  morning") resolve to a declared-rest action with a schedule-aware
  endpoint — explicit wake time, or "morning" = next dawn band from the
  time-context helper.
- Meters drift across the span (existing per-hour drift); registered
  sleep/nap meter effects still apply.
- NPC schedules apply at the post-rest clock exactly as today —
  intermediate slots across the span are skipped, not simulated; the
  world-tick (offscreen-simulation phase) is what fills that gap.
- World-tick batching across the span is **reserved** — no world-tick
  exists yet; when offscreen-simulation ships, one batched tick per
  rest (decision 38). Leave the seam, build nothing.
- Tests: clamp, schedule-aware endpoint math (incl. wrap past
  midnight), drift application, ordinary turns unaffected.

**T8. Link access enforcement — player-side basics.**
From [npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) ("the biggest hole in
this spec", decision 32). The schema (`access`, `doorItemId`) shipped
in phase 1 and is copied to session links; nothing reads it. NPC
pathing doesn't exist yet, so v1 here is player-side only:

- Access shapes follow the data-model addendum exactly:
  `{ kind: "public" } | { kind: "private", ownerParticipantIds } |
  { kind: "locked", keyItemId? } | { kind: "timeWindow", start, end }`.
- `locked` blocks the player's move: drop with
  `merge.movement.access_denied` (code recorded in the data-model
  diagnostics list), and a brief-level note so the narration plays the
  locked door instead of teleporting through it. `keyItemId` stays
  reserved — v1 blocks even a key-holder; keys/lockpicking are later
  content and slot into this same check.
- `timeWindow` checks the time-context helper.
- `doorItemId`: a bound door item whose state is closed+locked counts
  as locked (item state drives traversability — the binding the spec
  calls "cheap to add with the access model, painful after").
- `private` has no player effect yet (it discourages *NPC pathing*,
  which arrives with drives).
- Build the check as one pure shared helper (link + time + mover ⇒
  passable / blocked-with-reason) so phase-4 NPC traversal reuses it
  instead of growing a second rule.
- Tests: each access kind × allowed/blocked, diagnostic codes, and the
  degraded default (no access field = today's behavior).

**T9. Arrival/departure staging in the brief.**
From [npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) ("the whole feature's
visible payoff"). Schedule moves already relocate off-screen NPCs
between turns; nothing tells the narrator. Add arrivals/departures to
`NextTurnBrief` (contracts change, defaulted, parseOr-safe): when a
tick moves an NPC into or out of the player's location, the next brief
carries "Mara arrived from the market" / "Tom left toward the docks".
Renders motivated movement as staging instead of teleportation — and
gives the future drives system its display channel for free. V1
assumes co-located ⇒ perceived (the same interim rule as
`witnessed_by`); the presence phase's witness machinery gates these
lines when it ships (noted in that spec). Tests: brief field
population from schedule ticks; absent for moves elsewhere.

**T10. Location scale framing line.**
From [proximity-spec.phase3.md](proximity-spec.phase3.md) (the prose half of decision
18). `scale` is authored, stored, and spawn-copied since phase 1 but
never read by prompt assembly. Add the one framing line to the scene
block — strictly physical size, e.g. "An intimate space; a few steps
span it." No staging language: the proximity phase's entry-default for
`intimate`/`room` is `apart`, so a line like "people here are close by
default" would assert tier state the engine doesn't track and the
future mechanics would contradict. The mechanical half (tier defaults,
conversation gating) stays with the proximity phase, reading the same
value and extending the same line. Test: prompt structural test per
scale, default `room` renders nothing surprising.

**T11. Identity-conditioned ranges.**
From
[dynamic-character-introduction-spec.phase3.md](dynamic-character-introduction-spec.phase3.md)
phase 0 — explicitly "shippable alone, before any of the below". Fixes
today's real failure mode: an unset core visual gets a uniform pick
from the *full* vocabulary (a character described as Latina can roll
platinum-blonde hair). Scope exactly as specced:

- Registry edits: `identity.heritage` (free text) + `identityAnchor:
  true` flags on the identity attributes. No migration.
- Attribute section gains `ranges: [{ id, plausible: string[] }]`;
  grounding drops unknown ids / out-of-vocabulary members
  (`forge.character.attributes.invalid_range_member`), emptied ranges
  drop entirely.
- `fillCoreVisualDefaults` keeps its FNV-1a mechanism but draws from
  the surviving range; no range ⇒ today's full-vocabulary pick + a
  diagnostic noting the unconstrained fall-through.
- Guardrails verbatim in `ATTRIBUTES_SYSTEM`: anchors constrain
  physical attributes only; explicit text beats ranges; weak signal ⇒
  wide range or none.
- Tests: the spec's pure-test list (range grounding, pick ∈ range, seed
  determinism, fall-through diagnostic, definite-beats-range).

**T12. Forge relationship suggestions (rider after T1).**
Ruled 2026-06-12: in this phase, sequenced after T1 ships. The cast
agent reads the premise, cast concepts, and relationship-category lore
and suggests relationship entries (`toward` + stage, player and
NPC↔NPC edges alike), wording each entry so T1's bond classifier can
seed `perceived` correctly (name the kind: "her brother", "a coworker",
"they've never met"). Same grounding discipline as `startLocationName`
— unresolved names drop with a diagnostic. Tests: grounding,
suggested-entry parse, a generated world spawns with wired edges.

## Suggested sequencing

1. **T3** (one function) → **T2** (small, self-contained merge rule) →
   **T4** (locks in everything phase 1 built before new work moves the
   floor).
2. **T1** (largest P0 — schema + editor + spawn; do after T4 so the new
   integration tests exist to extend). **T12** follows once T1 ships.
3. **T6** (trivial) → **T10** (one prompt line) → **T9** → **T8** →
   **T7** (the three engine items, smallest first).
4. **T11** independent — can run parallel to any of the above (forge
   code only).
5. **T5** rides along wherever the touched files overlap.

Docs rule applies throughout (CLAUDE.md): each task updates its system
doc in the same change — `turn-engine.md` (T2, T7, T8, T9),
`contracts.md` (T1, T9, T11), `database.md` (T1), `prompts.md` (T9,
T10, T11), `authoring.md` (T1, T11, T12), `ui.md` (T1, T5, T6),
`images.md`
(T3), `resilience.md` untouched (T3 is conformance, not a new rule).

## Out of scope (resist the temptation)

Everything needing presence/perception machinery: channels, awareness
blocks, salience, witness refinement, comms, **first impressions**
(decision 43's "full model in v1" lands with the presence phase — the
seed formula in the defaults doc needs encounter semantics that don't
exist yet). Proximity tiers/engagement/locks (T10 ships only the
framing line). Movement drives, traversal, approach scores, the
schedule-conflict follow term. World-tick, LOD, backfill.
`fact_knowers` / `character_episodes` (phase 6). Emergent cast phases
1–3 (T11 is phase 0 only). Norm-breach → affinity wiring (wants witness
sets done right). Faction tags, tier drift, container capacity
(phase-1-plan T13, still deferred).

## Open questions

None at the moment — the three initial questions (player-edge seed
values, forge-suggestion timing, narrator-options home) were resolved
2026-06-12; the rulings are recorded inline in T1, T12, and T5.
