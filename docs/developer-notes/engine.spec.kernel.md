# Engine spec — kernel: identity, time, commands, events, persistence, scheduler (§1–§12)

Status: companion to [engine.spec.md](engine.spec.md) — §1–§12, kernel.

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

## 1. Scope

This specification covers:

- world, branch, actor, place, item, action, commitment, and event identity;
- story time, deterministic resolution, scheduling, and replay;
- commands, events, projections, transactions, and outbox processing;
- physical locus, topology, travel, access, privacy, activities, and engagements;
- live-scene reconciliation when world events overlap a conversation;
- observation, belief, memory, perspective, RAG, and narration authority;
- bodies, meters, conditions, modifiers, materials, relationships, and autonomy;
- simulation and inference level of detail;
- retakes, branching, migrations, observability, testing, and language boundaries.

It does not prescribe UI, prose style, model vendor, deployment topology, or a complete
ontology of human behavior.

## 2. Terms

| Term              | Meaning                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| World type        | Authored rules, packages, calendars, content constraints, and defaults            |
| World             | One instantiated setting shared by one or more timelines                          |
| Branch            | One ordered, causally isolated timeline of a world                                |
| Story time        | Simulated time advanced only by committed game operations                         |
| Sequence          | Total event order within a branch                                                 |
| Command           | An authorized request to attempt a state transition                               |
| Domain event      | An immutable fact that the engine resolved as having occurred                     |
| Scheduled trigger | A durable request to evaluate something at a future story time                    |
| Projection        | Rebuildable current state derived from events                                     |
| Viewpoint         | Actor or authorized observer for whom context is compiled                         |
| Observation       | Evidence available to a viewpoint through a channel                               |
| Assertion         | A proposition claimed by a source; not necessarily true                           |
| Belief            | A holder's confidence in an assertion or proposition                              |
| Engagement        | A conversation or interaction that claims attention and may be physical or remote |
| NarrativeCut      | Immutable, perspective-safe input describing one committed presentation interval  |
| Armed effect      | A bounded semantic effect that commits only if narration actually enacts it       |
| Soft canon        | Scoped, revisable detail admitted without changing hard physical state            |
| LOD               | Level of detail for simulation work or inference attention                        |

## 3. Non-negotiable invariants

### 3.1 Physical and temporal invariants

1. A physical actor MUST have exactly one PhysicalLocus in a branch: at one place and
   zone, or in one journey.
2. Every relocation MUST have a cause: a validated move, journey transition, transport,
   rescue, or explicit privileged override.
3. Ordinary movement MUST respect a route and a lower-bound travel duration.
4. An actor MUST NOT hold incompatible exclusive activity, body, item, or attention
   claims at the same story time.
5. A schedule or clock boundary MUST NOT directly change location.
6. Wall-clock generation latency MUST NOT advance story time.
7. A long skip and equivalent smaller skips MUST produce the same material outcomes
   when commands, ruleset, seed, and exogenous inputs are equal.
8. If a derived value causes history, the event MUST capture the value or its complete
   causal inputs and derivation version.

### 3.2 Authority invariants

1. The player controls only actors for which the authenticated principal has a controller
   grant.
2. An utterance about an NPC is not an NPC command. “Mara comes here” is a request,
   invitation, prediction, or unsupported assertion unless Mara's controller chooses it.
3. LLM output MUST be treated as untrusted input and MUST pass schema, authorization,
   precondition, and invariant validation.
4. A narrator MUST NOT create hard movement, inventory, injury, body, access, commitment,
   observation, or knowledge events.
5. A world director MAY introduce future pressures and opportunities but MUST NOT rewrite
   current truth unless it uses an explicit privileged command.
6. Privileged relocation, retcon, or storyteller action MUST be separately authorized,
   visible in the audit log, and distinguishable from ordinary causality.

### 3.3 Knowledge and presentation invariants

1. Engine truth does not imply actor knowledge.
2. An actor may use a commitment only if the actor remembers it or perceives a legitimate
   cue such as an alarm, calendar, message, or other actor.
3. Retrieval eligibility MUST be decided before semantic ranking.
4. Private causes MUST NOT leak through denial text, narrator context, diagnostics, or
   embeddings.
5. Narration MUST render one immutable branch version and sequence boundary.
6. Unarmed prose MUST NOT create a hard or semantic effect.
7. Rerendering one NarrativeCut MUST NOT create new world state or memory.

