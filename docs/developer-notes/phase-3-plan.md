# Phase 3 plan — multi-character continuation (skeleton)

Status: **draft** — placeholder, do not start. Phase 2
([phase-2-plan.md](phase-2-plan.md)) is in flight; per the program rule
(later phases get their plan authored at phase start), this file is only
the nesting anchor for the `.phase3.md` docs below and a parking spot
for scope notes until phase 2 ships. Author the real plan from the specs
when phase 3 begins.

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

Whether phase 3 takes only presence & perception or bites off more is a
phase-start decision.

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

Restated from the phase-3 doc set per the repo rule. The specs' gap
sections carry inline rulings, so only genuinely undecided items appear
here — follow the links for detail; remove entries when resolved:

- **Phase-3 scope.** Presence & perception v1 only, or more of the
  build order (§Candidate scope above) — decided at phase start.
- **Tier-drift engagement signal.** Does `runtime.lastInteractedTurn`
  suffice as the drift history, or does drift need a broader
  `lastEngagedTurn`?
  [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md)
  (§Design: tiers).
- **Player-unperceived events** (hidden acts against the player).
  Designed alongside perception, ships v2 — the POV and fairness shape
  still needs a dedicated think.
  [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  (§Gaps & opportunities).
- **Narrator-invented NPC actions are checked only post-hoc.** Pairwise
  NPC awareness lines are the proposed mitigation — measure before
  adding machinery.
  [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  (§Gaps & opportunities).
- **Comms scope.** Group calls, voicemail content, persistent text
  history (the first thing players will ask for) — all deferred, none
  designed.
  [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md)
  (§Gaps & opportunities).
- **Area path hierarchy.** Separator choice and whether the forge
  suggests nested paths from day one.
  [location-design-spec.phase3.md](location-design-spec.phase3.md)
  (§Area hierarchy, §Open questions).
- **Owner ↔ private-link reconciliation.** Does `private` link access
  derive its owners from the guarded location's owner (proposed), or
  stay independently authored? Rule before phase-4 enforcement builds
  on either. [location-design-spec.phase3.md](location-design-spec.phase3.md)
  (§Ownership).
- **Banded-ambient vocabulary.** Reuse the four daylight bands
  (proposed — one time vocabulary) vs the simpler
  morning/afternoon/evening three the request used.
  [location-design-spec.phase3.md](location-design-spec.phase3.md)
  (§Time-banded ambients).
- **Item-instance ownership shape.** `owner_participant_id` on
  instances, written only at spawn — confirm before the items model
  grows a second provenance mechanism.
  [location-design-spec.phase3.md](location-design-spec.phase3.md)
  (§Ownership).

## Naming note

Cross-phase reference docs carry the suffix of the phase where their
remaining work lives. When phase 3 ships and a phase 4 begins,
re-suffix the surviving docs and fix pointers — `grep -rn
'\.phase3\.md' docs/ src/` finds every link (a few `src/` code comments
point at these files too).
