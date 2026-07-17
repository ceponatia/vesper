# Successor world engine — technical specification

Status: **draft 2026-07-16**

Companion to [engine.plan.md](engine.plan.md). Read the plan for sequencing, costs,
experiments, and migration gates. This document defines the intended contracts and
invariants of the successor. It is deliberately independent of the deprecated session
engine's object model.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. Open product rulings are explicitly marked; an implementation must not hide
one inside prompt wording or a parser heuristic.

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

| Term | Meaning |
| --- | --- |
| World type | Authored rules, packages, calendars, content constraints, and defaults |
| World | One instantiated setting shared by one or more timelines |
| Branch | One ordered, causally isolated timeline of a world |
| Story time | Simulated time advanced only by committed game operations |
| Sequence | Total event order within a branch |
| Command | An authorized request to attempt a state transition |
| Domain event | An immutable fact that the engine resolved as having occurred |
| Scheduled trigger | A durable request to evaluate something at a future story time |
| Projection | Rebuildable current state derived from events |
| Viewpoint | Actor or authorized observer for whom context is compiled |
| Observation | Evidence available to a viewpoint through a channel |
| Assertion | A proposition claimed by a source; not necessarily true |
| Belief | A holder's confidence in an assertion or proposition |
| Engagement | A conversation or interaction that claims attention and may be physical or remote |
| NarrativeCut | Immutable, perspective-safe input describing one committed presentation interval |
| Armed effect | A bounded semantic effect that commits only if narration actually enacts it |
| Soft canon | Scoped, revisable detail admitted without changing hard physical state |
| LOD | Level of detail for simulation work or inference attention |

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

| Component | Required responsibility |
| --- | --- |
| Command gateway | Authenticate principal, validate envelope, enforce idempotency and controller grants |
| Branch sequencer | Serialize accepted operations per branch and assign sequence numbers |
| Pure kernel | Validate domain preconditions and resolve commands into events |
| Scheduler | Evaluate durable triggers and analytically advance story time |
| Core projector | Update invariant-critical query state in the command transaction |
| Async projector | Build search, analytics, summaries, and embeddings through the outbox |
| Live-scene arbiter | Reconcile an engagement with due and upcoming world pressure |
| NPC policy | Choose routine legal actions deterministically |
| Deliberator | Rarely choose among a bounded legal candidate set |
| Perception engine | Compute observation eligibility and evidence |
| Knowledge ledger | Store assertions, beliefs, provenance, contradictions, and supersedence |
| Context compiler | Produce one redacted NarrativeCut |
| Narrator | Render prose from that cut |
| Presentation auditor | Flag impossible or leaked claims; never mutate truth |
| Memory indexer | Represent eligible records for semantic recall |

## 5. Identity model

All identities MUST be opaque, stable, and independent of display names.

| Identity | Purpose |
| --- | --- |
| WorldTypeId | Versioned package and authored-rule selection |
| WorldId | Instantiated setting |
| WorldBranchId | Causally isolated timeline |
| CharacterTemplateId | Reusable authored character definition |
| WorldCharacterId | One instantiated character body and life in one world |
| PlayerCharacterId | A WorldCharacter role controlled by a player principal |
| LocationId | Stable place |
| ZoneId | Sub-area with its own access, privacy, and occupancy |
| LinkId | Traversable connection between zones or locations |
| ItemId | Stable material object or fungible lot |
| ActionDefinitionId | Versioned action contract |
| ActivityInstanceId | One attempted action over time |
| CommitmentId | One obligation, promise, appointment, reservation, or routine |
| JourneyId | One in-transit movement |
| EngagementId | One conversation or interaction |
| EventId | Globally unique event identifier |

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

| Principal kind | Normal authority |
| --- | --- |
| player | Controlled player actors and explicit player-owned UI operations |
| npc_policy | One NPC actor under deterministic policy |
| npc_deliberator | Selection among candidate IDs already legal for one NPC |
| system | Due triggers, mechanical consequences, projection repair |
| director | Future pressures, opportunities, casting proposals |
| storyteller | Explicit world-type-defined privileged operations |
| migration | Versioned, audited data conversion |

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

| Family | Examples |
| --- | --- |
| world | WorldCreated, BranchForked, RulesetAdopted |
| identity | CharacterInstantiated, ItemInstantiated, LocationInstantiated |
| commitment | CommitmentCreated, CommitmentUpdated, PressureRaised, CommitmentKept, CommitmentLate, CommitmentMissed, CommitmentCancelled |
| activity | ActivityQueued, ActivityStarted, ActivityPaused, ActivityInterrupted, ActivityResumed, ActivityCompleted, ActivityFailed, ActivityCancelled |
| movement | JourneyPlanned, ActorDeparted, JourneyDelayed, JourneyInterrupted, ActorArrived, JourneyAbandoned |
| access | AccessGranted, AccessRevoked, EntryAttempted, EntryDenied, ZoneEntered, ZoneLeft |
| engagement | EngagementOpened, EngagementWindingDown, EngagementInterrupted, EngagementEnded, PressureAcknowledged |
| material | ItemTransferred, ItemConsumed, ResourceReserved, ResourceReleased, ItemDamaged |
| body | BodyThresholdCrossed, ConditionAcquired, ConditionChanged, ConditionResolved, BodySourceApplied |
| knowledge | ObservationRecorded, AssertionMade, DisclosureMade, BeliefUpdated, AssertionContradicted, AssertionSuperseded |
| relationship | RelationshipEvidenceRecorded, PromiseOffered, PromiseAccepted, BoundaryExpressed, FavorIncurred |
| privileged | StorytellerRelocation, StorytellerRetcon, MigrationApplied |

Names may change, but distinct causal concepts MUST NOT be collapsed into a generic
StateChanged event.

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

| Table | Key fields and purpose |
| --- | --- |
| sim_worlds | world ID, world type, seed, ruleset version, status |
| sim_branches | branch ID, world ID, parent branch, fork sequence, head sequence, version, story second |
| sim_commands | envelope, idempotency key, status, result or rejection |
| sim_events | branch sequence, envelope columns, schema-versioned payload |
| sim_scheduled_triggers | due story second, priority, kind, target, payload, state, unique logical key |
| sim_outbox | sequence range, consumer kind, payload, attempts, next retry |
| sim_snapshots | branch, sequence, projection kind, schema version, checksum, payload |

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

