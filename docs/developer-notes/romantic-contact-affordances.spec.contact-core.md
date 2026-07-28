# Romantic contact affordances — shared contact core

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28 — in the committed foot-first scope, slices 0–4)

## Boundary: attempt, resolution, commitment

The core uses three separate types because collapsing them lets possibilities
leak into narration.

```ts
interface ContactActionIntent {
  actorId: CharacterId;
  actorSurface: BodySurfaceHandle;
  targetId: EntityId;
  targetSurface: SurfaceHandle;
  actionKind: ContactActionKind;
  requestedMotion?: ContactMotionIntent;
  requestedPressure?: ContactPressureIntent;
  storyTime: StoryTimestamp;
}

type ContactResolution =
  | {
      status: "committable";
      intent: ContactActionIntent;
      materialBetween: readonly MaterialLayerRead[];
      implicitAdjustments: readonly MinimalPoseAdjustment[];
      evidence: readonly AffordanceEvidence[];
    }
  | {
      status: "explicit_transition_required";
      requirements: readonly ActionRequirement[];
      evidence: readonly AffordanceEvidence[];
    }
  | {
      status: "rejected";
      reason: ContactRejectionReason;
      evidence: readonly AffordanceEvidence[];
    };

type CommittableContactResolution = Extract<ContactResolution, { status: "committable" }>;

interface CommittedContactRead {
  contactId: ContactId;
  startedByEventId: EventId;
  lastUpdatedByEventId: EventId;
  startedAt: StoryTimestamp;
  lastUpdatedAt: StoryTimestamp;
  phase: "active";
  source: BodySurfaceHandle;
  target: SurfaceHandle;
  pressure: CommittedContactPressureRead;
  contactArea: CommittedContactAreaRead;
  motion?: CommittedContactMotionRead;
  materialBetween: readonly MaterialLayerRead[];
  implicitAdjustments: readonly MinimalPoseAdjustment[];
}
```

Only `CommittedContactRead` enters an observation frame. A rejected attempt may
produce a normal action-result cue through the action system, not a physical
contact observation.

The committed read is the active projection of lifecycle events:

```ts
type ContactLifecycleCommit =
  | { kind: "contact_started"; contact: CommittedContactRead }
  | {
      kind: "contact_updated";
      eventId: EventId;
      contactId: ContactId;
      patch: CommittedContactUpdate;
      storyTime: StoryTimestamp;
    }
  | {
      kind: "contact_ended";
      eventId: EventId;
      contactId: ContactId;
      reason: ContactEndReason;
      storyTime: StoryTimestamp;
    };

type CommittedContactUpdate = Partial<Pick<
  CommittedContactRead,
  "pressure" | "contactArea" | "motion" | "materialBetween" | "implicitAdjustments"
>>;

type ContactEndReason = "withdrawn" | "separated" | "scene_changed"
  | "policy_withdrawn" | "state_invalidated";
```

An end commit removes the contact from the active projection. Scene separation,
an incompatible pose/garment transition, explicit withdrawal, and branch/
retake restoration must end or restore contacts deterministically. A prior
narrative mention cannot keep a contact active.

## Action context

The resolver consumes authoritative reads without taking ownership of them.

```ts
interface ContactActionContext {
  actorControl: ActorControlDecision;
  participantEligibility: ParticipantEligibilityRead;
  pose: PairPoseRead;
  sourceSupport: RegionalSupportRead;
  targetSupport: RegionalSupportRead;
  geometry: PairGeometryRead;
  wardrobe: PairWardrobeRead;
  policy: InteractionPolicyRead;
  environment: ContactEnvironmentRead;
  bodyStateCut: BodyStateCutRef;
}

interface ActorControlDecision {
  status: "allowed" | "denied" | "unresolved";
  actorId: CharacterId;
  evidence: readonly AffordanceEvidence[];
}

interface ParticipantEligibilityRead {
  status: "eligible" | "ineligible" | "unresolved" | "not_required";
  participantIds: readonly EntityId[];
  evidence: readonly AffordanceEvidence[];
}

interface InteractionPolicyRead {
  status: "allowed" | "denied" | "withdrawn" | "unresolved";
  scopes: readonly ContactPolicyScope[];
  evidence: readonly AffordanceEvidence[];
}
```

