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

## As built — slice 1

Shipped 2026-07-30 in `src/contracts/affordances/contact/` — a **sibling** of
`affordances/core/` and `affordances/guidance/`, for the reason `guidance/` is
one: the core stages a calculation it knows nothing about, and this layer knows
what a contact *is*. It is still domain-neutral, and its own
`domain-neutrality.test.ts` proves it (no foot, intimate, or garment vocabulary
in executable code; no import of a domain, of `guidance/`, or of `src/server`;
no `Date`, `Math.random`, or `process.env`).

Pure contracts only: **no lane wiring, no storage, no schema change, no
migration.** The [truth-source audit](romantic-contact-affordances.audit.md)
records pose, reach, support, material-between, actor control (legacy), and
permission (legacy) as unowned in both lanes, so every one of them arrives as an
`AdapterRead` and an unanswerable read produces `unresolved`.

### File map

| File | Responsibility |
| --- | --- |
| `identity.ts` | `ContactId`, `ContactEventRef`, `ContactEntityId`; the order-independent pair key and `deriveContactId`. |
| `surfaces.ts` | Body and object surface refs over `bodyLocationRegistry`; surface/pair keys; participant extraction. |
| `material.ts` | `ContactMaterialLayerRead`, `ContactMaterialTransmissionRead`, `composeContactMaterial`. |
| `decisions.ts` | Action kinds → policy scopes; actor control, target agency, eligibility, permission; the implicit-adjustment policy; requirement and rejection vocabularies. |
| `types.ts` | Bands, intent, context, access result, the four-status resolution, `CommittedContactRead`, `EndedContactRecord`, the lifecycle commit union. |
| `resolve.ts` | `resolveContactAttempt` — the whole gate. |
| `lifecycle.ts` | `commitContactResolution`, `endContact`, `endAllContacts`, the active projection and its reads. |
| `state.ts` | `committedContactReadSchema`, `parseContactLifecycleState` — the versioned shape and its healing. |
| `diagnostics.ts` | The ten codes slice 1 emits. |
| `test-support.ts` | `probe*` fixture builders. Deliberately **not** in the barrel. |
| `*.test.ts` | 5 files / 87 cases: resolve, lifecycle, material, state, neutrality. |

### Public API

`resolveContactAttempt({ intent, context, sink? }) → ContactResolution` ·
`commitContactResolution({ state, resolution, eventRef, sink? }) → { state, commit, contact }` ·
`endContact({ state, contactId, reason, storyTime, eventRef, sink? })` ·
`endAllContacts({ state, reason, storyTime, eventRef })` ·
`activeContact` / `activeContactForPair` / `activeContactsOf` ·
`emptyContactLifecycleState` / `parseContactLifecycleState` ·
`classifyContactAdjustment` · `composeContactMaterial` / `sortContactMaterialLayers` /
`directContactTransmission` · `contactPairKey` / `contactSurfaceKey` /
`contactParticipantIds` / `isInterpersonalContact` / `isKnownContactBodyLocation` ·
`contactActionRequiresAdultEligibility` / `contactActionRequiresPermission` /
`CONTACT_ACTION_SCOPE` · `CONTACT_RESOLUTION_ACTION_STATUS`.

### Deltas from the draft above — this section is the authority

