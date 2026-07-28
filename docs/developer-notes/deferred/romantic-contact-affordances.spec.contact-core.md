# Romantic contact affordances — shared contact core

Status: draft technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

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

interface CommittedContactRead {
  contactId: ContactId;
  provenanceEventId: EventId;
  storyTime: StoryTimestamp;
  source: BodySurfaceHandle;
  target: SurfaceHandle;
  pressureIntent: ContactPressureIntent;
  contactAreaHint: ContactAreaHint;
  motion?: CommittedContactMotionRead;
  materialBetween: readonly MaterialLayerRead[];
  implicitAdjustments: readonly MinimalPoseAdjustment[];
}
```

Only `CommittedContactRead` enters an observation frame. A rejected attempt may
produce a normal action-result cue through the action system, not a physical
contact observation.

## Action context

The resolver consumes authoritative reads without taking ownership of them.

```ts
interface ContactActionContext {
  pose: PairPoseRead;
  sourceSupport: RegionalSupportRead;
  targetSupport: RegionalSupportRead;
  geometry: PairGeometryRead;
  wardrobe: PairWardrobeRead;
  policy: InteractionPolicyRead;
  environment: ContactEnvironmentRead;
  bodyStateCut: BodyStateCutRef;
}
```

`InteractionPolicyRead` is a result from the lane's existing consent/policy
owner. It is not calculated from attraction, arousal, relationship score,
narrative framing, or the physical action's feasibility.

For adult intimate actions:

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

```ts
interface ContactObservation {
  id: ContactObservationId;
  phenomenonId: ContactPhenomenonId;
  subjectIds: readonly EntityId[];
  locus: BodyLocusRef;
  channel: "visual" | "tactile" | "olfactory" | "gustatory";
  tags: readonly string[];
  strength: UnitInterval;
  evidence: readonly AffordanceEvidence[];
  repeatKey: string;
}

interface ContactConstraint {
  kind:
    | "contact_blocked"
    | "direct_surface_hidden"
    | "motion_restricted"
    | "effect_not_committed";
  locus: BodyLocusRef;
  evidence: readonly AffordanceEvidence[];
}

interface ProposedContactEffect {
  kind:
    | "surface_transfer"
    | "pressure_mark"
    | "scratch"
    | "garment_displacement";
  sourceSurface: SurfaceHandle;
  targetSurface: SurfaceHandle;
  magnitude: UnitInterval;
  payload?: SurfaceMaterialPayload;
  causedByContactId: ContactId;
  evidence: readonly AffordanceEvidence[];
}
```

`ProposedContactEffect` is submitted to the owning action/body/garment
transaction. The next frame may observe the committed result by event id. A
failed or rolled-back effect remains absent.

## Perception and intimate gating

Perception gating is evaluated before cue ranking.

| Channel | Minimum evidence |
| --- | --- |
| Visual | Unoccluded path, sufficient light/distance/orientation, exposure appropriate to region and viewer. |
| Tactile | Actor is a participant in committed contact and material transmission is nonzero. |
| Olfactory | Current contributor, exposure/permeability, proximity, and airflow. |
| Gustatory | Direct qualifying oral contact, current contributor, and intimate policy pass where required. |

Intimate status is an additional hard gate, not a score. High salience,
uniqueness, action relevance, or narrator focus cannot bypass it.

The narrator gets no observations about what another actor privately feels.
A character's internal tactile observation may inform that character's own
behavior/narration only through the lane's established point-of-view rules.

## Ranking and repetition

Physical truth and mention state remain separate.

```ts
interface ContactMentionRead {
  observation: ContactObservation;
  novelty: UnitInterval;
  changeSignificance: UnitInterval;
  actionRelevance: UnitInterval;
  narrativeFocus: UnitInterval;
  repetitionCooldown: UnitInterval;
}

function contactMentionPriority(read: ContactMentionRead): number {
  return (
    Math.max(read.novelty, read.changeSignificance, read.actionRelevance) *
    read.narrativeFocus *
    read.repetitionCooldown
  );
}
```

This formula is a proposed shape, not calibrated truth. Rank after hard gates
and select at most one or two cues. A repeat key includes phenomenon, subjects,
locus, channel, and stable result band. New pressure, path, material, motion,
surface condition, effect commit, or perception can change the fingerprint and
restore priority.

Keep separate timestamps for:

- last physically observed/noticed;
- last offered to the narrator;
- last realized in narration, if the lane can report it.

Do not require RAG retrieval for immediate cooldown correctness.

## Required shared tests

- attempt cannot masquerade as committed contact;
- permission missing or withdrawn rejects intimate contact;
- legacy intimacy framing does not become a consent grant;
- direct skin action fails while a material layer remains;
- material can transmit touch without granting direct access;
- visual access does not grant tactile or gustatory access;
- no motion produces no glide;
- no moisture/product source produces no slippery band;
- possible transfer is silent until committed;
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