`ActorControlDecision` proves that the initiating principal may author the
actor's voluntary movement. Player-authored narration about an NPC is not
control. A target's voluntary adjustment or reaction needs its own behavior/
agency decision before commitment.

`ParticipantEligibilityRead` reuses the product life-stage/minor fence and any
future explicit adult-participant policy. Known minors always fail
romantic/intimate eligibility. Unknown, nonnumeric, fantasy-scaled, and player
ages need an explicit product ruling; absence cannot be hidden inside the
contact calculation.

`InteractionPolicyRead` is a result from the lane's existing permission/
consent owner. It is not calculated from attraction, arousal, relationship
score, narrative framing, touch welcomeness, or the physical action's
feasibility.

For interpersonal contact:

- the actor-control decision must cover the initiating movement;
- target permission uses the lane's applicable interaction policy;
- a voluntary target adjustment/reaction must be committed by the target's
  behavior authority;
- missing required control or permission rejects commitment.

For romantic/intimate actions in addition:

- all participants must pass the adult-eligibility rule;
- `allowed` must be explicit and scope-compatible;
- withdrawal or contradiction rejects the action;
- missing/invalid policy fails closed;
- legacy chat's intimacy signal may gate prompting but is not automatically a
  consent grant;
- successor `consent_covered` resolution remains authoritative where present.

## Access result

Access is scoped to one actor surface, target surface, and action. There is no
global `accessible` flag.

```ts
type ContactAccessMode =
  | "direct"
  | "through_material"
  | "implicit_adjustment"
  | "explicit_transition_required"
  | "blocked_by_clothing"
  | "blocked_by_geometry"
  | "blocked_by_support"
  | "blocked_by_policy"
  | "out_of_reach";

interface ContactAccessResult {
  mode: ContactAccessMode;
  path: ContactPathRead;
  materialBetween: readonly MaterialLayerRead[];
  implicitAdjustments: readonly MinimalPoseAdjustment[];
  explicitRequirements: readonly ActionRequirement[];
  evidence: readonly AffordanceEvidence[];
}
```

An available visual path does not imply a tactile path. A tactile path through
fabric does not imply direct skin access. Internal anatomical access is a
separate path kind with region-specific alignment and policy requirements.

## Implicit adjustment policy

An adjustment may be implicit only when all are true:

- it stays within current proximity and the same interaction;
- it is small, ordinary, and mechanically unambiguous;
- it does not remove, open, loosen, or displace clothing;
- it does not newly expose an intimate surface;
- it does not change furniture, room, or major posture;
- it does not require meaningful support transfer or risk instability;
- it does not overcome active resistance or a joint constraint;
- it does not express an independent choice or reaction.

Possible examples: a small lean, slight rotation of a free ankle, moving a hand
between already adjacent surfaces, or angling the head toward an exposed
surface.

Explicit examples: sitting or standing, rolling over, spreading legs, pulling
free a trapped limb, removing clothing, undoing a closure, forcing
articulation, crossing a room, or choosing an expressive toe curl or thrust.

The accepted adjustments are stored on the committed contact for replay and
diagnostics.

## Contact lifecycle

Contact identity survives ordinary updates across turns. A lifecycle fold:

- starts a new id only from an accepted action;
- updates the same id when pressure, area, motion, material-between, or locus
  changes continuously;
- continues without a write when the active state is unchanged and the lane's
  cut still carries it;
- ends on explicit release, separation, incompatible movement/coverage,
  scene exit, policy withdrawal, or a state transition that invalidates the
  contact;
- never uses wall-clock timeout as story truth;
- replays and branches from lifecycle events or rollback-owned chat state.

The active-contact projection is bounded. Its key is the stable participant/
surface pair plus contact identity, not a narrator sentence. Ended contacts
remain historical events but cannot enter a current frame.

## Regional contact frame

