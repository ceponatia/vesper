# Romantic contact affordances — shared contact core

Status: **live physical owner, reconciled 2026-08-18.** The executable core lives
under `apps/web/src/contracts/affordances/contact/` and is used by character
chat. It owns contact resolution and lifecycle truth. It does **not** own visual
attention/presentation, permission state, wardrobe state, body residue/marks, or
NPC behavior decisions.

Plain-English plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Related specs:

- [scene/body relations](romantic-contact-affordances.spec.scene.md)
- [NPC actor control](romantic-contact-affordances.spec.actor-control.md)
- [directional permission](romantic-contact-affordances.spec.permission.md)
- [effects and observation routing](romantic-contact-affordances.spec.effects.md)

## Boundary: attempt -> resolution -> commitment

Three stages remain distinct.

```ts
interface ContactActionIntent {
  actorId: AffordanceSubjectId;
  source: ContactBodySurfaceRef;
  target: ContactSurfaceRef;
  actionKind: ContactActionKind;
  requestedMotion?: ContactMotionIntent;
  requestedPressure?: ContactPressureIntent;
  storyTime: AffordanceStoryTime;
}

type ContactResolution =
  | {
      status: "committable";
      intent: ContactActionIntent;
      materialBetween: readonly ContactMaterialLayerRead[];
      implicitAdjustments: readonly ContactMinimalPoseAdjustment[];
      evidence: readonly AffordanceEvidence[];
    }
  | {
      status: "explicit_transition_required";
      requirements: readonly ContactActionRequirement[];
      evidence: readonly AffordanceEvidence[];
    }
  | {
      status: "rejected";
      reason: ContactRejectionReason;
      evidence: readonly AffordanceEvidence[];
    }
  | {
      status: "unresolved";
      reason: ContactUnresolvedReason;
      evidence: readonly AffordanceEvidence[];
    };
```

Only a committed lifecycle read is current contact truth.

```ts
interface CommittedContactRead {
  contactId: ContactId;
  actorId: AffordanceSubjectId;
  actionKind: ContactActionKind;
  source: ContactBodySurfaceRef;
  target: ContactSurfaceRef;
  pressure: CommittedContactPressureRead;
  contactArea: CommittedContactAreaRead;
  motion?: CommittedContactMotionRead;
  materialBetween: readonly ContactMaterialLayerRead[];
  implicitAdjustments: readonly ContactMinimalPoseAdjustment[];
  startedAt: AffordanceStoryTime;
  lastUpdatedAt: AffordanceStoryTime;
  phase: "active";
}
```

A rejected/unresolved attempt may produce an action outcome, but it cannot be
projected as active contact and cannot feed physical phenomena as though contact
occurred.

## Lifecycle law

The active projection is a fold over contact lifecycle commits.

```ts
type ContactLifecycleCommit =
  | { kind: "contact_started"; contact: CommittedContactRead }
  | { kind: "contact_updated"; contactId: ContactId; patch: CommittedContactUpdate; storyTime: AffordanceStoryTime }
  | { kind: "contact_ended"; contactId: ContactId; reason: ContactEndReason; storyTime: AffordanceStoryTime };
```

Required behavior:

- start only from a committable resolution;
- preserve stable contact identity across ordinary updates;
- continue without a duplicate write when nothing changed;
- update only fields the lifecycle operation explicitly owns;
- end on explicit withdrawal, separation, scene discontinuity, policy
  withdrawal, or an authoritative state change that invalidates the path;
- never keep contact alive because prose mentioned it;
- never use wall-clock timeout as story truth;
- retry with the same event/idempotency identity cannot create a second contact;
- retake/prune restores the active projection to the restored story cut.

Current chat persistence is `chat_contact_events`; the scene's active-contact
projection is persisted atomically/guardedly with the owning exchange paths.

## Action kinds and permission

The core supports:

```text
incidental
casual
affectionate
romantic
intimate
```

Exact policy scopes are mapped in `contact/decisions.ts`.

Current settled law:

- incidental/casual/affectionate are permission-neutral at this layer;
- romantic/intimate require an applicable policy answer;
- `romantic_touch` is the only implemented gated scope in character chat;
- exact scope membership is required;
- reverse-direction permission never authorizes;
- missing required permission is not silently allowed;
- the player-target exception is represented explicitly as `not_required` with
  the `player_target` basis, never as a fabricated grant.

The core consumes `ContactInteractionPolicyRead`; it does not own or infer the
permission record.

