# Multi-character systems — spec overview

The multi-character brainstorm
([multi-character-presence-and-movement-brainstorm.phase3.md](multi-character-presence-and-movement-brainstorm.phase3.md),
decisions in
[multi-character-presence-and-movement-decisions.phase3.md](multi-character-presence-and-movement-decisions.phase3.md))
is split into seven system specs. Each follows the house pattern: the spec
holds the design; the brainstorm holds the alternatives weighed; every
spec carries a **Gaps & opportunities** section listing what the design
does not yet cover — read those before calling any spec "done".

## The specs

| Spec | System | Depends on |
| --- | --- | --- |
| [time-and-travel-spec.phase3.md](time-and-travel-spec.phase3.md) | Link travel minutes, areas, action-duration registry, turn-time resolution | — (foundation) |
| [cast-tiers-and-affinity-spec.phase3.md](cast-tiers-and-affinity-spec.phase3.md) | major/minor/extra tiers, affinity edges + stages | — (foundation) |
| [presence-and-perception-spec.phase3.md](presence-and-perception-spec.phase3.md) | Presence channels, symmetric perception, comms, salience | time (clock), tiers (narration depth) |
| [proximity-spec.phase3.md](proximity-spec.phase3.md) | Pair proximity tiers, location scale, engagement, contested checks | presence/perception, affinity |
| [npc-movement-spec.phase3.md](npc-movement-spec.phase3.md) | Movement drives, traversal, follow/approach | time-and-travel, affinity, presence |
| [offscreen-simulation-spec.phase3.md](offscreen-simulation-spec.phase3.md) | LOD tiers, world-tick agent, affordances, lazy backfill | movement, tiers, time |
| [character-memory-spec.phase3.md](character-memory-spec.phase3.md) | Knowledge ledger, per-character episodes, perspective memories | perception (witness sets), offscreen sim (event sources) |

## Implementation references

- [multi-character-data-model.phase3.md](multi-character-data-model.phase3.md) — every
  table/column/registry/agent-field/constant the specs require, verified
  against code 2026-06-11.
- [multi-character-phase-1-plan.md](multi-character-phase-1-plan.md) —
  the foundations task plan (T1–T12), shipped 2026-06-12 (see its
  completion note for the leftovers). Later phases get plans authored at
  phase start.
- [phase-2-plan.md](phase-2-plan.md) — the second *working* phase
  (review findings + low-hanging items pulled forward from these specs:
  seeding/decay/soft-cap, declared rest, player-side link access,
  arrivals in the brief, the scale framing line, identity-conditioned
  ranges). Not the build-order phase 2 below — presence & perception
  still gets its own plan. Each donor spec carries a status note saying
  what phase-2-plan already covers.
- [multi-character-v1-defaults.phase3.md](multi-character-v1-defaults.phase3.md) —
  every tuning constant and provisional policy with its v1 value and
  revisit trigger (witness matrix, stage boundaries, darkness model,
  budgets, logging contract).

## Suggested build order

Each phase is shippable on its own and observably improves play:

1. **Foundations** — time-and-travel (schema fields + duration registry) and
   cast-tiers-and-affinity (tier enum + affinity table). Also start the
   write-only `witnessed_by` stamping immediately (decision 3) — it needs
   no other system and every later phase wants the history.
2. **Presence & perception v1** — sight + comms channels, attention ×
   salience, awareness blocks, the two new continuity violation classes.
   This alone kills the two worst current behaviors (absent characters in
   narration; the kitchen-sink omniscience bug).
3. **Proximity** — tiers, scale, engagement, contested checks. Unlocks the
   intimacy/staging fidelity and the entwined movement lock.
4. **Movement** — drives, traversal, follow/approach upgrades. The map
   starts feeling inhabited even before off-screen inference exists
   (schedule + needs drives are deterministic).
5. **Off-screen simulation** — world-tick, affordances, backfill. The
   world visibly moves while the player isn't looking.
6. **Character memory** — ledger + per-character episodes. The deepest
   change and the one that most rewards everything before it (witness
   sets, off-screen events, comms all become memory sources).

## Cross-cutting gaps — all resolved 2026-06-11

The spec-gap review (decisions 19–48 in the
[decisions doc](multi-character-presence-and-movement-decisions.phase3.md))
resolved the items below; each spec carries its rulings inline:

- **Link access control**: ships in v1 of movement — schema + basic
  enforcement (`public | private | locked | timeWindow` + door-item
  binding).
- **Belief vs truth**: `canon` flag on facts; knowledge sticks to fact
  versions (stale beliefs are a feature — dramatic irony by design).
- **Environmental senses**: darkness + condition `senseEffects` in
  perception v1.
- **Player-facing UI**: all four surfaces ship with their systems —
  clock deltas, relationships panel (stages), texts/message history,
  Turn Inspector off-screen feed. A composite ui.md pass still pending.

New design elements adopted during the review (not in the original
brainstorm): **perceived affinity** (NPC-owned belief about the player's
feelings replaces the player→NPC edge), **per-character norm stances**,
**first impressions seeding** (full model, guardrailed), planned
**algorithmic tier drift**, and the **starting-locations** fix
(decision 47).
