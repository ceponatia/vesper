# Phase 3 plan — presence & perception v1

Status: **completed** (2026-06-13). Presence & perception v1 shipped —
all waves landed (W0 contracts + T1 merge/witness+comms, T2 pre-turn
prompt blocks, T3 agent prompts, T4 integration); gates at completion:
typecheck + lint clean, 937 pure + 89 integration tests green; no DB
migration (all state is JSONB). System documented in
[../perception.md](../perception.md). Leftovers all deferred by design to
phase 4+ (full sound channel, NPC-initiated comms + escalation, per-pair
proximity tracking / engagement / movement lock / contested transitions,
banded ambient light, player-unperceived hidden acts v2) — tracked in
[phase-3-to-4.md](phase-3-to-4.md). Phases 1–2
([phase-2-plan.md](phase-2-plan.md)) shipped earlier.

## Candidate scope (decide at authoring time)

Build order from
[multi-character-overview.phase3.md](multi-character-overview.phase3.md):

1. **Presence & perception v1** — the likely core of this phase:
   channels, attention × salience, awareness blocks, witness-set
   refinement of `witnessed_by`, the two new continuity violation
   classes, comms v1, darkness. **First impressions** (decision 43)
   land here — they were deliberately excluded from phases 1–2 because
   they need the encounter machinery.
2. Then, per build order: proximity → movement (drives/traversal) →
   off-screen simulation → character memory. Emergent cast phases 1–3
   slot in after their dependencies.

**Settled 2026-06-13: phase 3 is presence & perception v1 only**
(build-order step 2 plus the minimal primitives presence depends on);
proximity, movement, and everything downstream become phase 4+. See
[phase-3-to-4.md](phase-3-to-4.md) for the split. The exact proximity
*primitive* boundary presence needs is the one remaining scope question
below.

## Task plan

Built in dependency waves. Wave 0 is the shared contract substrate; the
three Wave-1 streams are mostly file-disjoint and built in parallel
(merge.ts · scene/narrative/pipeline/intent · agents.ts), then integrated.

**Wave 0 — perception contracts foundation (shipped 2026-06-13).** New
`src/contracts/perception/` (pure, tested): presence channels, attention
derivation, salience + stealth markers, the witness matrix (`perceives`),
darkness (band × ambient.light + condition `senseEffects`), proximity
primitive (tier ladder + scale helpers). Schema extensions: simulant
(per-event salience, `commsEvents`), continuity (violation `kind`),
`SessionRuntime` (`commsLinks`, `pendingComms`), item (`attentionHint`),
condition (`senseEffects`); `MAX_NPC_PAIR_AWARENESS_LINES`. No DB
migration — all runtime state is JSONB.