```ts
interface RegionalContactFrame {
  storyTime: StoryTimestamp;
  source: BodySurfaceRead;
  target: SurfaceRead;
  contact: CommittedContactRead;
  sourceCondition: SurfaceConditionRead;
  targetCondition: SurfaceConditionRead;
  materialBetween: readonly MaterialLayerRead[];
  sourceSupport: RegionalSupportRead;
  targetSupport: RegionalSupportRead;
  environment: ContactEnvironmentRead;
  perception: PerceptionContext;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Each body surface includes stable structure and current condition as separate
reads. The frame does not contain hidden model prose. Evidence points to
registry values, state/event reads, and conservative defaults.

## Shared mechanics

Shared mechanics are semantic bands, not exposed simulation coefficients.

```ts
interface ContactMechanics {
  pressureBand: "trace" | "light" | "moderate" | "firm";
  areaBand: "point" | "narrow" | "broad";
  motionBand: "still" | "pressing" | "sliding" | "rolling" | "tapping";
  effectiveFriction?: "dragging" | "controlled" | "smooth" | "slippery";
  effectiveCompliance?: "rigid" | "firm" | "yielding" | "soft";
  temperatureRelation?: "cooler" | "similar" | "warmer";
  transmission: MaterialTransmissionRead;
}
```

Rules:

- pressure needs committed contact;
- friction needs committed relative motion;
- moisture or product may reduce friction only when current surface state
  supplies it;
- a material layer replaces or filters direct surface mechanics according to
  its permeability, thickness, compliance, and friction;
- temperature is a relative tactile read, not a free-standing ambient cue;
- compliance supports a domain deformation calculation but does not guarantee
  visible deformation.

## Material-between composition

Layers are ordered from source to target. Composition must preserve:

- physical blocking versus sensory transmission;
- thickness and rigidity;
- permeability to moisture, scent, and heat;
- local wetness or residue on each layer;
- openings or displaced parts that expose only some target surfaces;
- compression and containment.

Do not summarize a pair of underwear as globally `open` or `closed` when only a
specific panel or displaced region changes access.

```ts
interface MaterialTransmissionRead {
  directSkinContact: boolean;
  tactileTransmission: UnitInterval;
  shapeTransmission: UnitInterval;
  thermalTransmission: UnitInterval;
  moistureTransmission: UnitInterval;
  scentTransmission: UnitInterval;
  visibleThrough: boolean;
  evidence: readonly AffordanceEvidence[];
}
```

## Observations, constraints, and effects

The contracts, presentation rules, and commit laws for narrator-safe
observations, resolver constraints, marks, scratches, garment displacement,
and conserved surface transfer live in the
[effects companion](romantic-contact-affordances.spec.effects.md). The core
may propose an effect; only that companion's owner transaction can make it
current truth.

## Required shared tests

- attempt cannot masquerade as committed contact;
- ended contact cannot enter a current frame;
- scene separation or incompatible pose deterministically ends contact;
- an unchanged sustained contact keeps its id without a duplicate start event;
- player-authored NPC movement fails without an actor-control decision;
- a voluntary target adjustment requires target behavior authority;
- ordinary interpersonal contact applies its permission rule;
- a known minor cannot enter romantic/intimate contact;
- unresolved adult eligibility fails the intimate gate;
- permission missing or withdrawn rejects intimate contact;
- legacy intimacy framing does not become a consent grant;
- direct skin action fails while a material layer remains;
- material can transmit touch without granting direct access;
- visual access does not grant tactile or gustatory access;
- no motion produces no glide;
- no moisture/product source produces no slippery band;
- unknown moisture suppresses moisture-dependent phenomena rather than
  becoming dry;
- possible transfer is silent until committed;
- transfer conserves material across source/target and is idempotent on retry;
- effect rollback leaves no mark/residue observation;
- impossible implicit adjustment becomes an explicit requirement;
- physical possibility never emits an emotional/pleasure reaction;
- high salience cannot bypass intimate gates;
- identical sustained contact is suppressed after its first useful mention;
- a meaningful contact change restores priority;
- retake produces the same contact/effect/cue fingerprints;
- malformed adapter data degrades with a diagnostic rather than throwing.

Open questions are centralized in the
[plain-English plan](romantic-contact-affordances.plan.md#open-questions).
