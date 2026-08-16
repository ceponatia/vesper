# Engine plan — Gate 2: production identity, event kernel, and scheduler

Status: **ADVANCE — closed 2026-07-17.** E2.1–E2.5 shipped in sequence; E2.6 ran the
required proofs (21/21 checks at the full synthetic-month profile — evidence and one
accepted caveat about schedule-time trigger templates going stale under live load in
[finished/engine/engine-gate2-soak.plan.md](../../finished/engine/engine-gate2-soak.plan.md)
§Verdict) and the owner ruled advance. This status permitted Gate 3 design; its build
waited on the ten product rulings the owner resolved the same day (engine.spec §39).

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](../../roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](../../engine.spec.md) §-index.

## Gate 2 — production identity, event kernel, and scheduler

Rough effort: **15–30 developer-days** after Gate 1.

### Deliverables

- WorldType, World, WorldBranch, CharacterTemplate, WorldCharacter, PlayerCharacter,
  Location, Item, Action, Commitment, and Event identities;
- a branch-scoped command log, event log, version, idempotency record, and outbox;
- deterministic ordering and seeded random streams;
- schema-versioned event envelopes and upcasters;
- synchronous core projections and asynchronous rebuildable projections;
- a durable next-trigger queue;
- analytical integration between triggers;
- fork, replay, snapshot, projection hash, and audit tools;
- branch-level serialization without holding a database lock across a model call;
- feature flags that assign a test world to the successor.

### Gate 2 build order

Gate 2 is split into stable implementation targets. The IDs describe dependency order;
they are not GitHub pull-request numbers.

1. **E2.1 — production identity and envelopes.** Promote the Gate 1 identifiers,
   integer causal primitives, principal taxonomy, command envelopes, event envelopes,
   and exhaustive results into reusable contracts. Migrate `transfer_item` onto them
   without changing its outcome. No database tables yet.
2. **E2.2 — durable branch transaction.** Add `sim_worlds`, `sim_branches`,
   `sim_commands`, `sim_events`, and the minimum typed item-holding projection. Serialize
   accepted work per branch; persist idempotent results and prove crash atomicity.
3. **E2.3 — outbox and rebuildable consumers.** Add transactional outbox rows,
   idempotent consumer checkpoints, one asynchronous projection, retry diagnostics, and
   rebuild-from-zero tooling.
4. **E2.4 — durable scheduler and deterministic draws.** Add trigger identity,
   uniqueness, claim/retry semantics, stable simultaneous ordering, named random streams,
   and one trigger that resolves through the same kernel transaction.
5. **E2.5 — forks, snapshots, and audit.** Add branch ancestry, fork boundaries,
   checksummed snapshots, projection comparison, and causal explanation queries.
6. **E2.6 — Gate 2 soak and verdict.** Run the synthetic-month, partition-invariance,
   retry, crash, queue-growth, replay-hash, and diagnostics proofs. Record advance,
   revise, hold, or stop before movement or live-scene work begins.

Each target stays reviewable on its own. E2.2 consumes E2.1; E2.3 and E2.4 consume the
E2.2 transaction; E2.5 consumes the stable event store; E2.6 closes the gate.

### Required proofs

- a large time skip and equivalent partitions produce the same material outcomes;
- a scheduler retry cannot duplicate an event;
- a stale command fails with a structured conflict;
- a crashed outbox consumer resumes idempotently;
- every path-dependent derived decision records the value or inputs and derivation
  version that caused history;
- rebuild from events matches live projections.

### Gate 2 exit

The kernel can run for a simulated month of synthetic commands and triggers with stable
hashes, bounded queue growth, no duplicate outcomes, and useful diagnostics.