## 13. Physical world

### 13.1 Topology

    type Location = {
      id: string;
      worldId: string;
      kind: string;
      coordinate?: { x: number; y: number };
      defaultAccessPolicy: AccessPolicy;
    };

    type Zone = {
      id: string;
      locationId: string;
      kind: string;
      parentZoneId?: string;
      occupancyLimit?: number;
      privacyPolicy: PrivacyPolicy;
    };

    type Link = {
      id: string;
      fromZoneId: string;
      toZoneId: string;
      modes: TravelMode[];
      minimumDurationSeconds: number;
      schedule?: AccessWindow[];
      accessPolicy: AccessPolicy;
      state: "open" | "closed" | "locked" | "blocked";
    };

Malformed, missing, or unknown private access data MUST NOT degrade to public. It must
fail closed, emit a diagnostic, and offer a safe boundary such as the exterior or
doorstep.

### 13.2 Physical locus

    type PhysicalLocus =
      | {
          kind: "at";
          actorId: string;
          locationId: string;
          zoneId: string;
          since: number;
        }
      | {
          kind: "in_transit";
          actorId: string;
          journeyId: string;
          linkId: string;
          enteredAt: number;
          earliestExitAt: number;
        };

An in-transit actor is not simultaneously at the origin or destination. Presentation may
describe a vehicle or route zone, but projection queries must return one locus.

### 13.3 Route planning

A route result MUST include:

- ordered links;
- travel mode;
- minimum duration;
- expected duration and uncertainty;
- access requirements;
- known hazards or closures at planning time;
- route derivation version.

Hop count alone is not a sufficient travel metric. A planned route may later be delayed
or invalidated, but a new event must explain the change.

## 14. Access, privacy, consent, and entry

Access is layered:

1. route passability;
2. property access;
3. zone access;
4. current occupancy and privacy;
5. interpersonal consent for the proposed interaction;
6. perspective entitlement to the reason.

Passing one layer does not imply the next.

    type AccessGrant = {
      id: string;
      branchId: string;
      granteeActorId: string;
      issuerActorId?: string;
      scope: {
        locationId: string;
        zoneIds?: string[];
      };
      basis: "owner" | "resident" | "employee" | "invitation" | "key" | "public";
      permissions: ("enter" | "remain" | "bring_guest" | "use_item")[];
      validFrom: number;
      validUntil?: number;
      revocable: boolean;
      revokedAt?: number;
    };

An AccessGrant is not blanket consent to conversation, touch, intimacy, or interruption.
Those are action preconditions.

### 14.1 Player movement

- “I go to Mara's house” proposes travel to the nearest legal arrival zone, normally the
  exterior or doorstep.
- Entry requires a separate validated action.
- A bedroom, bathroom, shower, locked office, or staff area requires current zone
  authority.
- If entry is denied, the engine returns legal alternatives such as knock, call, wait,
  leave, or—if enabled—attempt trespass.

### 14.2 NPC movement

- “Mara comes here” cannot issue MoveActor for Mara.
- It may issue InviteActor, RequestVisit, CallActor, or AskActorToLeave, depending on
  language and channel.
- Mara's controller evaluates the request against locus, activity, route, commitments,
  relationship, safety, and preference.
- Acceptance creates preparation, departure, journey, and arrival events. It never
  creates instant co-location.

### 14.3 Trespass and forced entry

If the world type permits transgressive attempts, they MUST be explicit activities with:

- duration;
- noise;
- tools or skill;
- lock and obstacle state;
- witnesses and observation channels;
- interruption;
- legal, social, and safety consequences.

If the product disallows them, reject at admission with a public rule reason. Do not
pretend the door was physically impossible solely to mask a product restriction.

### 14.4 Failure presentation

    type FailurePresentation = {
      code: string;
      publicReason: string;
      publicEvidence: string[];
      legalAlternatives: string[];
      privateCauseEventId?: string;
    };

privateCauseEventId is for audit and authorized systems only. The narrator receives no
private cause unless the viewpoint could perceive or know it. “She doesn't answer” may be
legal; “she doesn't answer because she is naked in the shower” is not legal without
evidence.

    type PublicFailurePresentation = Omit<
      FailurePresentation,
      "privateCauseEventId"
    >;

## 15. Commitments and temporal pressure

### 15.1 Commitment

    type Commitment = {
      id: string;
      actorId: string;
      kind: "shift" | "appointment" | "promise" | "reservation" | "routine";
      sourceId?: string;
      destinationId?: string;
      window: {
        earliestArrival?: number;
        targetArrival?: number;
        latestArrival?: number;
      };
      expectedDurationSeconds?: number;
      priority: number;
      flexibility: "soft" | "negotiable" | "firm" | "hard";
      preparationSeconds: number;
      reliabilityBufferSeconds: number;
      noticeLeadSeconds: number;
      status:
        | "planned"
        | "noticed"
        | "accepted"
        | "declined"
        | "in_progress"
        | "kept"
        | "late"
        | "missed"
        | "cancelled";
      knowledgeSourceId: string;
    };

knowledgeSourceId proves why the actor may act on the commitment. A player-facing
calendar entry is not automatically NPC memory. It must reference an eligible authored
memory, observation, assertion, or belief. When pressure is evaluated, that source must
still be available to the actor or a new cue must be perceived.

### 15.2 Pressure

    type TemporalPressure = {
      id: string;
      actorId: string;
      source: {
        kind: "commitment" | "need" | "hazard" | "access_window";
        id: string;
      };
      noticeAt: number;
      decideBy: number;
      actBy: number;
      severity: "background" | "salient" | "urgent" | "hard";
      legalResponseIds: string[];
      acknowledgedAt?: number;
      resolvedAt?: number;
    };