**T1 (Wave 1A) — merge / post-turn witness + comms.** Compute per-turn
witness sets from attention × salience (the union of perceivers across
the turn's salient events + the player), stamp real `witnessed_by`
(replacing the interim co-location stamp), open/close `runtime.commsLinks`
from `commsEvents`, log perception `events` rows. Diagnostics:
`merge.comms.*`, `merge.witness.*`.

**T2 (Wave 1B) — pre-turn / prompt.** Channel computation per participant
(sight = co-located & perceivable; comms = active link or comms intent
this turn; else absent); a channel-aware "Who is where" roster; per-NPC
**awareness blocks** (attention + what they will/won't perceive) incl.
≤`MAX_NPC_PAIR_AWARENESS_LINES` pairwise NPC↔NPC lines; darkness woven
into the scene/sensory rules; first-impression **channel fidelity**
(sight ⇒ full, comms ⇒ voice-only); comms intent detection + same-turn
staging + a "Messages & calls" line; the proximity primitive wiring for
the sight channel.

**T3 (Wave 1C) — agent prompts.** Simulant emits per-event `salience`
(default obvious/quiet; lower only with a concealment target) and
`commsEvents`; continuity sets the two violation kinds
(`narrated_absent_character`, `reacted_to_unperceived_event`) with worked
examples and the awareness/roster inputs.

**T4 — integration + tests.** Typecheck/lint clean; pure + integration
tests green; cross-cutting tests (absent enacted ⇒ violation; subtle act
behind an absorbed/back-turned NPC excluded from the witness set;
comms-present character tags dialogue; darkness degrades sight).

Out of scope (→ phase 4, per [phase-3-to-4.md](phase-3-to-4.md)): the
full sound channel (cross-location hearing), NPC-initiated comms +
escalation, per-pair proximity tracking / engagement / movement lock /
contested transitions, banded ambient light, player-unperceived hidden
acts (v2).

## Already done — do not re-plan

- Phase 1 foundations: see the completion note in
  [multi-character-phase-1-plan.md](multi-character-phase-1-plan.md).
- Phase 2 pull-forwards: each spec below carries a dated
  **Implementation status** note listing what
  [phase-2-plan.md](phase-2-plan.md) covers — seeding/decay/soft cap
  (cast-tiers), declared rest (time-and-travel), player-side link
  access + arrival staging (npc-movement), the scale framing line
  (proximity), identity-conditioned ranges (emergent cast phase 0).
  Treat those as done when scoping here.

## The phase-3 doc set

System specs: presence-and-perception, proximity, npc-movement,
offscreen-simulation, character-memory, cast-tiers-and-affinity (its
remainder), time-and-travel (its remainder),
dynamic-character-introduction (phases 1–3), and
location-design (new 2026-06-12 — area path hierarchy, ownership,
time-banded ambients, per-location forge; its early items are cheap
and several of its consumers live in this build order: darkness reads
banded light, access control reconciles with location owners).
Program references riding with this phase: multi-character-overview,
multi-character-data-model, multi-character-v1-defaults, the
presence-and-movement decisions doc, and both brainstorms.

## Notes for phase-start authoring

Carried forward from the 2026-06-12 phase-2 review:

- Arrival/departure brief lines (phase-2 T9) ship under the interim
  co-located ⇒ perceived rule — gate them with witness sets when
  presence lands (noted in the presence spec's status note).
- `runtime.encounteredParticipantIds` semantics change with presence:
  full encounters only — a distant/comms first contact stops counting
  (today it marks on any co-location).
- First impressions apply only to row-less pairs at first full
  encounter: an existing relationship row (authored seed or play
  drift) suppresses the seed — rule fixed in phase-2 T1, no provenance
  field exists or is needed.
- The access check from phase-2 T8 is a pure passability helper —
  phase-4 NPC traversal reuses it (and adds `private` discouragement +
  the wait-at-blocked-schedule rule); `keyItemId` is reserved in the
  access shape for when keys ship.
- Tier drift (cast-tiers, later) wants per-participant engagement
  history — decide whether `runtime.lastInteractedTurn` (phase 1,
  player-targeting semantics) suffices as `lastEngagedTurn` or a
  broader engagement signal is needed.
- The presence/perception design assumes a player POV. Observer
  sessions have no player participant (god-mode orchestrator,
  largely unfleshed — see followups.phase2.md #10), so this phase
  must take a stance for them — probably narrator-omniscient with no
  awareness blocks — rather than inheriting player-POV machinery that
  has nothing to anchor to.

## Open questions

The nine questions raised across the phase-3 doc set were answered
2026-06-13; rulings live in the detail docs:

- **Phase-3 scope** → presence & perception v1 only (§Candidate scope).
- **Tier-drift engagement signal** → deferred (phase 4+)
  ([cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
  §Problem).
- **Player-unperceived events** → ships v2; Vesper keeps full-RPG
  capability
  ([presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  §Gaps & opportunities).
- **Narrator-invented NPC actions** → build pairwise NPC awareness,
  maintained every turn; cross-location scaling defers to phase 5
  ([presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  §Gaps & opportunities).
- **Comms scope** (group calls / voicemail / text history) → tracked in
  [deferred.plan.md](deferred.plan.md).
- **Area path hierarchy / Owner↔private-link / Banded vocabulary /
  Item-instance ownership** → all resolved
  ([location-design-spec.phase3.md](location-design-spec.phase3.md)
  §Rulings).

Phase-start questions, resolved 2026-06-13:

- **Minimal proximity primitives** → phase 3 pulls in the proximity tier
  ladder + scale-derived tier existence + entry defaults (the primitive
  presence's `sight` channel needs); engagement, contested checks, the
  movement lock, and staging stay phase 4
  ([proximity-spec.phase3.md](proximity-spec.phase3.md) status note;
  [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  scope note).
- **NPC-initiated comms** → phase 3 ships the comms channel + player-side
  + pending-messages line; NPC-*initiated* calls/texts defer to phase 4
  ([presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  §Gaps & opportunities).
- **Observer / god-mode sessions** → deferred (omniscient mode is less
  relevant to the romance scope but wanted eventually); tracked in
  [deferred.plan.md](deferred.plan.md).

## Naming note

Cross-phase reference docs carry the suffix of the phase where their
remaining work lives. When phase 3 ships and a phase 4 begins,
re-suffix the surviving docs and fix pointers — `grep -rn
'\.phase3\.md' docs/ src/` finds every link (a few `src/` code comments
point at these files too).
