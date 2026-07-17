# E2.3 — transactional outbox and rebuildable consumers

Status: **shipped — 2026-07-16** (status line updated late during the 2026-07-17 archive
sweep; the work itself merged as PR #13)

Depends on E2.2 at `f884b835bef0c3f42576348cd81b0d032d006c93`. This target adds one durable asynchronous delivery path to the accepted `transfer_item` transaction. It does not add scheduling, model calls, forks, snapshots, or a general workflow framework.

## Outcome

An accepted item transfer atomically leaves both authoritative history and a delivery obligation. A worker can crash, retry, receive the same obligation more than once, or rebuild its projection from sequence zero without changing world truth or producing duplicate read-model rows.

The first consumer builds an **item-transfer activity feed**. This is intentionally non-authoritative: UI, analytics, and future context compilation may read it, but command validation and physical state must continue to read `sim_events` and the synchronous typed projections.

## Contracts

### Transactional outbox

`sim_outbox` contains one row per accepted event and consumer kind for E2.3:

- stable outbox ID derived from consumer kind and event ID;
- world, branch, first sequence, last sequence, and source event ID;
- consumer kind and schema-versioned payload;
- state: `pending`, `processing`, `completed`, or terminal `failed`;
- attempts, available-at time, lease owner, lease expiry, last error, and completion time;
- created and updated timestamps.

The row is inserted in the E2.2 command transaction after the event and synchronous projection are written and before the branch advances. Rejected and conflicting commands create no outbox work. A duplicate command returns its stored result and creates no additional row.

Outbox identity and a unique `(consumer_kind, branch_id, source_event_id)` constraint make publication idempotent. Payloads contain references and routing facts, not a second copy of mutable authority.

### Consumer checkpoint

`sim_consumer_checkpoints` is keyed by consumer kind and branch. It records the greatest contiguous sequence applied, projection schema version, and update time. It is progress metadata, not authority.

A consumer transaction must:

1. claim an eligible row with a bounded lease using `FOR UPDATE SKIP LOCKED`, while an earlier non-completed row on that consumer and branch makes later rows ineligible;
2. load and validate the referenced committed event;
3. apply the async projection idempotently;
4. advance the checkpoint only across a contiguous range;
5. mark the row completed;
6. commit all three changes atomically.

The first implementation processes one event per row and one row per consumer transaction. Batching can follow measurements; it must not weaken ordering or diagnostics.

### Activity-feed projection

`sim_item_transfer_feed` is keyed by consumer kind, branch, and event ID and stores source sequence, story second, actor/item/container references, and projection schema version. Its uniqueness makes duplicate application harmless.

The feed must not be consulted by `transfer_item` validation. Deleting and regenerating it must not change the branch head, event log, item holding, or command result.

### Retry and quarantine

Failures release or expire the lease, increment attempts, preserve a bounded perspective-safe diagnostic, and set deterministic exponential backoff with a cap. Diagnostics include branch, sequence, event, outbox, consumer, attempt, and schema version. They must not contain secrets or private prose.

E2.3 does not silently discard poison work. After the configured attempt threshold it remains queryable as failed work requiring operator action; the branch authority remains usable because the failed projection is explicitly non-critical.

## Rebuild from zero

Provide a typed rebuild operation for one consumer and branch:

1. take a consumer-scoped advisory lock so live consumption and rebuild cannot interleave;
2. clear only that consumer's projection rows and checkpoint;
3. replay compatible branch events in sequence order through the same projector function used by live delivery;
4. write a checkpoint at the greatest contiguous applied sequence;
5. compute and return a deterministic projection hash and row count;
6. release the lock.

The rebuild reads immutable events directly; it does not manufacture replacement outbox rows and does not mutate existing delivery diagnostics. Re-running it must produce the same hash as both the prior rebuild and the live projection.

## Implementation order

1. Add typed outbox, checkpoint, and feed tables plus migration `0055`.
2. Add an outbox insert to the accepted E2.2 transaction and a crash failpoint immediately after it.
3. Implement a pure, exhaustive `item_transferred` → feed-row projector.
4. Implement claim, consume, complete, lease recovery, and retry diagnostics.
5. Implement consumer-scoped rebuild and deterministic hashing.
6. Add an E2.3 integration target to CI after migrations and E2.2 tests.

## Required tests

- accepted transfer, event, projection, branch advance, command result, and outbox row commit atomically;
- crash after outbox insertion rolls all of them back;
- rejection and conflict create no outbox row;
- command retry creates no duplicate outbox row;
- two workers cannot successfully own the same active lease;
- crash after projection write but before commit leaves neither feed row nor checkpoint advance;
- duplicate delivery yields one feed row and a monotonic checkpoint;
- expired lease is recoverable;
- a forced projector failure records attempt, next retry, and identifiers without changing authority;
- a sequence gap prevents checkpoint advancement past the gap;
- rebuild-from-zero equals the live projection by rows and deterministic hash;
- deleting the async projection does not affect command validation or physical state;
- consumers on different branches progress independently.

## Exit criteria

E2.3 advances when CI proves atomic publication, idempotent consumption, bounded retry diagnostics, gap-safe checkpoints, branch isolation, and live-versus-rebuilt hash equality. The command transaction must add no network/model work and only one indexed outbox insert. Record command p95 delta, consumer throughput, oldest pending age, retry age, and rebuild duration; unexpected command-path regression or a projection that becomes required authority means revise rather than advance.

## Explicit deferrals

- Scheduler trigger claiming and deterministic draws belong to E2.4.
- Branch forks, snapshots, and cross-branch rebuild semantics belong to E2.5.
- Embeddings and narrator memory remain later consumers; this target proves the delivery contract without external services.
- Multi-event batching, partitioned outbox tables, LISTEN/NOTIFY wakeups, and a Rust worker require measured volume or latency evidence.