For a destination commitment:

    latestDeparture =
      latestArrival
      - minimumRouteDuration
      - preparationDuration
      - reliabilityBuffer

noticeAt precedes decideBy, which is no later than actBy. actBy is normally
latestDeparture. The route and preparation assumptions MUST be recomputed when a material
input changes.

### 15.3 Four o'clock shift behavior

For a 4pm latest arrival:

1. the commitment enters the look-ahead horizon;
2. a pressure becomes salient only if the actor knows it;
3. the NPC may warn the player, prepare, negotiate, decline, call work, or accept
   lateness;
4. choosing to leave starts an activity and then a journey;
5. the journey consumes story time and may be delayed;
6. arrival, late arrival, cancellation, or missed shift emits a consequence event.

The NPC does not vanish at 4pm. If the player asks the NPC to stay, the request affects
the decision utility but does not erase travel time or the commitment. Acknowledged
pressure MUST not be repeated every turn unless its severity or assumptions change.

### 15.4 Commitment state transitions

| From | Legal next states |
| --- | --- |
| planned | noticed, accepted, declined, cancelled, missed |
| noticed | accepted, declined, cancelled, missed |
| accepted | in_progress, cancelled, missed |
| declined | cancelled, accepted if renegotiated |
| in_progress | kept, late, missed, cancelled |
| kept | terminal |
| late | kept, missed, terminal consequence |
| missed | terminal or explicitly repaired by a new commitment |
| cancelled | terminal |

History is not rewritten when a commitment is repaired. Create a new commitment or
explicit remediation event.

## 16. Actions and activities

### 16.1 Action definition

    type ActionDefinition = {
      id: string;
      version: number;
      controllerKinds: PrincipalKind[];
      duration: DurationRule;
      preconditions: PredicateDefinition[];
      requiredClaims: ClaimDefinition[];
      resourceCosts: ResourceCostDefinition[];
      interruptibility: "free" | "pausable" | "abort_only" | "locked";
      privacy: PrivacyRequirement;
      consent: ConsentRequirement;
      startEffects: EffectDefinition[];
      completionEffects: EffectDefinition[];
      failureEffects: EffectDefinition[];
      observationProfile: ObservationProfile;
    };

Aliases and labels belong to language interpretation. They do not define legality.
requiredTier or similar authored fields MUST be enforced or removed; inert contract
fields are not acceptable.

### 16.2 Activity instance

    type ActivityInstance = {
      id: string;
      actorIds: string[];
      actionDefinitionId: string;
      phase:
        | "queued"
        | "preparing"
        | "active"
        | "paused"
        | "interrupted"
        | "completed"
        | "failed"
        | "cancelled";
      startedAt?: number;
      expectedCompleteAt?: number;
      progressFixedPoint: number;
      attentionClaims: AttentionClaim[];
      exclusiveClaims: ExclusiveClaim[];
      privacy: PrivacyRequirement;
      sourceCommandId: string;
    };

### 16.3 Activity transitions

| From | Legal next phases |
| --- | --- |
| queued | preparing, active, cancelled, failed |
| preparing | active, interrupted, cancelled, failed |
| active | paused, interrupted, completed, failed, cancelled |
| paused | active, interrupted, cancelled, failed |
| interrupted | active, cancelled, failed |
| completed | terminal |
| failed | terminal |
| cancelled | terminal |

Starting an activity atomically acquires its exclusive claims. Completion, failure, and
cancellation release them. A stale or crashed worker MUST NOT leave claims orphaned;
claims are projected from activity state and repairable from events.

### 16.4 Compatibility examples

Compatibility is channel- and action-specific:

| Current activity | Co-present conversation | Text or call | Normal policy |
| --- | --- | --- | --- |
| walking | usually allowed with reduced attention | allowed | continue route |
| cooking | allowed unless hazardous phase | usually allowed | may pause at boundary |
| desk work | limited | limited | pressure depends on role |
| driving | conversation with passenger may be limited | text forbidden; hands-free call policy-specific | safety dominates |
| showering | only with legal access and consent | delivery may occur; response optional | privacy dominates |
| toileting/changing | normally unavailable | delivery may occur; response optional | privacy dominates |
| sleeping | unavailable until perceived wake cue | message may queue unread | sleep continues |
| intimate activity | participants and consent only | interruption policy-specific | privacy and consent dominate |

“Message delivered” and “actor perceived message” are different events.

## 17. Journeys

    type Journey = {
      id: string;
      actorIds: string[];
      originZoneId: string;
      destinationZoneId: string;
      routeLinkIds: string[];
      travelMode: TravelMode;
      departedAt?: number;
      earliestArrivalAt: number;
      expectedArrivalAt: number;
      status: "planned" | "active" | "delayed" | "interrupted" | "arrived" | "abandoned";
      currentLinkIndex: number;
      routeDerivationVersion: string;
    };

### 17.1 Journey transitions

| From | Legal next states |
| --- | --- |
| planned | active, abandoned |
| active | delayed, interrupted, arrived, abandoned |
| delayed | active, interrupted, arrived, abandoned |
| interrupted | active, abandoned |
| arrived | terminal |
| abandoned | terminal |

Journey progress SHOULD be analytical. Persist departure, link or mode changes when they
matter, delay, interruption, and arrival—not a row per minute.

An arrival event MUST NOT occur before earliestArrivalAt unless a new causal event changes
the route or travel mode. Repartitioning a skip MUST not change arrival.

## 18. Engagements and live-scene arbitration

### 18.1 Engagement

    type Engagement = {
      id: string;
      participantIds: string[];
      channel: "co_present" | "text" | "voice" | "video" | "mixed";
      locationId?: string;
      zoneId?: string;
      state: "opening" | "active" | "winding_down" | "ended" | "interrupted";
      openedAt: number;
      attentionClaims: AttentionClaim[];
      acknowledgedPressureIds: string[];
      branchVersion: number;
    };

A co-present engagement requires compatible physical loci. Remote engagement requires
channel access and message delivery but not co-location.

### 18.2 Engagement transitions

