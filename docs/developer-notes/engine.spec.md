# Successor world engine — technical specification

Status: **draft 2026-07-16**

Companion to [engine.plan.md](engine.plan.md). Read the plan for sequencing, costs,
experiments, and migration gates. This document defines the intended contracts and
invariants of the successor. It is deliberately independent of the deprecated session
engine's object model.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. Open product rulings are explicitly marked; an implementation must not hide
one inside prompt wording or a parser heuristic.


## Where the contract lives

The contract is split across six files (2026-07-21). Section numbering is GLOBAL and
stable — cite sections as "engine.spec §N" exactly as before; this index maps every
section to its file. New sections join the file that owns their range; a genuinely new
domain gets a new `engine.spec.<cluster>.md` and a row here.

| §§ | File | Contents |
| --- | --- | --- |
| 1–12 | [engine.spec.kernel.md](engine.spec.kernel.md) | Scope, terms, invariants, components, identity, story time and determinism, principals, command/event contracts, persistence, transactions, scheduler |
| 13–18 | [engine.spec.world.md](engine.spec.world.md) | Physical world, access/privacy/consent/entry, commitments and pressure, actions and activities, journeys, engagements and live-scene arbitration |
| 19–24 | [engine.spec.mind.md](engine.spec.mind.md) | NPC policy and deliberation (incl. §19.2.1 routine controller), perception, assertions/beliefs/gossip/relationships, NarrativeCut, narrator and effects, RAG and memory |
| 25–26 | [engine.spec.bodies-materials.md](engine.spec.bodies-materials.md) | Bodies, meters, conditions, modifiers, rhythms; materials, inventory, consumption, item condition, households, lots, means, restock |
| 27–28 | [engine.spec.lod.md](engine.spec.lod.md) | Simulation LOD (levels, promotion, demotion, per-actor ledger, below-event alarm law, population cohorts), inference LOD and model budget |
| 29–40 | [engine.spec.operations.md](engine.spec.operations.md) | Retakes/branches/replay, API and package boundaries, numeric contract, resilience, security, observability, testing, migration, experiments, **§39 product rulings**, conformance checklist |

Owner rulings continue to be recorded in **§39** (engine.spec.operations.md).
