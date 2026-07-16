# World-engine Gate 1 — item-transfer authority seam

Status: active — PR [#8](https://github.com/ceponatia/vesper/pull/8) ready for review (started 2026-07-16)

Parent: [engine.plan.md](engine.plan.md) · Contract: [engine.spec.md](engine.spec.md)

## Purpose

Prove the smallest end-to-end successor-engine path before introducing persistence tables,
scheduling, movement, physiology, or new model calls. One validated `transfer_item`
command must become one immutable event, one synchronous projection change, and one
perspective-safe narrative input. The experiment remains deliberately deleteable.

## Scope

Build only:

- one stable world and branch identity with optimistic versioning;
- one item and two holding containers/locations;
- one `transfer_item` command and exhaustive result union;
- authority, source, access, capacity, and one-holding validation;
- one `item_transferred` event, deterministic observer derivation, and synchronous
  projection update;
- an in-memory branch runtime with idempotency and deterministic replay;
- a minimal immutable NarrativeCut compiled separately for an observer and non-observer;
- a prompt adapter that appends the cut to the existing character-chat narrator;
- presentation-only rerendering of the same cut.

Explicitly excluded: PostgreSQL authority tables, scheduler, clocks advancing, movement,
activities, body state, autonomous NPC policy, RAG, embeddings, new agent legs, and live
chat-lane mutation.

## Predeclared experiment budget

The benchmark is the hot deterministic path from parsed command submission through event,
projection, observations, and NarrativeCut compilation. After warmup, its p95 budget is
**5.0 ms** on the repository's Node 22 CI runner. Gate 1 adds **zero model calls and zero
model tokens**. A result over budget fails the experiment; the threshold is not raised
after measurement without a written explanation and a fresh run.

The quality check is a deterministic paired-view scenario, not prose preference scoring:
the observer must receive and be required to enact exactly one transfer; the non-observer
must receive no item, source, destination, actor, or event detail; neither prompt may
license a second transfer. A later live-model evaluation can test enactment wording, but
it is not allowed to decide truth or visibility.

## Acceptance

- Invalid or unauthorized transfer: no event, branch-version change, projection change,
  observation, or cut provenance.
- A duplicate idempotency key returns the original result and creates one outcome.
- A stale expected version returns a conflict without mutation.
- Replaying immutable events from the seed produces the same canonical projection hash.
- The item has exactly one holding container before and after replay.
- The observer cut includes exactly one observed transfer; the non-observer cut exposes no
  transfer detail.
- Recompiling a cut at the same branch boundary yields the same ID and semantic hash.
- Rerender variants use the same cut and leave event, projection, and memory hashes equal.
- The current narrator adapter identifies required beats and explicitly forbids invented
  hard outcomes.
- `pnpm verify` and the Gate 1 benchmark pass in CI.

## Persistence decision

Gate 1 intentionally uses an in-memory adapter. It tests the kernel and authority contract
without paying for migrations or blessing a table design before the seam is proven.
The adapter is not production durability and cannot satisfy the later transaction/crash
acceptance tests. Gate 2 may replace it with the spec's PostgreSQL
`sim_branches`/`sim_commands`/`sim_events`/projection transaction while retaining the
same command, event, replay, and cut contracts.

## Evidence log

Implementation evidence (CI run 208, 2026-07-16):

- canonical `pnpm verify`: passed — lint, circular-dependency scan, typecheck,
  173 test files / 2,510 tests, and duplication threshold;
- Gate 1 contract coverage: ten kernel/runtime scenarios plus one current-narrator
  integration test;
- CI benchmark, 4,000 samples after warmup: p50 0.118 ms, p95 0.233 ms,
  p99 0.405 ms against the predeclared 5.0 ms p95 budget;
- model calls and tokens added by the deterministic path: zero;
- architecture verdict: retain the command/event/projection/observation/cut seam for the
  next slice; do not treat the in-memory adapter as production durability.