| From | Legal next states |
| --- | --- |
| opening | active, ended, interrupted |
| active | winding_down, ended, interrupted |
| winding_down | active, ended, interrupted |
| interrupted | active, ended |
| ended | terminal |

Ending an Engagement releases its attention claims but does not move any participant.
Winding down is a playable transition, not a promise that the NPC remains until the
player agrees.

### 18.3 Reconciliation algorithm

Before any narrator response streams:

1. **Admission.** Authenticate the player, resolve controlled actor, engagement, and
   branch. Parse the message into proposed speech and action intents without mutating
   state.
2. **Due work.** Reconcile scheduled triggers through the turn start.
3. **Turn span.** Resolve explicit actions, wait, travel, or configured dialogue duration
   into a proposed story-time interval.
4. **Look-ahead.** Query pressures that become relevant through the interval plus the
   world-type horizon.
5. **Candidate construction.** Enumerate only legal NPC responses, interruptions,
   warnings, preparations, departures, and deferrals.
6. **Choice.** Use deterministic policy unless the high-LOD close-choice rule permits one
   deliberator call.
7. **Commit.** Submit commands with optimistic branch version. Commit hard events,
   activities, journeys, observations, and consequences.
8. **Cut.** Compile one immutable NarrativeCut from the resulting sequence boundary.
9. **Render.** Stream narrator prose from that cut.
10. **Confirm.** Commit only ArmedEffects explicitly enacted by the structured narrator
    result.
11. **Index.** Through the outbox, create eligible memory representations from committed
    events, observations, assertions, and dialogue.

The narrator does not decide after the fact that a schedule was kept, that an NPC
teleported, or that an item changed hands.

### 18.4 External events during narration

The cut records branch version V and maximum sequence S. An event committed during
streaming has sequence greater than S. It is not retroactively inserted into the prose.
The next turn begins by reconciling it.

If the external event competes for a body or claim already reserved in the cut, the
command transaction must have rejected one operation before either cut was compiled.

### 18.5 Narrator failure

Hard outcomes already committed for a cut remain authoritative. A narrator timeout or
invalid response creates a presentation failure, not a world rollback. The system may:

- retry the same model with the same cut;
- use a smaller-model fallback;
- render a deterministic minimal transition;
- expose a retry to the player.

It MUST NOT rerun simulation implicitly.

Whether a failed turn remains visible and whether its story-time advance is exposed are
open product rulings, but state cannot be partially reverted.

## 19. NPC policy and deliberation

### 19.1 Legal candidate generation

The kernel or policy layer generates candidate actions after checking:

- controller authority;
- physical locus and route;
- active claims and activity compatibility;
- access, privacy, and consent;
- resources and body capability;
- actor knowledge and perceived cues;
- commitments and deadlines;
- world-type safety and content rules.

### 19.2 Deterministic utility

Routine policy SHOULD score legal candidates from versioned factors such as:

- goal progress;
- commitment priority and lateness risk;
- physiological need;
- relationship and promise evidence;
- habit and role;
- safety and legal risk;
- effort, time, and resource cost;
- interruption cost;
- bounded seeded variation.

The score breakdown MAY be retained as an audit explanation. It MUST NOT contain or claim
to expose a model's private chain of thought.

### 19.3 Deliberator admission

An LLM deliberator MAY run only if:

- the actor is high inference LOD;
- at least two legal candidates remain;
- their deterministic score gap is below a configured threshold;
- the outcome is narratively or materially consequential;
- the branch has model budget;
- a deterministic fallback exists.

The prompt contains opaque candidate IDs and bounded evidence. The response may select
one ID and provide a short user-invisible rationale summary. Any new action text is
ignored.

## 20. Perception and observation

Perception computes whether an event produces evidence for a viewpoint. It considers:

- physical locus and topology;
- sight, sound, touch, smell, device, and social channels;
- lighting, cover, distance, barriers, and attention;
- activity and impairment;
- concealment and privacy;
- event salience;
- communication delivery and authentication.

    type Observation = {
      id: string;
      branchId: string;
      sourceEventId: string;
      witnessActorId: string;
      storySecond: number;
      channel: string;
      evidenceClass: string;
      confidenceFixedPoint: number;
      detailTier: number;
      derivationVersion: string;
    };

An event may have zero, one, or many observations. witnessedBy or equivalent eligibility
must be consumed by queries, not merely written.

Not every transient sensory pixel needs a durable row. The engine SHOULD persist
observations that affect belief, memory, action choice, relationships, evidence, or
narration continuity.

## 21. Assertions, beliefs, gossip, and relationships

### 21.1 Assertion

    type Assertion = {
      id: string;
      branchId: string;
      propositionKey: string;
      subjectIds: string[];
      claimedValue: unknown;
      sourceActorId?: string;
      sourceEventId?: string;
      assertedAt: number;
      validFrom?: number;
      validUntil?: number;
      status: "active" | "contradicted" | "superseded" | "retracted";
    };

An assertion may be false. canon false is not a belief model.

### 21.2 Belief

    type Belief = {
      id: string;
      branchId: string;
      holderActorId: string;
      assertionId: string;
      confidenceFixedPoint: number;
      basisObservationIds: string[];
      learnedFromActorIds: string[];
      believedFrom: number;
      believedUntil?: number;
      status: "active" | "doubted" | "rejected" | "superseded";
    };

Gossip is DisclosureMade plus the listener's observation and belief update. Each hop
preserves provenance and may alter confidence or content through an explicit event.

### 21.3 Relationship ledger

Relationship state SHOULD be derived from typed evidence:

- promises made, kept, missed, or repaired;
- boundaries stated, respected, or violated;
- help, neglect, betrayal, disclosure, affection, conflict;
- shared activities and observed conduct;
- authored priors and explicit relationship changes.

The current relationship read may be a projection. The evidence ledger is the causal
record. Prose summaries may help narration but cannot be the only source.

## 22. NarrativeCut

