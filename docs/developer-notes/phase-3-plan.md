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

**Settled 2026-06-13: phase 3 is presence & perception v1 only**
(build-order step 2 plus the minimal primitives presence depends on);
proximity, movement, and everything downstream become phase 4+. See
[phase-3-to-4.md](phase-3-to-4.md) for the split. The exact proximity
*primitive* boundary presence needs is the one remaining scope question
below.

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

Newly surfaced for phase-start (raised 2026-06-13, awaiting ruling):

- **Minimal proximity primitives.** Presence's `sight` channel is gated
  on "perceivable proximity" and references the `distant` tier. With
  proximity deferred to phase 4, does phase 3 pull in just the tier
  ladder + scale-derived tier existence (the primitive presence needs),
  or run a coarse co-located / adjacent / absent model until proximity
  lands?
- **NPC-initiated comms.** Ship the comms *channel* + player-side +
  pending-messages line in phase 3, but defer NPC-*initiated* calls/texts
  (they need the director / world-tick to emit intents) to phase 4?
- **Observer / god-mode sessions.** Presence assumes a player POV;
  observer sessions have none (followups.phase2.md #10). Stance:
  narrator-omniscient, no awareness blocks?

## Naming note

Cross-phase reference docs carry the suffix of the phase where their
remaining work lives. When phase 3 ships and a phase 4 begins,
re-suffix the surviving docs and fix pointers — `grep -rn
'\.phase3\.md' docs/ src/` finds every link (a few `src/` code comments
point at these files too).