### 3.4 Persistence invariants

1. A branch has one total event order.
2. Accepted command processing, event append, synchronous projection changes, trigger
   changes, branch version advancement, and outbox insertion MUST be atomic.
3. Idempotent command retries MUST return the original result.
4. Snapshots, projections, and vector indexes are caches. The event stream is historical
   authority.
5. Branches MUST be causally isolated after a fork.

## 4. Architectural components

The initial deployment MAY be a modular monolith. These boundaries are about ownership,
not network calls.

| Component            | Required responsibility                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| Command gateway      | Authenticate principal, validate envelope, enforce idempotency and controller grants |
| Branch sequencer     | Serialize accepted operations per branch and assign sequence numbers                 |
| Pure kernel          | Validate domain preconditions and resolve commands into events                       |
| Scheduler            | Evaluate durable triggers and analytically advance story time                        |
| Core projector       | Update invariant-critical query state in the command transaction                     |
| Async projector      | Build search, analytics, summaries, and embeddings through the outbox                |
| Live-scene arbiter   | Reconcile an engagement with due and upcoming world pressure                         |
| NPC policy           | Choose routine legal actions deterministically                                       |
| Deliberator          | Rarely choose among a bounded legal candidate set                                    |
| Perception engine    | Compute observation eligibility and evidence                                         |
| Knowledge ledger     | Store assertions, beliefs, provenance, contradictions, and supersedence              |
| Context compiler     | Produce one redacted NarrativeCut                                                    |
| Narrator             | Render prose from that cut                                                           |
| Presentation auditor | Flag impossible or leaked claims; never mutate truth                                 |
| Memory indexer       | Represent eligible records for semantic recall                                       |

## 5. Identity model

All identities MUST be opaque, stable, and independent of display names.

| Identity            | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| WorldTypeId         | Versioned package and authored-rule selection                 |
| WorldId             | Instantiated setting                                          |
| WorldBranchId       | Causally isolated timeline                                    |
| CharacterTemplateId | Reusable authored character definition                        |
| WorldCharacterId    | One instantiated character body and life in one world         |
| PlayerCharacterId   | A WorldCharacter role controlled by a player principal        |
| LocationId          | Stable place                                                  |
| ZoneId              | Sub-area with its own access, privacy, and occupancy          |
| LinkId              | Traversable connection between zones or locations             |
| ItemId              | Stable material object or fungible lot                        |
| ActionDefinitionId  | Versioned action contract                                     |
| ActivityInstanceId  | One attempted action over time                                |
| CommitmentId        | One obligation, promise, appointment, reservation, or routine |
| JourneyId           | One in-transit movement                                       |
| EngagementId        | One conversation or interaction                               |
| EventId             | Globally unique event identifier                              |

Every branch-scoped mutable row MUST include WorldBranchId. An entity display name MUST
NOT be used as a foreign key, route target, access target, or memory-eligibility key.

CharacterTemplate is authored input. WorldCharacter is historical identity. Editing a
template MUST NOT silently rewrite an instantiated character's past; the change requires
an explicit migration or world event.

## 6. Story time and determinism

### 6.1 Representation

Story time MUST be an integer. The recommended first representation is an integer
StorySecond relative to the world's calendar epoch. Existing whole-minute data converts
by multiplying by 60.

The kernel MUST reject non-finite, fractional, negative-duration, or unsafe-integer
values. Values whose rounding affects outcomes SHOULD use fixed-point integers rather
than floating point.

An event is ordered by:

1. branch sequence for historical order;
2. story second for simulated time;
3. stable trigger priority and trigger ID while resolving simultaneous due work.

Sequence, not timestamp, breaks ties.

### 6.2 Time advancement

Story time advances only through a committed operation:

- dialogue span under the configured TurnDurationPolicy;
- a validated action;
- wait;
- travel;
- skip;
- privileged time advance.

The duration of an HTTP request or model generation is irrelevant.

Story time MUST be monotonic within a branch. Moving to an earlier time requires a branch
fork; it is not a negative-duration command. requestedStorySecond on a command is only a
requested boundary and MUST be checked against the current branch time and the
principal's capabilities.

The ordinary-dialogue TurnDurationPolicy is an open product ruling. It MUST be explicit,
versioned by world type, and included in replay inputs. Until ruled, implementations MAY
use a fixed whole-minute span for prototypes but MUST NOT present it as final behavior.