### 22.1 Contract

    type NarrativeCut = {
      id: string;
      worldId: string;
      branchId: string;
      branchVersion: number;
      fromSequence: number;
      throughSequence: number;
      fromStorySecond: number;
      throughStorySecond: number;
      viewpointActorId: string;
      engagementId: string;
      currentLoci: PerspectiveSafeLocus[];
      currentActivities: PerspectiveSafeActivity[];
      mustEnact: NarrativeBeat[];
      perceptibleNow: EvidenceView[];
      speakerBeliefs: BeliefView[];
      relevantPressures: PressureView[];
      allowedTransitions: NarrativeBeat[];
      forbiddenClaims: ForbiddenClaim[];
      failurePresentations: PublicFailurePresentation[];
      creativeLicenses: CreativeLicense[];
      armedEffects: ArmedEffect[];
      provenance: ProvenanceRef[];
    };

The compiler MUST omit private fields rather than asking the narrator not to mention
them. Prompt instructions are defense in depth, not the privacy boundary.

mustEnact contains only beats relevant to this response. It is not a dump of every due
event. allowedTransitions are already-resolved beats the narrator may portray, not
permission to choose new hard outcomes.

### 22.2 Forbidden claims

ForbiddenClaim SHOULD cover:

- actor at an impossible place;
- travel without a journey;
- possession or consumption without an event;
- knowledge without belief or evidence;
- access without a grant or successful explicit attempt;
- action incompatible with activity or body claims;
- speech or action attributed to the player's actor without player authorization;
- disclosure of a private denial cause;
- future event stated as already completed.

### 22.3 Stability

A NarrativeCut is immutable and addressable. Recompiling the same cut ID must either
produce the same canonical content hash or fail with a version diagnostic. Model prompt
formatting may evolve, but the semantic cut remains inspectable.

## 23. Narrator and effects

### 23.1 Narrator output

The narrator returns:

    type NarratorResult = {
      prose: string;
      enactedArmedEffectIds: string[];
      proposedSoftCanon: SoftCanonProposal[];
      diagnostics?: string[];
    };

All fields cross a trust boundary and use resilient parsing with safe defaults.

The narrator MAY choose phrasing, sensory focus, gesture, pacing, subtext, and bounded
licensed details. It MUST enact required beats and MUST NOT assert forbidden claims.

### 23.2 Hard effects

Movement, item transfer, body injury, resource consumption, access, and activity
completion are resolved before narration. They do not wait for prose confirmation.

If prose omits a required hard beat, the presentation auditor may request a rerender or
add a deterministic bridge. It cannot undo the event.

### 23.3 Armed effects

ArmedEffect is for a semantic outcome that only exists if expressed:

- promise offered or accepted;
- invitation spoken;
- disclosure made;
- warning communicated;
- boundary expressed;
- question asked;
- apology delivered.

    type ArmedEffect = {
      id: string;
      cutId: string;
      effectType: string;
      actorId: string;
      targetActorIds: string[];
      payload: unknown;
      expiresAfterCut: boolean;
      preconditionVersion: number;
    };

After narration, each enacted ID is revalidated against cut, actor, and branch version.
Unlisted IDs are ignored. Unenacted effects expire. ArmedEffect MUST NOT be used to
smuggle physical outcomes back into narrator authority.

### 23.4 Soft canon

    type SoftCanonProposal = {
      key: string;
      value: unknown;
      scope: "scene" | "relationship" | "character" | "location" | "world";
      confidenceFixedPoint: number;
      validUntil?: number;
      sourceCutId: string;
    };

Soft canon must pass conflict, privacy, scope, duplication, and world-type checks. It may
be rejected without regenerating prose. Repeatedly useful soft canon SHOULD be promoted
through an explicit authored or domain contract, not allowed to become accidental hard
state.

Post-turn extraction is limited to information deterministic code could not know before
the response: episode compression, semantic propositions actually spoken, and permitted
soft-canon proposals. An extractor MUST NOT decide completed movement, item transfer,
body effects, commitment outcomes, access, or witness eligibility.

## 24. RAG and memory

### 24.1 Eligibility before similarity

The retrieval pipeline:

1. authenticate world, branch, principal, and viewpoint;
2. filter by source kind, branch, sequence, validity interval, supersedence, and privacy;
3. require viewpoint knowledge, observation, authorized authored lore, or explicit
   public scope;
4. apply structured relevance filters;
5. run vector or lexical ranking inside the eligible set;
6. diversify and fit the context budget;
7. return provenance and epistemic label with every result.

Vector similarity MUST NOT determine witness, truth, current validity, or access.

### 24.2 Source classes

Eligible source classes include:

- authored lore explicitly available to the viewpoint;
- observed events;
- active assertions and beliefs;
- dialogue episodes the actor participated in or learned about;
- relationship evidence;
- public world records;
- bounded soft canon.

Projection rows such as “current location” should normally enter the cut directly, not be
embedded as a competing memory.

### 24.3 Indexing

Indexing runs from the outbox after authoritative commit. Each document includes:

- source ID and kind;
- branch and sequence interval;
- viewpoint or visibility eligibility;
- valid and superseded intervals;
- embedding model and document schema versions;
- redacted text produced from authorized source data.

If indexing fails, world simulation continues. Recall quality degrades, and diagnostics
must expose lag. A model call must never see a less-restricted document because a more
specific index was unavailable.

## 25. Bodies, meters, conditions, and modifiers

### 25.1 Three layers

1. **Substrate:** stored body fact such as reserve, arousal, freshness, condition, or
   capability.
2. **Resolution:** rates, sources, couplings, modifiers, thresholds, and event outcomes.
3. **Read:** pure, total, contextual, perception-gated description or UI value.

Narrators receive reads and relevant causal events, never raw meters by default.

### 25.2 Analytical integration

A continuously changing scalar stores:

- value in fixed-point units;
- lastIntegratedAt;
- base rate;
- active modifier IDs;
- next material threshold.

When queried or when a related trigger is due, integrate piecewise across modifier
boundaries. Schedule only the next material threshold or modifier expiry. Do not tick
every minute.

### 25.3 Modifier engine

All temporary effects SHOULD use one modifier contract:

- source event;
- target path;
- operation such as add, multiply, clamp, override, or rate change;
- stacking group and priority;
- valid interval;
- conditions;
- visibility and provenance.

