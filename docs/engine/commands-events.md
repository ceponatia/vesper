# Commands and events

How a request becomes durable simulation history: the command and event
envelopes, the authority checks a command passes through, the transaction that
makes acceptance atomic, and the scheduler that turns due triggers back into
commands. Identity, story time, and the engine's core invariants are covered in
[kernel.md](kernel.md); this doc covers the causal seam between them. The
normative source is `engine.spec.kernel.md` §8–§12 (cited below as
`engine.spec §N`); the TypeScript contracts live in
[@vesper/simulation-core](../../packages/simulation-core/README.md).

## Command envelope

A command is a request, not a fact — accepting it is never guaranteed. Every
command family shares one envelope factory (`packages/simulation-core/src/contracts/envelopes.ts`)
rather than each family inventing its own shape:

- `id`, `branchId`, `correlationId` — identity and tracing.
- `expectedVersion` — the branch version the sender believes is current, used
  for optimistic concurrency.
- `idempotencyKey` — makes a retried submission return the original result
  instead of resolving twice.
- `principal` — `{ kind, principalId, controlledActorIds }`. Kind is one of
  player, deterministic NPC policy, sparse NPC deliberator, system, director,
  storyteller, or migration; the full authority rules for each are owned by
  kernel.md.
- `submittedAtWallClock` — operational metadata only; it never changes
  simulation results.
- `requestedStorySecond` — optional, and only a requested boundary. It is
  checked against the branch's current story time and the principal's
  capabilities, not trusted outright.
- `type`, `schemaVersion`, `payload` — the typed, versioned request body.

A command's outcome is an exhaustive three-way union (engine.spec §8):
**accepted** (`branchVersion`, `firstSequence`/`lastSequence`, `eventIds`),
**rejected** (`code`, `publicReason`, `legalAlternativeCommandTypes`), or
**conflict** (`currentVersion`, `retryable`). Rejections may be kept in an
audit table, but they become domain events only when the attempt itself is
observable and consequential — a noisy forced-entry attempt, say — not by
default. A language interpreter may propose a command envelope or target
reference, but it never resolves an ID by name without an ambiguity check and
never calls a projection mutation directly.

## Event envelope

Every event family shares one envelope factory the same way commands do,
carrying `id`, `worldId`, `branchId`, `sequence`, `storySecond`, `type`,
`schemaVersion`, `rulesetVersion`, optional `derivationVersion` and
`causationId`, `correlationId`, sorted-and-unique `actorIds`/`entityIds`,
optional `locationId`, and the typed `payload` (engine.spec §9.1). Reference
sets are sorted and deduplicated so insertion order can never leak into replay
behavior. `recordedAtWallClock` is operational/audit metadata only — replay
determinism runs entirely on `storySecond`, `sequence`, `payload`,
`rulesetVersion`, and whatever deterministic inputs the event recorded, never
on wall-clock time.

### Event families

Events are named for the causal concept they represent; the catalog never
collapses distinct concepts into a generic `StateChanged` event (engine.spec
§9.2). A representative slice of the family catalog:

| Family       | Example events                                       |
| ------------ | ---------------------------------------------------- |
| identity     | CharacterInstantiated, ItemInstantiated              |
| commitment   | CommitmentCreated, CommitmentKept, CommitmentMissed  |
| activity     | ActivityStarted, ActivityCompleted, ActivityFailed   |
| movement     | ActorDeparted, ActorArrived, JourneyInterrupted      |
| access       | AccessGranted, EntryDenied, ZoneEntered              |
| engagement   | EngagementOpened, EngagementEnded                    |
| material     | ItemTransferred, ItemConsumed, ItemDamaged           |
| body         | BodyThresholdCrossed, ConditionAcquired              |
| knowledge    | ObservationRecorded, AssertionMade, BeliefUpdated    |
| relationship | RelationshipEntryAuthored, ConsentEscalationResolved |
| privileged   | StorytellerRelocation, StorytellerRetcon             |

World creation and branch forking are not event-sourced: `forkBranch`
(`branch-store.ts`) inserts a child `sim_branches` row directly, and world
provisioning (`material-store.ts`) inserts `sim_worlds` directly — neither
appends a `sim_events` row. The `world_created` string in the schema is a
provisioning status value on the world row, not a domain event.

The relationship family's events are exactly three:
`RelationshipEntryAuthored`, `RelationshipChangeRecorded`, and
`ConsentEscalationResolved`. Every relationship-ledger entry's causing event is
one of these three, or a pre-existing event from another family
(`speech_act_delivered`, `disclosure_made`, `commitment_kept`,
`commitment_missed`, `commitment_created`, `engagement_ended`,
`activity_started`) — there is no separate `PromiseOffered`,
`BoundaryExpressed`, or similar per-speech-act event; those distinctions live
in the payload's kind vocabulary instead.

### Trigger versus event