### 6.3 Randomness

No kernel code may read ambient randomness. A random result MUST derive from a named
stream keyed by:

- world seed;
- branch ID;
- ruleset version;
- causal command, event, or trigger ID;
- purpose label;
- draw index.

Iteration order MUST be stable before drawing. If a sampled result affects history, the
chosen result and random-stream version MUST be recorded in the event.

### 6.4 Derivation rule

Pure, path-independent views MAY be recomputed. Examples include daylight from calendar
and coordinates, or age from birth date and story time.

A derivation becomes historical when it affects:

- whether an event occurs;
- which action wins;
- which route is taken;
- what an actor observes or remembers;
- resource consumption;
- a stochastic sample;
- a deadline or threshold crossing.

The causing event MUST then record the relevant result, inputs, and derivation version.

## 7. Authority and principals

Every command has a principal and capability set.

| Principal kind  | Normal authority                                                 |
| --------------- | ---------------------------------------------------------------- |
| player          | Controlled player actors and explicit player-owned UI operations |
| npc_policy      | One NPC actor under deterministic policy                         |
| npc_deliberator | Selection among candidate IDs already legal for one NPC          |
| system          | Due triggers, mechanical consequences, projection repair         |
| director        | Future pressures, opportunities, casting proposals               |
| storyteller     | Explicit world-type-defined privileged operations                |
| migration       | Versioned, audited data conversion                               |

Controller grants MUST be checked independently of narrative viewpoint. Seeing an NPC,
loving an NPC, or authoring the character does not by itself grant moment-to-moment
control in a shared world.

Storyteller authority MUST use a distinct command family such as
StorytellerRelocateActor. It MUST emit an event whose privileged cause is visible to
audit tooling. The normal MoveActor command MUST NOT gain hidden bypass flags.

## 8. Command contract

A command is a request, not a fact.

    type CommandEnvelope<TType, TPayload> = {
      id: string;
      branchId: string;
      expectedVersion: number;
      idempotencyKey: string;
      principal: {
        kind: PrincipalKind;
        principalId: string;
        controlledActorIds: string[];
      };
      submittedAtWallClock: string;
      requestedStorySecond?: number;
      type: TType;
      schemaVersion: number;
      correlationId: string;
      payload: TPayload;
    };

submittedAtWallClock is operational metadata only. It MUST NOT change simulation results.

A command result is exhaustive:

    type CommandResult =
      | {
          status: "accepted";
          commandId: string;
          branchVersion: number;
          firstSequence: number;
          lastSequence: number;
          eventIds: string[];
        }
      | {
          status: "rejected";
          commandId: string;
          code: RejectionCode;
          publicReason: string;
          legalAlternativeCommandTypes: string[];
        }
      | {
          status: "conflict";
          commandId: string;
          currentVersion: number;
          retryable: boolean;
        };

Rejected commands MAY be stored in an audit table, but MUST NOT appear as domain events
unless the attempt itself is observable and consequential, such as a noisy forced-entry
attempt.

The language interpreter may propose command envelopes, target references, or intent
classes. It MUST NOT resolve IDs by name without ambiguity checks and MUST NOT directly
call a projection mutation.

## 9. Event contract

### 9.1 Envelope

    type EventEnvelope<TType, TPayload> = {
      id: string;
      worldId: string;
      branchId: string;
      sequence: number;
      storySecond: number;
      type: TType;
      schemaVersion: number;
      rulesetVersion: string;
      derivationVersion?: string;
      commandId?: string;
      causationId?: string;
      correlationId: string;
      actorIds: string[];
      entityIds: string[];
      locationId?: string;
      payload: TPayload;
      recordedAtWallClock: string;
    };

recordedAtWallClock supports operations and audit only. Replay MUST use storySecond,
sequence, payload, ruleset version, and recorded deterministic inputs.

### 9.2 Event families

The first event catalog SHOULD include:

| Family       | Examples                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| world        | WorldCreated, BranchForked, RulesetAdopted                                                                                                  |
| identity     | CharacterInstantiated, ItemInstantiated, LocationInstantiated                                                                               |
| commitment   | CommitmentCreated, CommitmentUpdated, PressureRaised, CommitmentKept, CommitmentLate, CommitmentMissed, CommitmentCancelled                 |
| activity     | ActivityQueued, ActivityStarted, ActivityPaused, ActivityInterrupted, ActivityResumed, ActivityCompleted, ActivityFailed, ActivityCancelled |
| movement     | JourneyPlanned, ActorDeparted, JourneyDelayed, JourneyInterrupted, ActorArrived, JourneyAbandoned                                           |
| access       | AccessGranted, AccessRevoked, EntryAttempted, EntryDenied, ZoneEntered, ZoneLeft                                                            |
| engagement   | EngagementOpened, EngagementWindingDown, EngagementInterrupted, EngagementEnded, PressureAcknowledged                                       |
| material     | ItemTransferred, ItemConsumed, ResourceReserved, ResourceReleased, ItemDamaged                                                              |
| body         | BodyThresholdCrossed, ConditionAcquired, ConditionChanged, ConditionResolved, BodySourceApplied                                             |
| knowledge    | ObservationRecorded, AssertionMade, DisclosureMade, BeliefUpdated, AssertionContradicted, AssertionSuperseded                               |
| relationship | RelationshipEntryAuthored, RelationshipChangeRecorded, ConsentEscalationResolved                                                            |
| privileged   | StorytellerRelocation, StorytellerRetcon, MigrationApplied                                                                                  |

Names may change, but distinct causal concepts MUST NOT be collapsed into a generic
StateChanged event.

