# Engine spec — world: space, access, commitments, actions, journeys, engagements (§13–§18)

Status: companion to [engine.spec.md](engine.spec.md) — §13–§18, world.

Part of the [engine.spec.md](engine.spec.md) contract set (split 2026-07-21).
Section numbering is GLOBAL across the engine.spec.* files — cite sections as
"engine.spec §N" exactly as before; the hub's index maps every § to its file. The
normative-keyword rules (MUST/SHOULD/MAY) are defined in the hub.

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

A commitment's `destinationZoneId` is OPTIONAL. A destinationless commitment carries no
spatial obligation — its `latestArrival` deadline still fires, but the deadline
evaluator (§15.4) has no locus to check, so it can only ever resolve `kept` (via an
explicit `fulfill_commitment` act before the deadline, E5.5 §7.4) or `missed` (deadline
reached with no fulfillment) — never `late`, a concept requiring travel. A
destinationless promise MAY optionally name `promisedToActorId`, the counterpart the
obligation runs toward; when present, `kept`/`missed`/a subsequent `repaired`
commitment each produce a directional §21.3 ledger entry. A commitment absent
`promisedToActorId` (a shift, an appointment with no interpersonal stake, a solo
routine) produces no ledger entry — the ledger records evidence between actors, never
a fact about one actor alone. `promisedToActorId` MUST differ from the commitment's own
`actorId` — a self-promise is rejected `promised_to_self` at `create_commitment`
resolution, a structured rejection rather than a crash (`commitmentSchema`'s refine
codifies the same constraint at the type level).

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

| From        | Legal next states                                   |
| ----------- | --------------------------------------------------- |
| planned     | noticed, accepted, declined, cancelled, missed      |
| noticed     | accepted, declined, cancelled, missed               |
| accepted    | in_progress, cancelled, missed                      |
| declined    | cancelled, accepted if renegotiated                 |
| in_progress | kept, late, missed, cancelled                       |
| kept        | terminal                                            |
| late        | kept, missed, terminal consequence                  |
| missed      | terminal or explicitly repaired by a new commitment |
| cancelled   | terminal                                            |

History is not rewritten when a commitment is repaired. Create a new commitment or
explicit remediation event.

A `missed` commitment MAY be repaired by creating a NEW commitment whose
`repairsCommitmentId` names it. The repair target MUST belong to the same actor, share
the new commitment's `kind`, and itself be `missed`. History is not rewritten (§15.4's
existing rule) — the original stays `missed` forever; the repair is new evidence, not a
correction.

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

`ConsentRequirement` (§16.1's `ActionDefinition` field, previously inert) is realized
as the `consent_covered` action precondition (E3.2's typed, ENFORCED precondition
vocabulary, §16.1's "inert authored field is not acceptable" rule): an action
definition names a `ConsentScopeKey`; `start_activity`'s payload MAY name a
`targetActorId` (the second party the gated action concerns); starting a
`consent_covered` action with no covering §21.4 entry rejects `consent_required`,
fail-closed, before any claim or resource is reserved. An action definition MAY declare at most ONE
`consent_covered` precondition — the store resolves a single `consentCovered`
boolean per start (mirroring `heldClaims`/`coLocatedActorIds`), not a per-scope map, so
`simulationActionDefinitionSchema` rejects a definition authored with two or more,
rather than silently reusing the first scope's coverage for every later one.

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

| From        | Legal next phases                                 |
| ----------- | ------------------------------------------------- |
| queued      | preparing, active, cancelled, failed              |
| preparing   | active, interrupted, cancelled, failed            |
| active      | paused, interrupted, completed, failed, cancelled |
| paused      | active, interrupted, cancelled, failed            |
| interrupted | active, cancelled, failed                         |
| completed   | terminal                                          |
| failed      | terminal                                          |
| cancelled   | terminal                                          |

Starting an activity atomically acquires its exclusive claims. Completion, failure, and
cancellation release them. A stale or crashed worker MUST NOT leave claims orphaned;
claims are projected from activity state and repairable from events.

### 16.4 Compatibility examples

Compatibility is channel- and action-specific:

| Current activity   | Co-present conversation                    | Text or call                                    | Normal policy                |
| ------------------ | ------------------------------------------ | ----------------------------------------------- | ---------------------------- |
| walking            | usually allowed with reduced attention     | allowed                                         | continue route               |
| cooking            | allowed unless hazardous phase             | usually allowed                                 | may pause at boundary        |
| desk work          | limited                                    | limited                                         | pressure depends on role     |
| driving            | conversation with passenger may be limited | text forbidden; hands-free call policy-specific | safety dominates             |
| showering          | only with legal access and consent         | delivery may occur; response optional           | privacy dominates            |
| toileting/changing | normally unavailable                       | delivery may occur; response optional           | privacy dominates            |
| sleeping           | unavailable until perceived wake cue       | message may queue unread                        | sleep continues              |
| intimate activity  | participants and consent only              | interruption policy-specific                    | privacy and consent dominate |

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

| From        | Legal next states                        |
| ----------- | ---------------------------------------- |
| planned     | active, abandoned                        |
| active      | delayed, interrupted, arrived, abandoned |
| delayed     | active, interrupted, arrived, abandoned  |
| interrupted | active, abandoned                        |
| arrived     | terminal                                 |
| abandoned   | terminal                                 |

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

| From         | Legal next states                |
| ------------ | -------------------------------- |
| opening      | active, ended, interrupted       |
| active       | winding_down, ended, interrupted |
| winding_down | active, ended, interrupted       |
| interrupted  | active, ended                    |
| ended        | terminal                         |

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