Overlay-specific paths that bypass ordering or expiry SHOULD be removed.

### 25.4 Couplings

Cross-system effects use an explicit resolver graph. Examples:

- sleep reserve and circadian phase influence energy read;
- illness changes energy rate and capability;
- exertion changes hygiene and fatigue;
- bathing changes freshness and may affect wardrobe;
- stress affects sleep onset but does not directly rewrite history.

Cycles require a declared solution strategy and iteration bound. Hidden mutual writes
between post-turn agents are forbidden.

### 25.5 Rhythm and window crossing

Schedule-driven body support is a current-lane migration aid, not the successor's final
action history.

The owner-approved rhythm body behavior is window crossing: landing at 6am may not cross
the same routine window as landing at 8am. It MUST NOT blanket-restore meals, hygiene, or
sleep. The arrival-covering rhythm outfit behavior is a different function and does not
prove the body algorithm.

inferScheduleKind is a temporary migration adapter. New schedule data MUST use a typed
kind. Unknown text MUST remain unknown and MUST NOT cause hard body or location effects.

## 26. Materials, inventory, and resources

Every material object has one holding locus:

- held by an actor;
- worn in an equipment or body slot;
- inside a container;
- at a zone;
- consumed, destroyed, or lost by an event.

Transfers validate source holding, destination capacity, access, actor capability, and
exclusive reservation. An item cannot be in two containers.

Fungible resources MAY use lots and quantities. Quantities that represent conservation
must use fixed-point integers and transactionally balance.

Low-detail actors MAY have aggregate means, household stock, or budget envelopes. When an
explicit item becomes narratively relevant, promotion must consume an aggregate allowance
and instantiate the item through a recorded event. It cannot appear solely because the
narrator mentioned it.

## 27. Simulation LOD

### 27.1 Levels

| Level | Resolution |
| --- | --- |
| exact | Explicit activities, claims, resources, routes, and observations |
| event | Resolve named actors only at material transitions |
| aggregate | Resolve population or institution flows and sampled outcomes |
| dormant | Perform no work until an incoming dependency or promotion trigger |

LOD is a performance choice, not permission to violate invariants.

### 27.2 Promotion

Promotion from aggregate to exact MUST:

1. identify aggregate facts already committed;
2. reserve conserved quantities;
3. sample missing detail with a named deterministic stream;
4. emit a MaterializedFromAggregate or equivalent event;
5. preserve known observations, commitments, relationships, and causal constraints.

The engine must not materialize a detail that contradicts something already observed.

### 27.3 Demotion

Demotion may compact unobserved routine detail into a summary projection, but immutable
material events remain. Active contested claims, named scarce items, unresolved
commitments, and near-boundary hazards prevent demotion.

## 28. Inference LOD and model budget

Simulation LOD and inference LOD MUST be independent. A physically exact activity may
need no model call, while an aggregate political decision may justify one deliberation.

The default turn has:

- deterministic input admission;
- deterministic world reconciliation;
- deterministic context compilation;
- one narrator call;
- zero routine state-agent calls.

Optional calls require an explicit budget and fallback. Background agents MUST NOT fan
out once per NPC or once per meter. Batch classifiers, deterministic reducers, and outbox
workers are preferred.

## 29. Retakes, rerenders, branches, and replay

### 29.1 Definitions

- **Rerender:** new prose for the same NarrativeCut. No new commands, events, observations,
  beliefs, milestones, embeddings, or body changes.
- **Retake:** fork from the pre-turn sequence and resolve a new outcome on the child
  branch.
- **Reach-back edit:** always a branch fork.
- **Projection rebuild:** replay the same branch events; not a retake.

The UI must distinguish these operations.

### 29.2 Current-lane bridge

Until the successor owns chat turns, group regenerate must snapshot and restore every
member's mutable pre-drift state. Primary-only snapshots violate rollback integrity.
Reach-back reruns that cannot restore all causal state must be rejected or implemented as
branches.

### 29.3 Branch fork

A fork records:

- parent branch ID;
- fork sequence and story second;
- parent ruleset and event schema versions;
- initiating principal and reason;
- inherited snapshot checksum.

Events after the fork are never shared by mutable reference. Memory and embedding queries
must include branch ancestry rules and sequence bounds.

## 30. API boundaries

The successor SHOULD expose intent-oriented APIs:

- submitCommand;
- advanceTo;
- getBranchState;
- getActorPerspective;
- openEngagement;
- prepareTurn;
- getNarrativeCut;
- confirmNarratorResult;
- rerenderCut;
- forkForRetake;
- rebuildProjection;
- explainEvent;
- queryEligibleMemory.

No public API should expose “set NPC location,” “mark schedule kept,” or “write current
meter” without a privileged migration/storyteller capability.

## 31. Package boundaries

A recommended TypeScript organization:

| Package | Contents |
| --- | --- |
| engine-contracts | Branded IDs, schemas, commands, events, projection views |
| engine-kernel | Pure validators, resolvers, rates, routes, policies |
| engine-runtime | Transactions, sequencer, scheduler, outbox |
| engine-projections | Core and async projectors, replay |
| engine-knowledge | Observation, assertion, belief, relationship, eligibility |
| engine-narrative | NarrativeCut compiler, ArmedEffect, auditor |
| engine-adapters | Current chat, authored schedule, legacy import |

The pure kernel MUST have no database, network, file, process clock, model, or global
random dependency.

## 32. TypeScript numeric and performance contract

TypeScript is acceptable if:

- story time and causal quantities use validated integers;
- deterministic collections are explicitly sorted;
- maps and sets do not leak insertion-order accidents into rules;
- schema parsing occurs at every trust boundary;
- the kernel avoids hidden Date, Math.random, locale, and floating-rounding behavior;
- property and replay tests run in CI;
- representative benchmarks track route, scheduler, projection, and catch-up costs.

A native rewrite is considered only after profiling identifies a stable pure kernel that
materially exceeds its budget. Candidate boundaries include route search, large
population flow integration, and spatial indexing. Database wait, model latency, or
poor query design are not fixed by Rust.