**Integration fact:** character chat now produces a player
`actionKind: "romantic"` attempt through a separate narrow producer beside the
affectionate one, **but only while a permission owner is wired to answer it** —
the producer is gated on the policy source's presence, so a kind this core gates
is never authored into a turn that has nobody to gate it. The player act type is
`"affectionate" | "romantic"`, and it deliberately names only the kinds that lane
can author rather than this core's full `ContactActionKind`. `incidental`, `casual`, and `intimate` are still
supported here with no chat producer. Supporting a kind in this core is not the
same as having a lane producer for it.

## Actor control and target agency

Actor control and target agency are different reads.

```ts
interface ContactActorControlDecision {
  status: "allowed" | "denied" | "unresolved";
  actorId: AffordanceSubjectId;
  evidence: readonly AffordanceEvidence[];
}

interface ContactTargetAgencyDecision {
  status: "allowed" | "denied" | "unresolved" | "not_required";
  targetId: AffordanceSubjectId;
  evidence: readonly AffordanceEvidence[];
}
```

Laws:

- the initiating principal must control the actor's voluntary movement;
- player-authored text about an NPC is not NPC actor control;
- an NPC reply never grants control over the player's body;
- a voluntary adjustment by a non-actor participant requires that participant's
  own agency decision;
- `not_required` is correct only when that participant does not have to move;
- physical feasibility does not substitute for either authority read.

A player -> NPC romantic contact that requires no NPC reposition may therefore
be proven without enabling general NPC movement/start/update authority. An
NPC-initiated romantic contact cannot be claimed until the NPC action producer
and applicable actor-control gate are authoritative.

## Contact action context

The resolver combines reads owned elsewhere.

```ts
interface ContactActionContext {
  actorControl: ContactActorControlDecision;
  targetAgency: readonly ContactTargetAgencyDecision[];
  geometry: AdapterRead<ContactGeometryRead>;
  sourceSupport: AdapterRead<ContactSupportRead>;
  targetSupport: AdapterRead<ContactSupportRead>;
  material: AdapterRead<ContactMaterialRead>;
  policy: ContactInteractionPolicyRead;
  environment?: ContactEnvironmentRead;
}
```

Exact executable shapes live in `apps/web/src/contracts/affordances/contact/`;
the important architectural law is that every input is a **read**, not a
permission for contact to manufacture missing state.

Unknown/malformed reads degrade toward `unresolved` unless an authority owner
explicitly denied the action, in which case the result is `rejected` with that
owner's evidence.

## Access and material-between

Access is local to one attempted path. There is no global `accessible` bit.

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
```

Rules:

- visible does not mean touchable;
- tactile transmission through fabric does not mean direct skin access;
- material layers remain ordered from source to target;
- coverage is read from the current wardrobe cut, not inferred from an absent
  capture;
- dressed-but-unmodellable is `unavailable`, not bare;
- openings/displacement are region-specific;
- a future internal anatomical path is a distinct access mode with additional
  alignment/policy requirements.

The current chat integration intentionally uses coarse transmission values from
coverage because detailed material mechanics are not yet wired. Do not tune
those coarse values into pretend physics; replace them with real material reads
when that slice exists.

## Implicit adjustment policy

A small adjustment may ride with an action only if it:

- stays within current proximity;
- is mechanically small/unambiguous;
- does not move clothing/material layers;
- does not newly expose an intimate surface;
- does not change place or major posture;
- does not transfer meaningful support;
- does not overcome resistance/constraint;
- does not express an independent choice/reaction.

The accepted vocabulary remains closed (`lean`, `joint_rotation`,
`limb_reposition`, `head_angle`). Anything outside the policy becomes an
explicit transition requirement.

Never use an implicit adjustment to make an otherwise impossible or
unauthorized scene work.

## Physical contact frame

The contact frame contains **physical truth**, not observer memory or narrator
presentation state.

```ts
interface RegionalContactFrame {
  storyTime: AffordanceStoryTime;
  contact: CommittedContactRead;
  source: BodySurfaceRead;
  target: SurfaceRead;
  sourceCondition: SurfaceConditionRead;
  targetCondition: SurfaceConditionRead;
  materialBetween: readonly ContactMaterialLayerRead[];
  sourceSupport: ContactSupportRead;
  targetSupport: ContactSupportRead;
  environment?: ContactEnvironmentRead;
  recentPhysicalEvents: readonly AffordanceCausalEvent[];
}
```

**Removed from the core design:** a general `perception` field. Perception is
channel/observer-specific and belongs after a physical phenomenon is resolved.
Visual observations route to visual state; tactile/olfactory/gustatory
observations wait on the shared sensory presentation owner described in the
[effects spec](romantic-contact-affordances.spec.effects.md).

## Shared mechanics

Semantic bands remain the public result, not raw coefficients.

```ts
interface ContactMechanics {
  pressureBand: "trace" | "light" | "moderate" | "firm";
  areaBand: "point" | "narrow" | "broad";
  motionBand: "still" | "pressing" | "sliding" | "rolling" | "tapping";
  effectiveFriction?: "dragging" | "controlled" | "smooth" | "slippery";
  effectiveCompliance?: "rigid" | "firm" | "yielding" | "soft";
  temperatureRelation?: "cooler" | "similar" | "warmer";
  transmission: ContactMaterialTransmissionRead;
}
```

Laws:

- pressure requires committed contact;
- friction/glide requires committed relative motion;
- moisture/product modifies friction only when an authoritative current source
  supplies it;
- fabric/material filters mechanics rather than disappearing;
- temperature needs actual temperature reads;
- potential deformation is not an observation until current contact/support
  makes it real.

## Observation/presentation boundary

The core may resolve a physical phenomenon into a structured, channel-tagged
fact. It does not decide whether the narrator sees/feels/smells/tastes it or
whether it deserves a mention.

```ts
type ContactPerceptionChannel = "visual" | "tactile" | "olfactory" | "gustatory";

