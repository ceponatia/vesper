[← Contracts index](README.md)

# Successor simulation contracts

The successor engine begins with the executable authority seam described by
[engine.spec.md](../developer-notes/engine.spec.md). Gate 1 proved that a
`transfer_item` request can be validated, resolved to one immutable
`item_transferred` event, synchronously projected, replayed, and compiled into a
perspective-safe NarrativeCut. Gate 2 target E2.1 promotes the causal primitives into
reusable production contracts.

The implementation lives in:

- `src/contracts/simulation/identity.ts` — opaque branded identities and safe integer
  causal primitives;
- `src/contracts/simulation/envelopes.ts` — principals and strict command, event, and
  exhaustive-result schema factories;
- `src/contracts/simulation/item-transfer.ts` — the first command/event/projection,
  observation, and NarrativeCut family;
- `src/contracts/simulation/scheduler.ts` — the E2.4 trigger contract, derived trigger
  identity, named deterministic draw streams, and capped retry backoff;
- `src/lib/simulation/item-transfer.ts` — pure resolver over a minimum authority view,
  projector, replay, cut compiler, prompt formatter, and the temporary in-memory runtime;
- `src/server/engine/simulation/item-transfer-store.ts` — the E2.2 PostgreSQL branch
  transaction and typed read/bootstrap adapter;
- `src/server/engine/simulation/scheduler-store.ts` — the E2.4 durable trigger queue,
  lease/claim semantics, and the bounded story-time advance seam;
- `src/server/engine/world-engine.ts` — the adapter into the existing character-chat
  narrator.

## Identity and causal primitives

Each identity family is a nominal TypeScript type backed by the same strict opaque string
shape. IDs are never trimmed, case-folded, resolved from display names, or accepted with
whitespace. World, branch, character, place, item, action, activity, commitment, journey,
engagement, command, event, trigger, observation, cut, outbox, and snapshot identities
therefore cannot be interchanged accidentally after parsing.

Deterministically derived identities use length-prefixed parts rather than ambiguous raw
delimiter concatenation. Event identity includes branch plus command identity, so the
same command ID on a causally isolated branch cannot collide in the global event catalog.

Story time and branch versions are nonnegative safe integers. Event sequence and schema
version are positive safe integers. Fractional, negative, infinite, and unsafe values fail
at the trust boundary.

## Command and event envelopes

Every command family uses one envelope factory: command identity, branch identity,
optimistic version, idempotency key, principal/controller grants, strict ISO operational
timestamp, optional requested story boundary, literal type/schema version, correlation
identity, and typed payload. The principal vocabulary includes player, deterministic NPC
policy, sparse NPC deliberator, system, director, storyteller, and migration authority.

Every event family uses one envelope factory with world/branch identity, branch sequence,
story time, ruleset, optional derivation and causation, correlation, stable actor/entity
reference sets, optional location, operational timestamp, and typed payload. Reference
sets must be sorted and unique so insertion order cannot become replay behavior.

Command outcomes share an accepted/rejected/conflict union. Accepted ranges cannot run
backward, skip a sequence, or repeat an event ID. Rejected public reasons and alternatives
remain separate from private predicates, while conflicts report the current branch
version.

## Item-transfer authority flow

`TransferItemCommand` uses the shared envelope and checks actor control, current source,
access to both holding containers, and destination capacity. Rejection and conflict do
not create domain history.

An accepted command emits one `ItemTransferredEvent` using the shared event envelope. The
event records observer IDs derived at resolution time under `gate1-perception-v1`; replay
therefore does not recompute historical visibility from newer state. The synchronous
projector moves the item to exactly one container and creates one typed observation per
eligible witness.

## Durable authority transaction

E2.2 persists parsed command outcomes by branch and idempotency key. A PostgreSQL
`FOR UPDATE` lock on `sim_branches` serializes resolution, event append, typed
`sim_item_holdings` update, branch advance, and command-result insert. The adapter
rechecks idempotency after it acquires the lock, so two concurrent retries cannot race
through the lock-free fast path.

The storage adapter loads only the actor, requested item and holding, two containers,
destination count, and eligible witnesses into `ItemTransferResolutionView`. The same
pure resolver serves the in-memory and durable paths. Rejections and optimistic conflicts
are durable audit outcomes but do not enter `sim_events`.

Crash failpoints are closed synchronous throw locations—never arbitrary callbacks under
the lock. Integration tests prove rollback after every pre-commit write, recovery from a
lost post-commit acknowledgement, one acceptance plus one conflict for concurrent
same-version commands, and one stored outcome when identical idempotent submissions race. The typed branch reader uses a read-only repeatable-read transaction so projection and history cannot straddle a concurrent commit.

## Perspective and narration

The NarrativeCut query joins through the observation ledger before it reads event detail.
An observer receives the transfer as one required beat. A non-observer receives no actor,
item, source, destination, event, or denial-cause detail—only a generic prohibition on
claiming unobserved inventory changes.

The existing narrator receives the cut only through
`buildCharacterChatPromptForNarrativeCut`. It may vary presentation, but the prompt grants
no additional hard transition. Rerender variants reuse the same cut ID and semantic hash
and have no command or persistence capability.

## Scheduling and story time

A trigger is a durable request to evaluate something at a future story second. Nothing
else makes it due: `advanceBranchStoryTime` moves the branch clock and drains whatever
becomes due, in `dueStorySecond` → `stableOrder` → `id` order (spec §12.1). A trigger
resolves through the same command transaction a player command uses, so it inherits that
seam's idempotency, ordering, and crash atomicity rather than reimplementing them.

Triggers express *when to evaluate*, never an outcome: a trigger carries a command to
submit, and the command is still validated, and may still be rejected, on its merits. The
trigger's own branch is authoritative for routing — a payload naming another branch is
refused by both the contract and a database check constraint.

Advance is bounded. A caller may declare `maxTriggers` and `budgetMs`; exceeding either
persists the boundary reached and returns `catch_up_required` (spec §12.3). Triggers are
never skipped and never approximated away.

## Deliberate limits

Durability covers only the first item-transfer family. The in-memory adapter remains a pure
test/replay fixture; production persistence has crash atomicity, cross-process branch
locking, durable command results (E2.2), asynchronous rebuildable consumers (E2.3), and a
durable trigger queue (E2.4).

Deliberately absent, with owners:

- **Analytical rate integration** inside advance (spec §12.2 steps 2 and 6). No continuous
  rate exists until Gate 5 bodies; the drain loop is the seam it will slot into.
- **Deterministic draw integration.** `deterministicDrawUnit` ships as a tested primitive
  with no production consumer — `transfer_item` consumes no draws. The first real use is
  Gate 3 lateness/travel, which must record stream, index, value, and derivation version on
  the event that consumed it.
- **Branch forks, snapshots, and audit** are E2.5; the Gate 2 soak and verdict are E2.6.
- **Movement, commitments, and live-scene arbitration** are Gate 3. A trigger must not set
  location directly when they arrive.