## 33. Resilience and diagnostics

All trust boundaries use resilient parsing and typed fallbacks:

- invalid model output selects deterministic fallback;
- unknown authored enum stays unknown;
- malformed private access fails closed;
- stale command returns conflict;
- duplicate command returns original result;
- failed async projection retries idempotently;
- failed narrator render retries the same cut;
- impossible event payload quarantines the branch and produces an operator diagnostic.

Diagnostics MUST include branch, sequence, command, event, derivation, and ruleset
identifiers where available. User-facing failure text must be perspective-safe.

The system SHOULD retain causal explanation records:

- which predicate rejected a command;
- which candidate scores led to deterministic policy;
- which trigger produced an event;
- which observations supported a belief;
- which provenance rows entered a cut.

Do not log secrets, private model reasoning, or unredacted prompts across authorization
boundaries.

## 34. Security and abuse model

### 34.1 Untrusted inputs

Treat as untrusted:

- player prose;
- narrator and agent output;
- imported character and schedule prose;
- RAG documents;
- soft canon;
- migration files;
- webhook or external-world inputs.

Each crosses schemas and capability checks before causing state.

### 34.2 Prompt injection

Retrieved text is quoted data, not instruction. The context compiler labels source class
and provenance. Authored or remembered text cannot grant capabilities, change viewpoint,
or ask the model to reveal private context.

### 34.3 Cross-world and cross-branch access

Every query joins through authorized world and branch identity. An opaque ID from another
world is not sufficient authority. Caches and embeddings must include tenancy and branch
keys.

### 34.4 Unsupported player assertions

Text that claims an impossible fact—“Mara is suddenly beside me,” “I already have her
key,” or “the door was open”—must be classified as speech, imagination, attempted
storyteller action, or unsupported action proposal. It cannot mutate projections.

### 34.5 Privacy

The compiler redacts before model invocation. Denials use FailurePresentation. Audit
systems may retain private causes but normal prompts, logs, embeddings, and UI errors may
not.

## 35. Observability

### 35.1 Per-command trace

Record:

- admission and authorization result;
- starting and ending branch version;
- due-trigger count;
- kernel duration;
- projection duration;
- event count and types;
- outbox count;
- selected policy candidate;
- model calls, tokens, and latency;
- NarrativeCut ID and hash;
- retries, degraded paths, and rejection code.

### 35.2 System metrics

- command p50 and p95 by type;
- narrator p50 and p95;
- branch lock wait;
- scheduler queue depth and overdue age;
- triggers processed per story day;
- projection lag and rebuild time;
- outbox retry age;
- event and snapshot growth;
- memory eligibility set size and top-k latency;
- model calls and tokens per turn and per actor-day;
- deterministic fallback frequency;
- perspective leak and impossible-claim test failures.

### 35.3 Explainability

An operator should be able to ask:

- Why is this actor here?
- Why did this NPC leave?
- Why was entry denied?
- Why does this actor believe this?
- Why did this commitment become late?
- Why did this memory enter the prompt?
- What changed between two branch sequences?

Answers must reference events, observations, ruleset versions, and public/private
boundaries.

## 36. Testing

### 36.1 Unit tests

- every command validator;
- every legal and illegal state transition;
- route and access predicates;
- modifier ordering and expiry;
- policy score and tie-breaking;
- NarrativeCut redaction;
- ArmedEffect confirmation;
- memory eligibility.

### 36.2 Property tests

- replay determinism;
- skip partition invariance;
- one physical locus;
- one item holding;
- resource conservation;
- no overlapping exclusive claims;
- idempotent retries;
- branch isolation;
- projection rebuild equality;
- no event before causal precondition;
- no arrival before lower-bound duration.

### 36.3 Integration tests

- command transaction crash before and after commit;
- scheduler retry;
- outbox duplicate delivery;
- stale branch version;
- concurrent engagement reservation;
- narrator timeout and same-cut retry;
- embedding failure with safe degradation;
- ruleset and event upcast.

### 36.4 Live-scene scenario tests

| Scenario | Required result |
| --- | --- |
| 4pm shift | advance warning, decision, departure, travel, arrival or explicit consequence |
| player asks NPC to stay | NPC choice changes; commitment and travel time remain |
| sleep | actor unavailable until a legal wake cue or choice |
| shower | no teleport or private-cause leak; channel behavior follows policy |
| summon attempt | request is routed to NPC controller; no instant co-location |
| doorstep and barge-in | exterior arrival, separate entry check, explicit trespass if allowed |
| competing chats | one physical body reservation wins; other request gets legal alternative |
| route delay | arrival time changes through a causal event |
| impossible narrator prose | auditor rejects or rerenders; projection remains correct |
| rerender | prose may differ; all state and memory hashes remain equal |
| retake | child branch differs; parent remains unchanged |
| viewpoint pair | observer recalls material event; non-observer cannot |

### 36.5 Quality evaluation

Run paired, blinded baseline/treatment comparisons across 12–20 fixed scenarios with
multiple model samples. Score:

- voice;
- chemistry;
- continuity;
- pacing;
- causal enactment;
- contradiction;
- exposition;
- perspective leakage;
- player and NPC agency.

Initial acceptance:

- zero deterministic perspective leaks;
- at least 80 percent relevant must-enact coverage;
- no forced irrelevant-state mention;
- no median voice or chemistry decline;
- no material p95 increase without measured quality gain;
- routine progress adds no LLM call.

## 37. Migration and compatibility

### 37.1 Current chat

Current chat remains the test bed until a successor seam passes its gate. Migrate one
domain behind an adapter only after the successor contract exists. Avoid dual authority.

### 37.2 Authored schedules

New entries require typed kind and stable destination references where applicable.
Existing free-text entries use shadow inference, corpus review, explicit unknown, and
telemetry. Inferred text must not cause hard location or body events without validation.

### 37.3 Events

Every event type has a schema version and pure upcaster. If semantics cannot be safely
upcast, freeze the old branch on its ruleset or run an explicit migration that emits
auditable events.

### 37.4 Projections and RAG