The `relationship` family (§9.2's table) gains concrete event names:
`RelationshipEntryAuthored`, `RelationshipChangeRecorded`, `ConsentEscalationResolved`
— `RelationshipEvidenceRecorded` (the placeholder name) is retired; every ledger
entry's causing event is one of these three OR a pre-existing event from another
family (`speech_act_delivered`, `disclosure_made`, `commitment_kept`,
`commitment_missed`, `commitment_created`, `engagement_ended`, `activity_started`).
`PromiseOffered`/`PromiseAccepted`/`BoundaryExpressed`/`FavorIncurred` (the table's
other placeholders) map to the closed §21.3 kind vocabulary, not to distinct events —
they derive from `speech_act_delivered`.

### 9.3 Trigger versus event

A scheduled trigger says “evaluate this at or after story time T.” It is not proof that
the outcome happened.

Examples:

- a JourneyArrivalDue trigger evaluates route progress and may emit ActorArrived,
  JourneyDelayed, or JourneyInterrupted;
- a CommitmentNoticeDue trigger may emit PressureRaised if the actor can remember or
  perceive the commitment;
- a BodyThresholdDue trigger integrates rates and may emit BodyThresholdCrossed;
- an ActivityCompletionDue trigger may emit ActivityCompleted or discover an
  interruption.

Triggers are mutable operational records. Domain events are immutable history.

## 10. Persistence model

PostgreSQL remains a suitable first authority store.

### 10.1 Authority tables

| Table                  | Key fields and purpose                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------- |
| sim_worlds             | world ID, world type, seed, ruleset version, status                                     |
| sim_branches           | branch ID, world ID, parent branch, fork sequence, head sequence, version, story second |
| sim_commands           | envelope, idempotency key, status, result or rejection                                  |
| sim_events             | branch sequence, envelope columns, schema-versioned payload                             |
| sim_scheduled_triggers | due story second, priority, kind, target, payload, state, unique logical key            |
| sim_outbox             | sequence range, consumer kind, payload, attempts, next retry                            |
| sim_snapshots          | branch, sequence, projection kind, schema version, checksum, payload                    |

The database MUST enforce uniqueness for:

- branch plus sequence;
- event ID;
- branch plus idempotency key;
- active trigger logical key where duplication would cause duplicate outcomes;
- one active PhysicalLocus per actor and branch.

### 10.2 Core typed projections

Core projections SHOULD be normalized and typed:

- sim_entities as a stable identity registry;
- sim_locations, sim_zones, and sim_links;
- sim_physical_loci;
- sim_items and sim_item_holdings;
- sim_commitments and sim_temporal_pressures;
- sim_activities and sim_resource_claims;
- sim_journeys;
- sim_access_grants;
- sim_engagements;
- sim_body_state and sim_conditions;
- sim_relationship_edges and sim_relationship_evidence;
- sim_observations, sim_assertions, and sim_beliefs.

A generic entity registry is acceptable. A generic entity-attribute-value table MUST NOT
replace typed invariant-critical projections.

### 10.3 Async projections

Search documents, embeddings, episode summaries, analytics, and UI denormalizations MAY
lag. They MUST be rebuildable and MUST include source branch and sequence.

An embedding row MUST identify the event, assertion, observation, episode, or authored
record it represents. Orphaned prose without provenance is invalid.

### 10.4 Snapshots

Snapshots accelerate replay. They MUST contain:

- branch and sequence;
- projection schema version;
- ruleset version;
- deterministic checksum;
- source event range.

A snapshot may be discarded at any time. Tests MUST periodically rebuild from zero to
prevent snapshots from hiding replay defects.

## 11. Transaction and concurrency protocol

### 11.1 One ordered stream per branch

Accepted state-changing work MUST serialize on a branch row or equivalent sequencer.
Different branches may proceed concurrently.

The normal transaction:

1. check for an existing command result by branch and idempotency key;
2. acquire the branch sequencing lock;
3. load branch version, story time, due triggers, and required core projections;
4. reject stale expectedVersion unless the command explicitly supports rebasing;
5. reconcile due triggers up to the command boundary;
6. validate authority and domain preconditions;
7. resolve the command with pure kernel code and explicit random streams;
8. append domain events with consecutive sequence values;
9. apply invariant-critical projections;
10. insert, update, or cancel scheduled triggers;
11. insert outbox records;
12. advance branch head, version, and story time;
13. persist the command result;
14. commit.

No model or network call may occur while the branch lock is held.

### 11.2 Deliberation without a long lock

If deterministic policy identifies a consequential close choice:

1. read branch version V and enumerate legal candidate IDs;
2. release all database locks;
3. ask the deliberator to select one candidate ID;
4. submit ResolveNpcChoice with expectedVersion V;
5. revalidate the selected candidate in the transaction;
6. on conflict, recompute and use deterministic fallback or perform at most one
   budgeted retry.

The deliberator cannot submit a new candidate.

### 11.3 Shared-world engagements

Opening a physical Engagement MUST reserve participant body and attention claims using
optimistic branch versioning. Two processes cannot place one NPC in two physical scenes.
A remote text engagement may coexist only if the current activity's attention policy
allows it.

An external event committed while narration is streaming receives a later sequence. It
does not rewrite the in-flight NarrativeCut and appears in the next cut. The system MUST
NOT hold a database transaction for the duration of streaming.

## 12. Scheduler

### 12.1 Queue order

Due triggers are ordered by:

1. dueStorySecond ascending;
2. priority ascending, where a lower number is more urgent;
3. stableOrder ascending — the immutable scheduling order assigned per branch;
4. trigger ID ascending.

The order is part of the ruleset version.

stableOrder precedes trigger ID because a trigger ID is a derived hash: ordering
simultaneous, equal-priority triggers by it is deterministic but arbitrary, whereas
stableOrder reflects the order they were actually scheduled. Trigger ID remains the final
tie-break so the order is total even if two rows ever share a stableOrder.

### 12.2 Advance algorithm

To advance from T0 to target T1:

1. find the next due trigger at or before T1;
2. analytically integrate affected rates from the current boundary to that trigger;
3. set branch story time to that trigger's due second;
4. process all triggers at that story second in stable order;
5. append material events and schedule resulting triggers;
6. repeat until no trigger is due;
7. analytically integrate remaining rates to T1;
8. set branch story time to T1.

The scheduler MUST NOT scan every actor or every minute.

Step 3 is normative and easy to lose: the clock MUST step to each trigger's own due
second **before** that trigger resolves. An event takes its story second from the branch
clock, so jumping straight to T1 and draining afterwards stamps every drained event with
T1 and silently violates §12.4 — advance(T0,T3) then disagrees with
advance(T0,T1); advance(T1,T2); advance(T2,T3) even though both drained the same triggers.

### 12.3 Catch-up bounds

A command may declare a maximum trigger count and wall-clock compute budget. If catch-up
exceeds it, the engine MUST persist a safe partial boundary and return CATCH_UP_REQUIRED
or continue in a background worker. It MUST NOT skip triggers or approximate exact-LOD
actors silently.

### 12.4 Required property

For equal seed, inputs, and ruleset:

    advance(T0, T3)

must produce the same material event/projection result as:

    advance(T0, T1); advance(T1, T2); advance(T2, T3)

Intermediate bookkeeping events MAY differ only if declared non-material and excluded
from domain history. Prefer not to emit them.

