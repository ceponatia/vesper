# World-engine durable branch transaction

Status: **shipped — 2026-07-16** (status line updated late during the 2026-07-17 archive
sweep; the work itself merged as PR #12)

Parent: [engine.plan.md](engine.plan.md) · Contract: [engine.spec.md](engine.spec.md) ·
Predecessor: [engine-identity-envelopes.plan.md](engine-identity-envelopes.plan.md)

## Stable target

**E2.2 — durable branch transaction** replaces the temporary in-memory authority adapter
with the minimum PostgreSQL command/event transaction for `transfer_item`. It proves that
one branch can serialize concurrent work, survive process failure without partial truth,
and return the original outcome after a lost acknowledgement.

## Decisions

- **Authority IDs remain domain IDs.** World, branch, command, event, character, container,
  and item IDs are written explicitly and round-trip byte-for-byte. Storage does not replace
  them with generated row identities.
- **One PostgreSQL row lock sequences a branch.** The adapter selects `sim_branches FOR
  UPDATE`, rechecks idempotency after acquiring the lock, resolves with the pure kernel,
  and releases the lock only at commit. Different branches do not share that lock.
- **No model or network callback can enter the lock.** Test fault injection is a closed
  enum of synchronous throw points, not an arbitrary hook.
- **Every parsed outcome for an existing branch is durable.** Accepted, domain-rejected,
  stale-version conflict, inactive-world rejection, and duplicate-command results are
  stored by `(branch_id, idempotency_key)`. An unparseable envelope—or a command naming a
  nonexistent branch that cannot satisfy the command-row foreign key—fails closed without
  an authority row.
- **Command ID and idempotency key are different contracts.** A command ID already seen on
  the same branch is recorded as a duplicate rejection under the new idempotency key.
  Reusing that command ID on another branch is legal; branch identity keeps event IDs
  globally distinct.
- **The item holding is normalized.** `sim_items` owns stable item facts and exactly one
  `sim_item_holdings` primary-key row owns current placement. Container capacity and
  access are typed columns/records, not an EAV or narrator-authored JSON state.
- **Rejected commands do not enter domain history.** Their audit row is in
  `sim_commands`; only accepted state changes append `sim_events`.
- **Fork ancestry, outbox, triggers, and snapshots remain later targets.** E2.2 does not
  pre-implement E2.3–E2.5.

## Authority schema

Migration `0054_e2_2_durable_branch_transaction` adds:

| Table | E2.2 authority |
| --- | --- |
| `sim_worlds` | world type, opaque deterministic seed, ruleset, lifecycle status |
| `sim_branches` | world, head sequence, optimistic version, integer story second, row lock |
| `sim_commands` | full parsed envelope and exhaustive durable result, keyed by branch/idempotency |
| `sim_events` | immutable typed envelope columns and payload, unique event ID and branch sequence |
| `sim_characters` | minimum actor name and observed-container facts for this slice |
| `sim_holding_containers` | kind, capacity, and actor access facts |
| `sim_items` | stable branch-local item identity and name |
| `sim_item_holdings` | exactly one current container per item plus last event sequence |

Database checks bound causal integers to JavaScript's safe range. Composite foreign keys
prevent an event from naming a branch under a different world, and item-holding foreign
keys prevent dangling items or containers. Migration 0054 makes the holding-to-container
`NO ACTION` key `DEFERRABLE INITIALLY DEFERRED` (a PostgreSQL option Drizzle cannot model):
standalone deletion of a container that still holds an item fails at commit, while a
world/branch deletion may finish its item, holding, and container cascades coherently.

## Transaction protocol

For a parsed command:

1. return an existing branch/idempotency result as a lock-free fast path;
2. open a transaction and lock only the branch row (`FOR UPDATE OF sim_branches`); the
   joined world row supplies metadata but does not serialize sibling branches;
3. recheck idempotency under the lock to close the concurrent-arrival race;
4. reject a duplicate command identity, inactive world, or stale expected version;
5. load only the requested actor, item/holding, source/destination, destination count, and
   eligible witnesses;
6. parse the database rows into a minimal `ItemTransferResolutionView`;
7. run `resolveItemTransferFromView` in the pure library;
8. append the event, conditionally move the holding, and compare-and-swap the branch head;
9. persist the exhaustive command result;
10. commit.

The current story second does not advance for a zero-duration item transfer. Operational
timestamps are stored for audit and never drive resolution.

The typed read seam uses a read-only `REPEATABLE READ` transaction. Branch head, current
holdings, actors/containers, and immutable history therefore come from one PostgreSQL
snapshot; it cannot hand an agent or replay tool a projection torn across a concurrent
commit.

## Crash and concurrency proof

The integration suite injects failure after event append, holding update, branch advance,
and command-result insert. Every pre-commit failure must leave:

- zero new events;
- the original holding;
- the original branch head/version;
- no idempotency result.

A separate post-commit lost-acknowledgement test throws after PostgreSQL commits, retries
the same envelope, and must recover the original result with one event. Two simultaneous
commands at the same expected version must produce exactly one acceptance and one
structured conflict. Two simultaneous copies of the same envelope must also collapse to
one command row, result, and event even if both miss the lock-free fast path.

CI starts the repository's Postgres 17 + pgvector image, applies every migration from zero,
and runs the E2.2 database suite after the normal repository gate.

## Acceptance

- migration 0054 applies from the current main/engine migration lineage;
- accepted command, event, holding update, branch advance, and result are atomic;
- branch sequence and event ID uniqueness are database-enforced;
- concurrent same-version work cannot produce two accepted branch versions;
- a retry during or after a competing commit returns one stored result;
- domain rejection and conflict mutate no event/projection state and are themselves
  idempotent;
- duplicate command IDs cannot derive a second event on one branch;
- the same command ID remains legal on an isolated branch;
- current state can be read back through the Gate 1 typed projection/event contracts;
- one durable read cannot mix branch, projection, and event rows from different commits;
- Gate 1 pure behavior and deterministic-path benchmark remain within budget;
- no model call, scheduler, outbox consumer, or narrator mutation is added.

## Evidence log

Pending the implementation PR:

- focused TypeScript check: passing locally;
- identity-envelope and item-transfer resolver suite: 17/17 passing locally;
- migration generated non-interactively with Drizzle from snapshot 0053 and reviewed;
- PostgreSQL crash/concurrency suite: imports locally and intentionally skips without a
  database; CI treats an unavailable/unmigrated database as a hard failure;
- full repository lint, cycle scan, typecheck, unit tests, duplication gate, and benchmark:
  pending CI.

## Next target

**E2.3 — outbox and rebuildable consumers** adds transactional outbox records, consumer
checkpoints, retry diagnostics, and one projection that can rebuild from zero. It consumes
this exact transaction boundary; it does not widen the E2.2 lock around asynchronous work.
