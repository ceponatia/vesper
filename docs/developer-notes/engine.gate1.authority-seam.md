# Engine plan — Gate 1: minimum authority seam

Status: **ADVANCE — closed 2026-07-16.** The one-command item-transfer seam shipped and
met every acceptance criterion below; the shipped record is
[finished/engine/engine-gate1-item-transfer.plan.md](finished/engine/engine-gate1-item-transfer.plan.md).
This status permitted Gate 2.

Part of the [engine.plan.md](engine.plan.md) gate set (split 2026-07-21; one doc per
gate — see the hub's gate index). Sequencing and current status live in
[roadmap.md](roadmap.md) and the hub; normative contracts live in the
[engine.spec.md](engine.spec.md) §-index.

## Gate 1 — minimum authority seam

Rough effort: **5–10 developer-days**.

This is the cheapest test of the successor architecture. Build only:

- one world and one branch with stable identity and an optimistic version;
- one stable item and two containers or locations;
- one transfer_item command;
- one validator, one domain event, and one synchronous projection;
- one observer and one non-observer;
- a minimal perspective view consumed by the existing narrator;
- replay and presentation-only rerender.

Do not add a scheduler, physiology, illness, economy, autonomous NPC, procedural
generation, or a new model leg.

### Gate 1 acceptance

- an invalid transfer emits no event and changes no projection;
- duplicate idempotency keys produce one outcome;
- replay produces the same projection hash;
- the observer may recall the transfer and the non-observer may not;
- rerender cannot leave a discarded transfer in state or memory;
- the narrator cannot invent a second transfer or expose it to the wrong viewpoint;
- added p95 latency remains inside the predeclared budget;
- the implementation is small enough to delete if it fails.

Stop or redesign if a one-command seam cannot remain understandable, replayable, and
faster than an LLM-mediated equivalent.