interface ContactPhenomenonObservation {
  phenomenonId: string;
  channel: ContactPerceptionChannel;
  subjectIds: readonly AffordanceSubjectId[];
  locus: BodyLocusRef;
  intensity: "subtle" | "clear" | "strong";
  semanticTags: readonly string[];
  evidence: readonly AffordanceEvidence[];
}
```

This is intentionally **not** the existing channel-less
`AffordanceObservation` type. At the routing boundary:

- visual contact observations may adapt to the existing visual-state affordance
  observation bridge;
- nonvisual observations may not be passed through that bridge.

The contact core has no mention-priority function, narrator cooldown store, or
presentation capture.

## Effect boundary

Contact can propose an effect only from committed contact plus sufficient source
state.

Examples:

- conserved surface transfer;
- pressure mark;
- scratch;
- garment displacement request.

The contact layer never makes the proposed effect current truth. Body/garment
owners validate and commit it, then later reads may observe the committed
result. See the [effects spec](romantic-contact-affordances.spec.effects.md).

## Visual-state integration

Current visual state already consumes the contact lifecycle for:

- hand occupation;
- committed contact motion.

Before rich positive visual contact prose is considered complete, visual state
also needs a first-class contact-relation feature carrying both participants and
both loci. That adapter consumes `CommittedContactRead`; it does not change this
core's storage model.

## Required tests

### Boundary/lifecycle

- attempt cannot masquerade as committed contact;
- unresolved/rejected attempt produces no active contact;
- unchanged contact keeps the same id without another start;
- updates preserve unspecified fields;
- release/separation/discontinuity ends affected contact;
- permission withdrawal ends only dependent contacts;
- retry and retake cannot duplicate or resurrect a discarded contact.

### Authority/policy

- player-authored NPC movement fails actor control;
- target voluntary adjustment requires that target's agency;
- affectionate remains permission-neutral;
- player -> NPC romantic requires the exact directional grant;
- reverse/wrong scope cannot authorize;
- player-target exception never authors a player response;
- physical possibility never becomes permission or reaction.

### Access/material

- unknown geometry/support/material degrades rather than defaulting;
- dressed-but-unmodellable never becomes bare;
- direct-skin action fails while a blocking layer remains;
- material may transmit touch without direct access;
- visual access does not imply tactile/gustatory access.

### Mechanics/effects

- no motion -> no glide;
- no authoritative moisture/product -> no moisture-derived friction claim;
- no source -> no transfer;
- effect proposal is not observable until owner commit;
- transfer retry is idempotent and conserved;
- malformed adapter data degrades with bounded diagnostics.

### Presentation routing

- tactile/olfactory/gustatory observations cannot enter the visual-state bridge;
- visual contact observation uses visual-state visibility/attention/memory;
- no contact-specific cue memory/cooldown state exists;
- retake recomputes visual state from restored contact truth and restored visual
  memory rather than a contact-owned presentation snapshot.
