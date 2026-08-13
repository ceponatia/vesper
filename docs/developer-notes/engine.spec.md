# Successor world engine — technical specification

Status: **living contract reference for the shipped engine** — the authoritative § index
for the six `engine.spec.<cluster>.md` files.

Companion to [engine.plan.md](engine.plan.md), which owns the closed gate history and the
goals the build was judged against. This set defines the contracts and invariants of the
engine that is now the world authority for successor chats; it owes nothing to the
retired session model, whose code and tables were deleted at rollout R6 (2026-07-22).

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. The one product ruling still open is marked as such in §39; an implementation
must not hide it inside prompt wording or a parser heuristic.

## Where the contract lives

The contract is split across six files (2026-07-21). Section numbering is GLOBAL and
stable — cite sections as "engine.spec §N" exactly as before, the way `src/contracts/`
and `packages/simulation-core/src/lib/` already do; this index maps every section to its file. A new
section joins the file that owns its range; a genuinely new domain gets a new
`engine.spec.<cluster>.md` and an entry here.

- **§1–§12 — [engine.spec.kernel.md](engine.spec.kernel.md).** Scope, terms, invariants,
  components, identity, story time and determinism, principals, command and event
  contracts, persistence, transactions, scheduler.
- **§13–§18 — [engine.spec.world.md](engine.spec.world.md).** Physical world; access,
  privacy, consent, and entry; commitments and pressure; actions and activities;
  journeys; engagements and live-scene arbitration.
- **§19–§24 — [engine.spec.mind.md](engine.spec.mind.md).** NPC policy and deliberation
  (including §19.2.1, the routine controller); perception; assertions, beliefs, gossip,
  and relationships; NarrativeCut; narrator and effects; RAG and memory.
- **§25–§26 — [engine.spec.bodies-materials.md](engine.spec.bodies-materials.md).**
  Bodies, meters, conditions, modifiers, rhythms; materials, inventory, consumption, item
  condition, households, lots, means, restock.
- **§27–§28 — [engine.spec.lod.md](engine.spec.lod.md).** Simulation LOD (levels,
  promotion, demotion, per-actor ledger, below-event alarm law, population cohorts);
  inference LOD and model budget.
- **§29–§40 — [engine.spec.operations.md](engine.spec.operations.md).** Retakes,
  branches, and replay; API and package boundaries; the numeric contract; resilience;
  security; observability; testing; migration; experiments; **§39 product rulings**;
  the conformance checklist.

Owner rulings are recorded in **§39** (engine.spec.operations.md) and nowhere else.