Projection schemas may be rebuilt. Embeddings may be deleted and regenerated from
authorized source rows. Neither operation changes domain history.

### 37.5 Feature flags

Authority flags apply per world or branch:

- legacy_chat;
- successor_shadow;
- successor_authoritative;
- successor_narrative_view;
- successor_rag_eligibility.

The application must display or log which authority served a turn.

## 38. Cheap architectural experiments

Before broad migration:

1. **Witness SQL eligibility:** use existing witnessedBy data as a WHERE condition before
   vector ranking for one observer/non-observer fixture.
2. **Schedule-kind shadow audit:** measure inferScheduleKind precision and unknown rate;
   false-positive hard effects fail the adapter.
3. **Grounded-context ablation:** add one deterministic redacted environmental or body
   read to current narration without a new model call.
4. **Minimum authority seam:** one item, two holdings, one transfer command/event/
   projection, one observer and one non-observer.

The first three should fit in sub-day spikes. The fourth should remain deletable and
should not acquire scheduler, body, economy, or autonomous-agent scope.

## 39. Product rulings

Rulings 1–11 and 13 were **resolved by the owner on 2026-07-17** (the Gate 3 unblock
pass). Each resolved decision is normative and MUST be stored in a versioned world-type
rule or explicit product contract, not only in a prompt. Rulings 12 and 14 remain **open**
and are deferred to the gate that needs them.

1. **Ordinary dialogue duration** — RESOLVED: a fixed per-exchange story-time span (the
   current-lane ~1-minute default), versioned by world type. Explicit actions (travel,
   chores, sleep, wait) carry their own durations; dialogue itself is not content-estimated
   and is not player-timed.
2. **Shift/commitment firmness** — RESOLVED: per commitment, via the existing
   `Commitment.flexibility` dial (`soft | negotiable | firm | hard`). There is no global
   exact-versus-flexible switch; a world type sets defaults, each commitment overrides.
3. **Transgressive actions** — RESOLVED: permitted as explicit, modeled attempts per
   §14.3 (duration, noise, tools, lock/obstacle state, witnesses, interruption, and legal/
   social/safety consequence). They MUST never auto-succeed and MUST never override the
   target's agency. A world type MAY still disallow them and reject at admission with a
   public rule reason (§14.3). **This ruling governs spatial/property transgression only;
   interpersonal consent for touch or intimacy remains an independent action precondition
   (§14) that no spatial outcome can grant.**
4. **Storyteller privilege** — RESOLVED: admin principals only, and only inside an explicit
   storyteller mode. The privileged command family (§7) is always audited; ordinary player
   principals never receive it.
5. **Obligation disclosure** — RESOLVED: relationship- and personality-driven. How
   proactively an NPC reveals an obligation before leaving is an NPC-policy output, not a
   fixed rule; a guarded actor MAY decline to explain (see ruling 13).
6. **Missed-obligation consequences** — RESOLVED: deterministic built-in rules for the
   first build (no model call), emitting `CommitmentLate` / `CommitmentMissed` consequence
   events. Authored consequence tables and a bounded director are later, optional layers.
7. **Player concurrency** — RESOLVED: one physical locus per player. A player MAY hold at
   most one co-present Engagement; any concurrent Engagement MUST be remote (text, voice,
   or video). The player body is reserved exactly as an NPC body is (§11.3).
8. **Failed narration** — RESOLVED: a failed narrator turn is hidden and retryable, and the
   committed story-time advance is NOT surfaced to the player until a render succeeds. Hard
   state already committed for the cut is never reverted (§18.5) — only its presentation is
   withheld.
9. **Armed speech acts** — RESOLVED: all semantic speech acts in §23.3 (promise offered/
   accepted, invitation, disclosure, warning, boundary, question, apology) use ArmedEffect
   and are recorded only when the structured narrator result enacts them in meaning
   (paraphrase counts; no literal keyword is required).
10. **Initial performance target** — RESOLVED: small and intimate — an on-branch cast of
    roughly 2–8 exact-LOD actors and an off-screen horizon of hours to a few days. Larger
    populations and longer horizons are a later LOD target (Gate 6), not a first-build
    budget.
11. **Waking sleeping actors** — RESOLVED: by default a remote message is delivered but does
    NOT wake a sleeping actor (§16.4); it queues unread until a legal wake cue. World types
    MAY define emergency exceptions later.
12. **Route-estimate uncertainty exposure** — OPEN (deferred to Gate 3 travel polish; the
    §13.3 route result carries derivation uncertainty regardless of how much is shown).
13. **Lying about a private denial reason** — RESOLVED: an NPC MAY give an in-character
    cover story instead of the true private cause, consistent with personality. The true
    cause is still redacted from narrator context, prompts, diagnostics, and embeddings
    either way (§14.4, §34.5); the cover story is presentation, never a change to hard
    truth.
14. **Soft canon → authored canon promotion** — OPEN (deferred to Gate 4 knowledge/
    narration work; §23.4).

## 40. Initial conformance checklist

An implementation conforms to the foundation when:

- accepted operations are commands resolved into immutable events;
- one branch owns one total event order and optimistic version;
- replay and projection rebuild are deterministic;
- scheduled triggers evaluate outcomes without a minute tick;
- schedule boundaries create pressure, not teleportation;
- movement uses one locus, routes, journeys, and lower-bound time;
- activities own claims and enforce compatibility;
- access, privacy, and consent are independent and fail safely;
- live engagements reconcile due and upcoming pressure before narration;
- player prose cannot command an uncontrolled NPC;
- routine NPC choices use deterministic policy;
- LLM deliberation is bounded to legal candidates;
- hard events commit before narration;
- semantic prose effects require ArmedEffect confirmation;
- NarrativeCut is immutable and perspective-safe;
- observations, assertions, beliefs, and truth remain distinct;
- retrieval filters eligibility before vector ranking;
- rerender is state-free and retake forks;
- current group retakes restore every member until migration;
- TypeScript kernel behavior is integer, seeded, sorted, tested, and benchmarked;
- scenario quality and latency meet the gates in the companion plan.