| Draft | As built | Why |
| --- | --- | --- |
| `ContactResolution` has three statuses | **Four**: `committable`, `explicit_transition_required`, `rejected`, `unresolved` | The narrator seam already exists and its `PhysicalActionStatus` carries `unresolved`. An unanswerable owner is not a rejection: a rejection is a story fact the narrator must resolve, while `unresolved` produces silence. `CONTACT_RESOLUTION_ACTION_STATUS` maps the four onto the seam's strings, and a test asserts every value is a member of `physicalActionStatuses`. `partially_committed` is deliberately **not** modelled — no producer exists until the foot slice needs per-locus commitment. |
| `EventId`, `CharacterId`, `EntityId`, `StoryTimestamp` | `ContactEventRef`, `AffordanceSubjectId`, `ContactEntityId`, `AffordanceStoryTime` | The successor lane's branded `EventId` is a simulation id legacy chat cannot mint; binding to it would fork the core. Subject ids and story time already exist in `affordances/core` and are reused unchanged. |
| `MaterialLayerRead`, `MaterialTransmissionRead`, `MinimalPoseAdjustment`, `ActionRequirement` | `Contact`-prefixed | These names go through `export *` in `affordances/index.ts`; unprefixed generic nouns in a shared barrel are a collision waiting to happen. |
| `wardrobe: PairWardrobeRead` | `material: AdapterRead<ContactMaterialRead>` | The core has no idea whether a layer is a garment, a blanket, or a table, and the neutrality test forbids it learning. Same reason `remove_garment` → `remove_material_layer` and `contact_wardrobe_unavailable` → `contact.material_unavailable`. |
| `pose`, `environment`, `bodyStateCut` on the action context | Dropped | Pose folds into `geometry` (one unowned read is honest; two are ceremony). Environment and body state are FRAME inputs for the observation stage — nothing about whether a contact *may* happen reads them. |
| `ContactAccessMode` includes `implicit_adjustment` | Removed from the vocabulary | It is orthogonal to what lies between the surfaces. One enum carrying both would make a hand-through-fabric contact report itself as adjusted rather than filtered. Adjustments ride `implicitAdjustments`. `unresolved` was added for the unreadable case. |
| `pressure` and `contactArea` required on `CommittedContactRead` | **Optional** | The repo's oldest degraded-read law: unknown is not a convenient default. A contact whose pressure nobody stated is not a `trace` press, and a pressure-dependent observation must fall silent rather than describe the lightest thing that could be true. |
| `ContactLifecycleCommit` has three cases | **Four** — `contact_continued` added | The draft described the no-write case in prose. Making it a case is what lets "an unchanged sustained contact keeps its id without a duplicate start event" be asserted rather than inferred from the absence of an event. The continue path also returns the *same state reference*. |
| Committable resolution carries `materialBetween` and `implicitAdjustments` inline | Nested in `access: ContactAccessResult` | The access result already carries both; two copies invite divergence. |
| Diagnostic codes `contact_action_context_invalid`, … | Dotted `contact.*` | Matches `affordance.input.unavailable` and `guidance.disclosure.leak`. Only the ten codes slice 1 actually emits exist; a constant nobody pushes is a promise the surface cannot keep. |
| — | `ContactId` is **derived**, not minted | `pairKey + start event ref`. No counter, no clock: a retake replaying the same attempt against the same cut must reproduce the identical id or the capture fingerprints diverge. |
| — | The pair key is **order-independent** | "The player's hand on her arch" and "her arch against his hand" are one touch. Keying by acting direction would let a role swap open a second contact on the same surfaces and both would then report pressure. Orientation is preserved on `source`/`target` and is never patched. |
| — | `phase: "active"` vs `phase: "ended"` as separate types | "An ended contact cannot enter a current frame" becomes a compile error rather than a rule. Likewise a non-committable resolution has no `intent`, so it cannot be passed to `commitContactResolution` at all. |

### Rulings — confirmed by the owner 2026-07-30

`contactActionRequiresAdultEligibility` and `contactActionRequiresPermission`
both return true for `romantic` and `intimate` only. That was shipped as the
conservative half of the audit's
[owner decisions](romantic-contact-affordances.audit.md#owner-decisions-needed)
1 and 3; **the owner has since confirmed it as the ruling** (recorded inline in
the audit): positive adult eligibility for every participant on romantic and
intimate kinds, permission-neutral incidental/affectionate touch, and
romantic/fetish-framed foot play classified `romantic` — never relabeled to
make a trial commit. Scope membership is checked exactly: the core never
widens a grant, because "the more intimate permission implies the less
intimate one" is a product decision and not an obvious one. A lane that
believes a broader grant subsumes a narrower one lists both scopes.

### Not built, and where it went

Observations, phenomena, cue ranking, perception filtering, effect proposal and
commit, retake capture (`ContactPresentationCapture`), and the
`RegionalContactFrame` are all absent — they belong to slices 2–4 and to the
[effects companion](romantic-contact-affordances.spec.effects.md). Storage is
absent by design: `state.ts` settles the versioned shape and the healing rule so
they are not decided twice. The plan's *"Where should committed contact
live?"* was **ruled by the owner 2026-07-30**: a durable event/action is the
provenance, plus a versioned active-contact projection captured in the chat's
retake snapshot — contact can never remain prompt-local. `state.ts`'s
`parseContactLifecycleState` is already shaped for exactly that projection;
the slice that wires the lane (slice 3) implements the ruling.