A scheduled trigger says "evaluate this at or after story second T" — it is
not proof that anything happened. A `journey_arrival_due` trigger, for example,
may resolve into `ActorArrived`, `JourneyDelayed`, or `JourneyInterrupted`
depending on state at evaluation time; a `commitment_notice_due` trigger may or
may not emit `PressureRaised`, depending on whether the actor can remember or
perceive the commitment. Triggers are mutable operational records that get
claimed, rescheduled, and discarded; domain events are immutable history
(engine.spec §9.3).

## Authority flow: from command to event

The item-transfer command is the concrete shape every other command family
follows. `TransferItemCommand` checks actor control, the item's current
holding, access to both the source and destination containers, and
destination capacity — all against loaded state, before anything is written.
Rejection and conflict outcomes never create domain history. An accepted
command resolves through pure kernel code into exactly one
`ItemTransferredEvent`. The event payload itself carries no observer field —
witnesses are derived live from presence at the acting actor's zone each time
they are needed, not captured on the event. The synchronous projector then
moves the item to exactly one container and writes one typed observation per
eligible witness.

The same pure resolver — `resolveTransferItemFromView`, over a
`MaterialResolutionView` in this case — serves both the durable path (used
inside the transaction, via `material-store.ts`) and an in-memory instance
built by the engine benchmark harness (`scripts/eval/engine-gate1/run.ts`),
so there is exactly one place a transfer's legality is decided, not two
implementations that can drift apart.

## Persistence model

PostgreSQL is the authority store. Snapshots, projections, and vector indexes
are caches over it — the event stream is the historical record (engine.spec
§10.4). The core authority tables:

| Table         | Holds                                                        |
| ------------- | ------------------------------------------------------------ |
| sim_worlds    | world id, world type, seed, ruleset version, status          |
| sim_branches  | branch id, parent, fork sequence, head sequence, story time  |
| sim_commands  | envelope, idempotency key, status, result or rejection       |
| sim_events    | branch sequence, envelope columns, versioned payload         |
| sim_triggers  | due story second, priority, kind, target, payload, state     |
| sim_outbox    | sequence range, consumer kind, payload, attempts, next retry |
| sim_snapshots | branch, sequence, projection kind, schema version, checksum  |

The database enforces uniqueness on branch+sequence, event ID, branch+
idempotency key, and each active trigger's logical key (so duplicate scheduling
can't produce duplicate outcomes); one further uniqueness rule protects a
physical-placement invariant that kernel.md owns (engine.spec §10.1).

Core projections (`sim_characters`, `sim_items`, `sim_physical_loci`,
`sim_item_holdings`, `sim_commitments`, `sim_engagements`, and similar) are
normalized and typed — a generic entity-attribute-value table never
substitutes for an invariant-critical projection, though a generic entity
registry is fine for identity bookkeeping. Async projections — search
documents, embeddings, episode summaries, analytics — may lag behind the
event stream, but every one must be rebuildable from source branch and
sequence, and every embedding row must name the event, assertion,
observation, or record it represents; prose without provenance is invalid
(engine.spec §10.2–§10.3).

A snapshot exists purely to speed up replay: it carries branch, sequence,
projection schema version, ruleset version, a deterministic checksum, and the
source event range, and can be discarded at any time without losing history.
Tests periodically rebuild projections from zero rather than from a snapshot,
because a snapshot can silently hide a replay defect that only shows up on a
full rebuild (engine.spec §10.4).

## Transaction protocol

Due-trigger reconciliation happens before a command is built, not inside its
transaction. `advanceBranchStoryTime` (`scheduler-store.ts`) steps the branch
clock to each due trigger's own due second, resolves it through its own
command transaction, and repeats until nothing remains due at the boundary —
writing `storySecond` as it goes; a caller such as the arbiter's turn
preparation (`arbiter-store.ts`) runs this drain before building the command.
engine.spec §11.1 places trigger reconciliation inside the locked command
transaction; the locked transaction never loads or reconciles due triggers.

Accepted, state-changing work then serializes on a branch row — different
branches proceed fully concurrently, but one branch has exactly one ordered
stream. A `FOR UPDATE` lock on `sim_branches` is what makes command
resolution, event append, projection update, branch advance, and
command-result insert one atomic step. In order, inside
`runSimulationCommand` (`command-runner.ts`):

1. Look up an existing result by branch + idempotency key, before the lock is taken.
2. Acquire the branch sequencing lock, loading branch version, story time, and world status.
3. Re-check idempotency and reject a duplicate command ID now that the lock is held.
4. Reject an inactive branch or a stale `expectedVersion` as a conflict outcome.
5. Load required projections, validate authority and domain preconditions, and resolve the command with pure kernel code and named random streams.
6. Append domain events with consecutive sequence values.
7. Apply invariant-critical projections.
8. Insert, update, or cancel scheduled triggers as an effect of the appended events.
9. Insert outbox records.
10. For an accepted outcome, fold observations, knowledge, relationship-ledger entries, and soft-canon snapshots, then enqueue memory-index obligations.
11. Advance the branch's head sequence and version — story time is not written here; it was already advanced by the trigger reconciliation that ran before the command was built.
12. Persist the command result.
13. Commit.

