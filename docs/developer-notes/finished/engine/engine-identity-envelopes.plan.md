# World-engine identity and causal envelopes

Status: shipped — 2026-07-16 (squash commit [`f8c7040b`](https://github.com/ceponatia/vesper/commit/f8c7040bfebba823a95bfa211aa00ffb686733f1))

Parent: [engine.plan.md](../../finished/engine/engine.plan.md) · Contract: [engine.spec.md](../../engine.spec.md)

## Stable target

**E2.1 — production identity and envelopes**, the first Gate 2 target. This promotes the
successful Gate 1 command/event seam into contracts that later persistence, scheduler,
branching, projection, and narrative packages can share.

## Purpose

Gate 1 proved one item-transfer flow, but its identifiers and envelopes were declared in
the command-family file. Building database authority on those local shapes would let each
new command invent a slightly different identity, principal, time, ordering, or result
contract. E2.1 establishes those primitives before table design makes mistakes expensive.

## Scope

- branded, opaque IDs for the identity catalog in `engine.spec.md` §5 plus causal,
  observation, outbox, snapshot, and NarrativeCut records;
- safe nonnegative integer story seconds and branch versions, and positive safe branch
  sequences and schema versions;
- the complete principal-kind vocabulary from §7;
- strict factories for typed command and event envelopes;
- one shared accepted/rejected/conflict result contract;
- deterministic set ordering for controller grants and event reference sets;
- strict ISO wall-clock metadata that remains operational and never drives resolution;
- migration of `transfer_item`, `item_transferred`, observations, and the minimal
  NarrativeCut onto the shared contracts;
- contract documentation and tests proving malformed inputs fail closed.

Explicitly excluded: database migrations, durable locks, command/event tables, outbox
workers, triggers, scheduler behavior, random draws, branch forks, movement, body state,
new model calls, and live-chat mutation. Those begin at E2.2 or later.

## Acceptance

- identity families are nominally distinct in TypeScript and retain opaque persisted
  values without trimming or case folding;
- deterministic derived IDs use unambiguous length-prefixed parts, and event identity
  includes branch identity;
- identity whitespace, unsafe/fractional/negative story time, zero event sequence,
  malformed wall-clock metadata, unknown fields, duplicate IDs, and unstable set ordering
  fail schema validation;
- all seven principal families use one controller envelope;
- command/event schema factories preserve literal command type and schema version;
- accepted results reject reversed or incomplete sequence ranges and duplicate event IDs;
- the Gate 1 transfer still passes authorization, idempotency, replay, viewpoint,
  NarrativeCut, and rerender tests after migration;
- the focused contract/runtime suite, repository lint, cycle scan, typecheck, pure tests,
  duplication gate, and Gate 1 latency benchmark pass;
- no persistence or model-call claim is made by this slice.

## Evidence log

Local focused evidence on 2026-07-16:

- simulation TypeScript contract check: passed;
- E2.1 contract plus Gate 1 runtime suites: 2 files / 17 tests passed;
- Gate 1 behavior remains unchanged in the focused suite;
- Gate 1 deterministic-path benchmark: p95 0.511 ms across 4,000 local samples,
  below the unchanged 5.0 ms budget;
- model calls added: zero.

Final repository evidence (PR [#9](https://github.com/ceponatia/vesper/pull/9), CI run 218):

- lint, circular-dependency scan, typecheck, 174 test files / 2,518 tests, and
  duplication gate: passed;
- focused E2.1 contract plus Gate 1 runtime suites: 2 files / 17 tests passed;
- deterministic-path benchmark over 4,000 samples: p50 0.170 ms, p95 0.400 ms,
  p99 0.666 ms against the unchanged 5.0 ms p95 budget;
- model calls added: zero;
- architecture verdict: E2.1 complete; advance to E2.2 durability.

## Next target

**E2.2 — durable branch transaction** consumes these contracts and adds the minimum
PostgreSQL authority rows and one atomic `transfer_item` transaction. E2.1 does not
pre-commit the Drizzle schema before that transaction and its crash tests are designed.

## Open questions

None block E2.1. Storage ID generation, branch lock strategy, and rejected-command audit
retention are E2.2 decisions because they depend on the transaction boundary.