No model or network call happens while the branch lock is held — that would
turn a database lock into a wait on an LLM. The adapter also rechecks
idempotency *after* acquiring the lock, not just before, so two concurrent
retries of the same command can't both race through the lock-free fast path
and double-resolve.

engine.spec §11.2 describes a deterministic policy handing a close,
consequential choice to a deliberator without holding the lock: it would read
branch version V, release all locks, ask the deliberator to pick one
candidate, and submit that pick as a command carrying `expectedVersion: V`,
with the transaction revalidating the pick against current state on
conflict. This is not implemented — no `ResolveNpcChoice` command exists.
`packages/simulation-core/src/contracts/deliberation.ts` defines only the
admission-gating contract (inference LOD, score-gap threshold,
consequentiality, model budget) and states it makes zero live model calls
until an LOD controller supplies a real deliberator.

Opening a physical engagement reserves participant body and attention claims
under the same optimistic branch versioning, which is what stops two
concurrent requests from placing one NPC into two physical scenes at once. A
remote text engagement may still coexist with a physical one if the current
activity's attention policy allows it. An external event committed while
narration is streaming simply receives a later sequence — it does not rewrite
the NarrativeCut already in flight, and shows up in the next one instead — and
the engine never holds a database transaction open for the duration of a
streaming response (engine.spec §11.3).

## Scheduler

### Queue order

Due triggers drain in `dueStorySecond` ascending, then `priority` ascending
(lower number is more urgent), then `stableOrder` ascending, then trigger ID
ascending, and this order is part of the ruleset version (engine.spec §12.1).
`stableOrder` is checked before trigger ID deliberately: a trigger ID is a
derived hash, so breaking ties by it would be deterministic but arbitrary,
while `stableOrder` reflects the sequence triggers were actually scheduled in.
Trigger ID is only the final tie-break, for the rare case two rows share a
`stableOrder`.

### Advance algorithm

Advancing a branch from T0 to a target T1 repeats: find the next due trigger
at or before T1, step the branch clock to that trigger's own due second,
process every trigger due at that second in stable order, append the
resulting events and reschedule any new triggers, and repeat until nothing is
due — then set the clock to T1. The scheduler never scans every actor or
every minute to find what's due.

engine.spec §12.2 also describes analytically integrating affected rates up
to each trigger and again over the remaining span before the final clock set.
This is not implemented — no continuous rate exists to integrate. Body
meters instead integrate lazily, on read and on write, in `body-reads.ts` and
`body-store.ts`; the drain loop above is the seam reserved for analytical
rate integration once a continuous rate exists.

The clock stepping to each trigger's own due second *before* that trigger
resolves is easy to get wrong and important: an event takes its story second
from the branch clock at the moment it's appended, so jumping straight to T1
and draining afterward would stamp every drained event with T1 instead of its
true due second — silently breaking the requirement that one long advance and
several smaller ones produce the same result (engine.spec §12.2).

### Catch-up bounds and determinism

A command may declare a maximum trigger count and a wall-clock compute budget
for catch-up. Exceeding either persists a safe partial boundary and returns
`catch_up_required` (or continues in a background worker) rather than skipping
triggers or approximating an exact-LOD actor's outcome (engine.spec §12.3).
For equal seed, inputs, and ruleset, `advance(T0, T3)` produces the same
material event and projection result as running `advance(T0, T1)`,
`advance(T1, T2)`, `advance(T2, T3)` in sequence — only non-material,
declared-excluded bookkeeping events may differ between the two, and the
engine prefers not to emit those at all (engine.spec §12.4).

### Trigger creation

A trigger is created only as the effect of a committed event, never as a
side-channel insert. A schedule command — `schedule_transfer_item`, for
example — appends a `trigger_scheduled` event inside the same branch
transaction (step 8 above), and one projector, `applyTriggerScheduledEvent`,
is the only code that inserts trigger rows; it runs both on the live path and
again during fork replay, so the trigger queue is always rebuildable from
event history rather than being state the history can't explain.
`scheduleDurableTrigger` wraps this as an idempotent call whose command
identity derives from the trigger's own identity, so re-scheduling the same
trigger is safe to retry.

## Where this lives in code

- `packages/simulation-core/src/contracts/envelopes.ts` — command/event
  envelope factories, principal and exhaustive-result schemas.
- `packages/simulation-core/src/contracts/scheduler.ts` — trigger contract,
  derived trigger identity, named random draw streams, retry backoff.
- `apps/web/src/server/engine/simulation/command-runner.ts` — the shared
  locked command transaction shell (`runSimulationCommand`) every domain
  store's `execute` callback runs inside.
- `apps/web/src/server/engine/simulation/scheduler-store.ts` — the durable
  trigger queue, lease/claim semantics, bounded story-time advance.
- `apps/web/src/server/engine/simulation/branch-store.ts` — the branch
  transaction, ancestry loading, and live-state assembly.

## Related

- [kernel.md](kernel.md) — identity, story time, determinism, and the engine's
  core invariants.
- [@vesper/simulation-core](../../packages/simulation-core/README.md) — production contract
  locations and the item-transfer walkthrough this doc summarizes.
