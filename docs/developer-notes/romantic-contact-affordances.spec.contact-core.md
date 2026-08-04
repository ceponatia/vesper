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


`InteractionPolicyRead` is supplied by the lane's permission/consent owner.
For continuation item 5, the
[directional permission specification](romantic-contact-affordances.spec.permission.md)
defines when that read is required, what exact scope it may contain, and how it
is restored. The contact core never derives a grant from attraction, arousal,
relationship score, narrative framing, touch welcomeness, or physical
feasibility. A future relationship decline may cause the permission owner to
commit a revocation event; it does not make the contact resolver calculate
consent from a relationship label.

For interpersonal contact:

- the actor-control decision must cover the initiating movement;
- target permission uses the lane's applicable interaction policy, including
  exact direction and scope;
- romantic contact aimed at an NPC requires a grant from that NPC to the actor;
- NPC-to-NPC contact requires the corresponding directional grant even when the
  reverse direction is already allowed;
- when the target is the player, the permission owner does not pre-calculate a
  standing grant before an NPC acts; the player retains sole authority over
  their reaction, and the narrator cannot commit acceptance or reciprocation;
- a voluntary target adjustment/reaction must be committed by the target's
  behavior authority;
- missing required control or permission rejects commitment.

For romantic/intimate actions in addition:

- `allowed` must be explicit, directional, and exact-scope compatible;
- `romantic_touch` never implies kissing, intimate touch, undressing, nudity
  exposure, or sex;
- withdrawal or contradiction rejects the action and ends any active contact
  that depended on the lapsed grant;
- missing/invalid policy fails closed where the permission specification
  requires a grant;
- legacy chat's intimacy signal may gate prompting but is not automatically a
  permission grant;
- successor `consent_covered` resolution remains authoritative where present,
  but parity cannot be claimed until direction, scope, chronology, revocation,
  and rollback behavior match.

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
- ordinary permission-neutral contact remains permission-neutral;
- player-to-NPC romantic contact requires the NPC's directional grant;
- one NPC's romantic contact toward another requires the target NPC's
  directional grant, regardless of the reverse grant;
- NPC-to-player contact does not pre-authorize or narrate the player's reaction;
- a grant for another scope cannot authorize `romantic_touch`, and
  `romantic_touch` cannot authorize a future intimate scope;
- a later grant cannot authorize an earlier same-reply action;
- permission missing or withdrawn rejects contact where a grant is required;
- permission withdrawal ends a dependent live contact as
  `policy_withdrawn`;
- legacy intimacy framing does not become a permission grant;
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

The settled permission-owner decisions and tests live in the
[permission spec](romantic-contact-affordances.spec.permission.md). Remaining
product questions stay in the
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

- **File: `identity.ts`**
  - **Responsibility:** `ContactId`, `ContactEventRef`, `ContactEntityId`; the order-independent pair key and `deriveContactId`.
- **File: `surfaces.ts`**
  - **Responsibility:** Body and object surface refs over `bodyLocationRegistry`; surface/pair keys; participant extraction.
- **File: `material.ts`**
  - **Responsibility:** `ContactMaterialLayerRead`, `ContactMaterialTransmissionRead`, `composeContactMaterial`.
- **File: `decisions.ts`**
  - **Responsibility:** Action kinds → policy scopes; actor control, target agency, and permission; the implicit-adjustment policy; requirement and rejection vocabularies.
- **File: `types.ts`**
  - **Responsibility:** Bands, intent, context, access result, the four-status resolution, `CommittedContactRead`, `EndedContactRecord`, the lifecycle commit union.
- **File: `resolve.ts`**
  - **Responsibility:** `resolveContactAttempt` — the whole gate.
- **File: `lifecycle.ts`**
  - **Responsibility:** `commitContactResolution`, `modulateContactGesture`, `endContact`, `endAllContacts`, the active projection and its reads.
- **File: `state.ts`**
  - **Responsibility:** `committedContactReadSchema`, `parseContactLifecycleState` — the versioned shape and its healing.
- **File: `diagnostics.ts`**
  - **Responsibility:** The ten codes slice 1 emits.
- **File: `test-support.ts`**
  - **Responsibility:** `probe*` fixture builders. Deliberately **not** in the barrel.
- **File: `*.test.ts`**
  - **Responsibility:** 5 files / 92 cases: resolve, lifecycle, material, state, neutrality.

### Public API

`resolveContactAttempt({ intent, context, sink? }) → ContactResolution` ·
`commitContactResolution({ state, resolution, eventRef, sink? }) → ContactCommitOutcome`
(a **union** since slice 3A.1 — see
[As built — slice 3A.1](#as-built--slice-3a1-boundary-corrections)) ·
`modulateContactGesture({ state, contactId, pressure, motion, eventRef, storyTime, sink? })
→ ContactGestureModulationOutcome` (the gesture-only update the NPC reply-scene
leg commits through — see
[romantic-contact-affordances.spec.actor-control.md](romantic-contact-affordances.spec.actor-control.md)
§"Resolution laws → Contact update") ·
`endContact({ state, contactId, reason, storyTime, eventRef, sink? })` ·
`endAllContacts({ state, reason, storyTime, eventRef, sink? })` ·
`activeContact` / `activeContactForPair` / `activeContactsOf` ·
`emptyContactLifecycleState` / `parseContactLifecycleState` ·
`classifyContactAdjustment` · `composeContactMaterial` / `sortContactMaterialLayers` /
`directContactTransmission` · `contactPairKey` / `contactSurfaceKey` /
`contactParticipantIds` / `isInterpersonalContact` / `isKnownContactBodyLocation` ·
`contactActionRequiresPermission` /
`CONTACT_ACTION_SCOPE` · ~~`CONTACT_RESOLUTION_ACTION_STATUS`~~ (removed in
slice 3A; `contactActionOutcomeStatus` replaces it).

### Deltas from the draft above — this section is the authority

- **Draft: `ContactResolution` has three statuses**
  - **As built:** **Four**: `committable`, `explicit_transition_required`, `rejected`, `unresolved`
  - **Why:** The narrator seam already exists and its `PhysicalActionStatus` carries `unresolved`. An unanswerable owner is not a rejection: a rejection is a story fact the narrator must resolve, while `unresolved` produces silence. `partially_committed` is deliberately **not** modelled — no producer exists until the foot slice needs per-locus commitment. *(Slice 3A superseded the translation: `CONTACT_RESOLUTION_ACTION_STATUS` mapped `committable → committed` directly and is **gone** — see [As built — slice 3A](#as-built--slice-3a-authority-and-persistence-hardening).)*
- **Draft: `EventId`, `CharacterId`, `EntityId`, `StoryTimestamp`**
  - **As built:** `ContactEventRef`, `AffordanceSubjectId`, `ContactEntityId`, `AffordanceStoryTime`
  - **Why:** The successor lane's branded `EventId` is a simulation id legacy chat cannot mint; binding to it would fork the core. Subject ids and story time already exist in `affordances/core` and are reused unchanged.
- **Draft: `MaterialLayerRead`, `MaterialTransmissionRead`, `MinimalPoseAdjustment`, `ActionRequirement`**
  - **As built:** `Contact`-prefixed
  - **Why:** These names go through `export *` in `affordances/index.ts`; unprefixed generic nouns in a shared barrel are a collision waiting to happen.
- **Draft: `wardrobe: PairWardrobeRead`**
  - **As built:** `material: AdapterRead<ContactMaterialRead>`
  - **Why:** The core has no idea whether a layer is a garment, a blanket, or a table, and the neutrality test forbids it learning. Same reason `remove_garment` → `remove_material_layer` and `contact_wardrobe_unavailable` → `contact.material_unavailable`.
- **Draft: `pose`, `environment`, `bodyStateCut` on the action context**
  - **As built:** Dropped
  - **Why:** Pose folds into `geometry` (one unowned read is honest; two are ceremony). Environment and body state are FRAME inputs for the observation stage — nothing about whether a contact *may* happen reads them.
- **Draft: `ContactAccessMode` includes `implicit_adjustment`**
  - **As built:** Removed from the vocabulary
  - **Why:** It is orthogonal to what lies between the surfaces. One enum carrying both would make a hand-through-fabric contact report itself as adjusted rather than filtered. Adjustments ride `implicitAdjustments`. `unresolved` was added for the unreadable case.
- **Draft: `pressure` and `contactArea` required on `CommittedContactRead`**
  - **As built:** **Optional**
  - **Why:** The repo's oldest degraded-read law: unknown is not a convenient default. A contact whose pressure nobody stated is not a `trace` press, and a pressure-dependent observation must fall silent rather than describe the lightest thing that could be true.
- **Draft: `ContactLifecycleCommit` has three cases**
  - **As built:** **Four** — `contact_continued` added
  - **Why:** The draft described the no-write case in prose. Making it a case is what lets "an unchanged sustained contact keeps its id without a duplicate start event" be asserted rather than inferred from the absence of an event. The continue path also returns the *same state reference*.
- **Draft: Committable resolution carries `materialBetween` and `implicitAdjustments` inline**
  - **As built:** Nested in `access: ContactAccessResult`
  - **Why:** The access result already carries both; two copies invite divergence.
- **Draft: Diagnostic codes `contact_action_context_invalid`, …**
  - **As built:** Dotted `contact.*`
  - **Why:** Matches `affordance.input.unavailable` and `guidance.disclosure.leak`. Only the ten codes slice 1 actually emits exist; a constant nobody pushes is a promise the surface cannot keep.
- **Draft: —**
  - **As built:** `ContactId` is **derived**, not minted
  - **Why:** `pairKey + start event ref`. No counter, no clock: a retake replaying the same attempt against the same cut must reproduce the identical id or the capture fingerprints diverge.
- **Draft: —**
  - **As built:** The pair key is **order-independent**
  - **Why:** "The player's hand on her arch" and "her arch against his hand" are one touch. Keying by acting direction would let a role swap open a second contact on the same surfaces and both would then report pressure. Orientation is preserved on `source`/`target` and is never patched.
- **Draft: The lifecycle `contentKey` fingerprints `materialBetween` by `layerId`**
  - **As built:** **(errata, 2026-07-30)** It fingerprints each layer's CONTENT — `layerId`, `order`, and the six transmission/visibility fields — after a canonical `sortContactMaterialLayers`
  - **Why:** A `layerId` is the wardrobe's own instance id and it survives the garment changing underneath it: a sock soaking through keeps its id while its permeability, moisture transmission, and shape transmission all move. The id-only key took the `contact_continued` path for exactly that case, so the projection kept the dry snapshot and every observation downstream described a material that no longer existed. Two deliberate exclusions: **array position is not content** (the canonical order is total and `order` is itself fingerprinted, so a layer that genuinely moved in the stack is a change while an adapter returning the same layers in a different array order is not — otherwise a re-read of an unchanged cut would write an update event for a presentation detail); and **`evidence` is not content** (it is provenance, and a ref that varies per read would emit `contact_updated` every exchange for a contact nothing happened to — the mirror image of the bug being fixed). `implicitAdjustments` stay keyed by `id`: an accepted adjustment is minted by `classifyContactAdjustment` from one proposal and carries no magnitude that could drift.
- **Draft: —**
  - **As built:** `phase: "active"` vs `phase: "ended"` as separate types
  - **Why:** "An ended contact cannot enter a current frame" becomes a compile error rather than a rule. Likewise a non-committable resolution has no `intent`, so it cannot be passed to `commitContactResolution` at all.

### Rulings — confirmed by the owner 2026-07-30

`contactActionRequiresPermission` returns true for `romantic` and `intimate`
only. The owner confirmed permission-neutral incidental/affectionate touch and
classified romantic/fetish-framed foot play as `romantic` — never relabeled to
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

## As built — slice 3A: authority and persistence hardening

Shipped 2026-07-31, before any lane wiring, from the owner's external review of
slice 1. Four defects, all of the same family: a gate that answered about the
right *question* but not about the right *body*, and a projection that was
treated as truth rather than as a cache of durable events. Contracts only — no
storage, no lane, no migration.

### The invariants this slice added

**1. The acting surface belongs to the actor.** `intent.source.subjectId` must
equal `intent.actorId`; a mismatch is `unresolved` / `action_invalid` with an
`error` diagnostic, checked in the structure pass before anything else. A
control decision that legitimately covers actor A otherwise authorized an
attempt made with B's hands, and every check after it inherited the
substitution. `CommittedContactRead` documents the same equality as start
identity, and `state.ts` re-checks it on read.

**2. Agency coverage is per participant.** `ContactActionContext.targetAgency`
(one decision) became `targetAgencies` (a list), and
`ContactTargetAgencyDecision.targetId` is now **required**. The resolver
collects every non-actor body an adjustment moves and demands the decision
naming *that* body; a decision about somebody else covers nothing. An
adjustment naming a subject who is not part of the contact at all is
`unresolved` / `action_invalid` (`error`) — a third character's movement is its
own action, not a rider on this one. Consequence worth stating: because a
contact has at most two participants and the source belongs to the actor, the
set of moved non-actor bodies is at most one; the list shape is what makes
coverage checkable rather than a promise. When several decisions are consulted,
a `denied` outranks a missing or `unresolved` one — "she would not move" is a
beat the narrator can carry, and reporting it as unreadable would throw that
away.

**3. Start identity is immutable for the contact's lifetime.** `contactId`,
`pairKey`, `startedAt`, `startedByEventRef`, `actorId`, `actionKind`, `source`,
`target`, **and the three decisions** belong to the contact that began. The pair
key is order-independent, so the same touch can be re-asserted from the other
side; taking that assertion's orientation silently rewrote who was touching
whom. An update replaces only the physical half plus its evidence. (The material
stack is snapshotted from the asserting read, and `order` is relative to that
read's source — composition is invariant under reversal, so only the recorded
stack order differs.)

**4. Update events are full snapshots, not patches.** `CommittedContactUpdate`
became `CommittedContactSnapshot`, with `null` for every optional value that is
not stated and `transmission` carried along. A patch cannot express removal: an
event that simply omitted a pressure the contact no longer has replayed as the
old pressure, so the returned projection was right and the durable record was
wrong. `applyContactCommit` / `replayContactCommits` fold a stream back into a
projection using **only** the durable fields — the `contact` riding on an update
commit is ignored, so a lane that persists the minimum replays identically.

**5. Nothing leaves the projection without an event.** Capacity pressure used to
drop the oldest contact from the projection and file a diagnostic; a drop with
no event behind it replays back into existence and is indistinguishable from a
contact that really ended. Capacity now ends the oldest with real
`contact_ended` commits (`state_invalidated`), returned on
`ContactCommitOutcome.ended` and ordered ahead of the new commit by
`contactCommitEvents`. **Reject-vs-end:** ending was chosen over refusing the
new contact because the core cannot mint an event ref of its own, so "persist an
explicit end event" is the only one of the owner's two options it can perform
without inventing lane identity — and it keeps the outcome type additive for
callers.

**6. A framing change is a new contact.** An assertion whose `actionKind`
differs from the live contact's ends that contact (`state_invalidated`, `warn`)
and starts a fresh one with its own id and its own permission evidence — the
answer to "what happens when action framing changes while contact continues".
Subject to invariant 7 below: a *stale* framing change ends nothing.
Silently keeping the old kind would have left an escalated touch recorded under
the framing that was permitted for the gentler one.

**7. A stale assertion cannot rewrite a newer projection.** An intent whose
story time predates the contact's `lastUpdatedAt` continues the contact and
files a `warn` rather than winding time backwards — which is also what keeps
`lastUpdatedAt >= startedAt` true by construction, the invariant `state.ts`
enforces on read. The check runs **first, for every assertion on an occupied
pair**, ahead of the same-kind/framing split: guarding only the update path
left the rule a door, because a stale assertion carrying a different
`actionKind` fell through to invariant 6 and ended a newer contact at a story
time before its own last update, then started a replacement whose `startedAt`
predated what it displaced. "This is a different kind of touch" says nothing
about which of two writes is the later one, so nothing ends and nothing starts
until the assertion has proved it is current.

**8. Withdrawn permission ENDS a live contact (owner ruling).** The resolver is
the *block* half — a withdrawn or unresolved grant never produces a committable
resolution — and `endUnauthorizedContacts` is the *end* half, for contacts
nobody re-asserted. Per active contact whose kind needs authorization
(interpersonal `romantic` / `intimate`): a `denied`/`withdrawn` answer, or a
grant that no longer names the action's scope, ends it as `policy_withdrawn`;
silence or an `unresolved` answer ends it as `state_invalidated` — the two
reasons keep "she withdrew it" distinguishable from "we could not ask" in the
durable record. Kinds that
never needed a grant (incidental / casual / affectionate, self-contact, contact
with an object) are untouched, exactly as the resolver never demanded one.

**9. Stored projections are untrusted derived data.** `parseContactLifecycleState`
now **fails closed on the version**: `version` is read as `unknown` and anything
that is not exactly the current integer degrades to the empty projection with a
diagnostic. The old `.catch(CURRENT)` turned a malformed version into the
current one — a blob nobody wrote for this build, read as though they had. Every
surviving row then passes cross-field checks, and a row that fails one is
dropped exactly like a row that failed its schema (an absent contact means *no
contact*, which can never buy a claim):

- **Checked on read: `pairKey` recomputed from `source`/`target`**
  - **Failure:** `pair_key_mismatch`
- **Checked on read: `contactId` re-derived from pair + start event (via `contactIdMatchesDerivation`, the non-throwing half of `deriveContactId` — a boundary check must return an answer, not raise)**
  - **Failure:** `contact_id_not_derived`
- **Checked on read: `source.subjectId === actorId`**
  - **Failure:** `source_is_not_the_actor`
- **Checked on read: `actorControl.actorId === actorId`, status `allowed`**
  - **Failure:** `actor_control_names_another_subject` / `actor_control_did_not_allow`
- **Checked on read: `lastUpdatedAt >= startedAt`**
  - **Failure:** `last_updated_precedes_start`
- **Checked on read: permission `allowed` and naming the action's scope, when the kind needs it**
  - **Failure:** `permission_does_not_allow` / `permission_scope_missing`

`transmission` is the one field **recomputed rather than rejected**
(`CONTACT_STATE_RECOMPUTED`, `warn`): it is derived from `materialBetween`, and
re-deriving can only ever narrow the claim — a stack of layers can never compose
to bare skin. That is the exact direction the owner named: a stored
`directSkinContact: true` sitting beside stored layers is not trusted. Every
other field is a claim in its own right, and repairing one would invent the
thing the plan says may never be invented.

**10. `committed` means persisted.** `CONTACT_RESOLUTION_ACTION_STATUS` mapped
`committable → committed` with a constant, handing the narrator a fact the store
may never have written. It is gone. `contact/outcome.ts` replaces it with
`contactActionOutcomeStatus({ resolution, acknowledgment, sink })`: the three
non-committable statuses pass through, and `committed` is reachable **only**
through a `{ kind: "persisted", contactId, commitKind }` acknowledgment the lane
produces after its durable write. No acknowledgment is an `error` diagnostic and
`unresolved`; a `not_persisted` answer is a `warn` and `unresolved` — silence,
never a claim. `ContactActionOutcomeStatus` is the four-value subset of the
seam's `PhysicalActionStatus`, so a contact `partially_committed` is
**unrepresentable**, not merely untested; the generic guidance vocabulary keeps
its fifth value for a future domain that grows a producer, and a test pins both
halves.

### File and API deltas

- **Change: `ContactActionContext.targetAgency` → **`targetAgencies: readonly ContactTargetAgencyDecision[]`****
  - **Callers must know:** Wrap the single decision in a list.
- **Change: `ContactTargetAgencyDecision.targetId` optional → **required****
  - **Callers must know:** Name the body the decision is about.
- **Change: `CommittedContactUpdate` → **`CommittedContactSnapshot`**; `contact_updated.patch` → **`.snapshot`****
  - **Callers must know:** Full replacement, `null` for cleared optionals.
- **Change: `ContactCommitOutcome` gains **`ended: readonly ContactEndedCommit[]`** (additive)**
  - **Callers must know:** Persist `contactCommitEvents(outcome)`, ends first.
- **Change: **`CONTACT_RESOLUTION_ACTION_STATUS` removed****
  - **Callers must know:** Use `contactActionOutcomeStatus`.
- **Change: New: `outcome.ts`, `applyContactCommit`, `replayContactCommits`, `contactCommitEvents`, `endUnauthorizedContacts`, `contactIdMatchesDerivation`**
  - **Callers must know:** —
- **Change: `contactIdSchema` max 1024 → **4096****
  - **Callers must know:** A legal id composed from two verbose subject ids already crossed the old bound, which made `deriveContactId` a throw on the commit path.
- **Change: New diagnostics: `contact.authorization_lapsed`, `contact.state_recomputed`, `contact.commit_unacknowledged`; `contact.lifecycle_invalid` now also `warn` for absorbed contradictions**
  - **Callers must know:** —

Tests: 6 files / 139 cases in `contact/` (was 5 / 92 at slice 1), including
every regression the review asked for — actor/source mismatch, wrong-target
authorization, several adjusted participants, changed contact preserving
orientation, cleared pressure/motion/area surviving replay, a stale assertion
refused through both the update and the framing door, permission
withdrawal under a live contact, malformed version, tampered pair key /
contact id / transmission / decision participants, capacity without
projection-only eviction, `committed` only after persistence, and no
contact-specific `partially_committed`.

## As built — slice 3A.1: boundary corrections

Shipped 2026-07-31, still before any lane wiring, from the owner's review of the
shipped 3A. The original findings were closed; what the review exposed was a
**second ring of the same family** — a proof that was checked and then thrown
away, an acknowledgment that was structurally valid and about the wrong write, a
staleness rule that guarded one pair and nothing else, and a status line drawn
between *bad news* and *good news* instead of between *an answer* and *a
silence*. Contracts only — no storage, no lane, no migration.

### The invariants this slice added

**11. The agency proof is persisted, and one body gets one answer.**
`implicitAdjustments` is a durable claim that a body MOVED; nothing beside it
recorded that the body's own authority allowed the movement, because the
resolver consulted the decision and then discarded it. A committable resolution
and `CommittedContactRead` now carry **`targetAgencies`** — the CONSULTED,
participant-keyed decisions, one per non-actor body an admitted adjustment
moves, empty in the ordinary case. They are start identity like the three reads
beside them (authorization evidence for the contact that *began*, never patched
by a later assertion) and they are in the stored schema, where
`storedContactProblem` demands an `allowed` decision naming every adjusted
non-actor participant (`agency_does_not_cover_adjustment`).

Coverage is also matched by **first hit**, and a first hit only means something
when there is exactly one. Two decisions naming the same `targetId` let an
earlier `allowed` swallow a later `denied` — the refusal most worth honouring is
the one silently lost — and there is no principled tie-break, because both
claim the same authority over the same body. A duplicate is therefore a context
built wrong, not a story fact: `unresolved` / `action_invalid` with an `error`,
exactly like a decision about a different actor, checked over the whole list
(a list that contradicts itself about one body says nothing reliable about the
others) and re-checked on read as `duplicate_agency_decision`.

**12. No contact ends before its own last update.** Invariant 7 protects the
pair being asserted and nothing else, and every end path could reach a contact
the assertion never mentioned. An end stamped earlier than the contact's
`lastUpdatedAt` writes a record whose `endedAt` precedes facts already committed
about that contact, so replay sees a contact that ended before it was last
touched. Every end now checks the contact it is about to end (equality is fine —
a same-minute release is ordinary):

- **Path: `endContact`**
  - **Ruling:** No-op, `warn`, state unchanged, no commit
  - **Why not the alternative:** Silently succeeding makes a back-dated end indistinguishable from a real one on replay. A later end at a current story time still closes it.
- **Path: `endAllContacts` (scene exit at an older time)**
  - **Ruling:** **Per contact**: the stale ones stay ALIVE with a `warn`, the rest end normally; the returned state is no longer unconditionally empty
  - **Why not the alternative:** Refusing the whole request would throw away the ends of every contact the exit legitimately covers; ending the newer one anyway would back-date it. A caller really leaving the scene re-issues at the current time or ends the survivors by id.
- **Path: `endUnauthorizedContacts` (sweep at an older time)**
  - **Ruling:** Same: the newer contact survives the sweep, `warn`
  - **Why not the alternative:** A sweep is a read of what is true NOW, so an older one is an out-of-order write — and a lapsed authorization does not un-lapse, so the next sweep ends it at a time that is actually current.
- **Path: Capacity eviction**
  - **Ruling:** **Refuses the new start** (see 13)
  - **Why not the alternative:** The core cannot mint an end at the victim's own later time without inventing a story minute nobody asserted, and cannot end it at the incoming time without back-dating.

**13. A commit that cannot be made honestly is REFUSED, and a refusal is not a
contact.** `ContactCommitOutcome` is now a **union** rather than a record:

```ts
type ContactCommitOutcome =
  | { status: "committed"; state; commit; contact; ended }
  | { status: "refused"; reason: ContactCommitRefusalReason; state; blockedBy: readonly ContactId[] };
```

The discriminant is load-bearing and the shape is the guarantee: a refusal has
no `commit` and no `contact` **at all**, so a caller cannot read a started
contact off one by forgetting to check — the same device `ContactResolution`
uses to stop an attempt masquerading as a commitment, applied one stage later.
`state` is returned unchanged, `contactCommitEvents` is `[]` (so a lane that
persists it unconditionally stays correct without learning the union), and the
one producer today is `capacity_blocked_by_newer_contact`: the projection is
full and its oldest contact is newer than this assertion. Capacity is evaluated
**before** anything is ended or reported, so a refusal never has to unwind a
framing end it already announced. The reason is a vocabulary rather than a
boolean because "the fold could not proceed" is the shape a future refusal would
also take. **This reverses slice 3A's reject-vs-end note** for the stale case
only: ending with a real event is still right when the victims are older, and is
simply unavailable when they are not.

**14. `committed` means *this action's* commit was persisted.** A structurally
valid `persisted` acknowledgment used to be enough, and "a write happened" is
not the claim the narrator hears — the narrator hears "THIS action's contact is
now current truth". An acknowledgment can be true and still not say that: it can
name a different contact, report a commit kind this action never produced, be
the reply to an EARLIER write on the same contact (a retry, a queued turn, a
rolled-back attempt), or acknowledge the write that **ended** the contact — a
durable, successful, correctly-shaped write whose meaning is the opposite of
`committed`.

So the adapter compares instead of trusting. `ContactPersistenceAcknowledgment`
gains `eventRef` and `actionId`; `contactActionOutcomeStatus` takes
`expected: ContactCommitExpectation` — `{ contactId, commitKind, eventRef,
actionId }`, built from the fold by `contactCommitExpectation({ outcome,
eventRef, actionId })` (which returns `undefined` for a refused outcome, so a
refusal cannot be acknowledged into existence). Every field must match, and the
first disagreement is reported as `contact.commit_acknowledgment_mismatch`
(`error`, with the mismatch named: `contact_id`, `commit_kind`, `event_ref`,
`action_id`, `commit_ended_the_contact`). Any mismatch, a missing expectation,
and a missing acknowledgment all resolve `unresolved` — never `committed`. The
new code is separate from `contact.commit_unacknowledged` on purpose: a missing
acknowledgment is a pipeline that forgot to ask the store, a mismatched one is a
pipeline that asked and believed the wrong answer, and only the second means
somebody's bookkeeping is crossed.

### The status line: an answer versus a silence

`resolve.ts` mapped unresolved actor control, missing target agency,
and unanswered permission to **`rejected`**
— while its own comments said "we could not read the owner" should produce
silence. Guidance *mandates* that the narrator resolve a `rejected` outcome, so
a silent adapter had a character written declining something nobody had asked
her about. The line is now drawn by **who spoke**, not by how bad the news is:

- **Outcome: `rejected`**
  - **Reason:** `actor_control_denied`
  - **Narration:** The refusal is played
  - **Diagnostic:** none
- **Outcome: `rejected`**
  - **Reason:** `target_agency_denied`
  - **Narration:** The refusal is played
  - **Diagnostic:** none
- **Outcome: `rejected`**
  - **Reason:** `permission_denied` / `permission_withdrawn`
  - **Narration:** The refusal is played
  - **Diagnostic:** none
- **Outcome: `rejected`**
  - **Reason:** `permission_scope_missing` — an answered grant that does not cover *this* action is an answer about this action
  - **Narration:** The refusal is played
  - **Diagnostic:** `contact.consent_required` (`warn`; a permission UI wants it)
- **Outcome: `rejected`**
  - **Reason:** `out_of_reach`
  - **Narration:** The refusal is played
  - **Diagnostic:** none
- **Outcome: `unresolved`**
  - **Reason:** `actor_control_unresolved`
  - **Narration:** **Silence**
  - **Diagnostic:** `contact.actor_control_unavailable` (`warn`)
- **Outcome: `unresolved`**
  - **Reason:** `target_agency_unresolved` — missing, `unresolved`, or `not_required` while an adjustment moves that body
  - **Narration:** **Silence**
  - **Diagnostic:** `contact.target_agency_unavailable` (`warn`)
- **Outcome: `unresolved`**
  - **Reason:** `permission_unresolved` — `unresolved` or `not_required`
  - **Narration:** **Silence**
  - **Diagnostic:** `contact.policy_unavailable` (`warn`)
- **Outcome: `unresolved`**
  - **Reason:** `action_invalid`
  - **Narration:** **Silence**
  - **Diagnostic:** `contact.action_context_invalid` (`error`)
- **Outcome: `unresolved`**
  - **Reason:** `geometry_unavailable` / `support_unavailable` / `material_unavailable`
  - **Narration:** **Silence**
  - **Diagnostic:** the matching `contact.*_unavailable` (`warn`)

The three `*_unresolved` reasons moved from `contactRejectionReasons` to
`contactUnresolvedReasons` in `decisions.ts`; the diagnostics they already
emitted are unchanged, so the gap still surfaces — through the diagnostics
channel and the debug UI, which is where a missing owner belongs, and never
through the fiction. Two vocabulary laws are pinned by test: no reason ending
`_unresolved` may live in the rejection vocabulary, and every answered refusal
must stay in it.

### Rulings — owner, 2026-07-31

**The generic contact core stays ANATOMY-NEUTRAL.** Flagged during 3A: a
surface ref can carry `side: "center"` for a location where no such side exists,
and the core will happily key, pair, and commit it. It will **not** learn that —
the core has no anatomy and may not acquire any (its own
`domain-neutrality.test.ts` is the guardrail). The law that a foot has no
`center` side lives in the **foot adapter and schema alone**, which is where the
knowledge already is; teaching the shared core one domain's body plan is exactly
how a shared core stops being shared, and the next domain would arrive with its
own contradicting table.

### File and API deltas

- **Change: `CommittableContactResolution` and `CommittedContactRead` gain **`targetAgencies: readonly ContactTargetAgencyDecision[]`** (required; in `committedContactReadSchema`)**
  - **Callers must know:** Produced by the resolver and carried by the fold; construct a committed read only through `commitContactResolution`.
- **Change: `commitContactResolution` returns a **union**: `{ status: "committed", … } \| { status: "refused", … }`**
  - **Callers must know:** Narrow on `status` (or `isCommittedContactOutcome`) before reading `contact` / `commit` / `ended`. `state` and `contactCommitEvents` work on both.
- **Change: New: `contactCommitRefusalReasons`, `ContactCommitRefusalReason`, `CommittedContactOutcome`, `isCommittedContactOutcome`**
  - **Callers must know:** —
- **Change: `endAllContacts` gains **`sink?`** and no longer always returns the empty projection**
  - **Callers must know:** Contacts newer than the exit survive it; read the returned state rather than assuming it is empty.
- **Change: `ContactPersistenceAcknowledgment.persisted` gains **`eventRef`** and **`actionId`****
  - **Callers must know:** Stamp the acknowledgment with this action's own event and action id.
- **Change: `contactActionOutcomeStatus` gains **`expected?: ContactCommitExpectation`****
  - **Callers must know:** Build it with `contactCommitExpectation({ outcome, eventRef, actionId })`. Omitting it is `unresolved` + `error`.
- **Change: New: `contactCommitExpectation`, `ContactCommitExpectation`, `contactAcknowledgmentMismatches`, `ContactAcknowledgmentMismatch`**
  - **Callers must know:** —
- **Change: Reason codes moved from `contactRejectionReasons` to `contactUnresolvedReasons`: `actor_control_unresolved`, `target_agency_unresolved`, `permission_unresolved`**
  - **Callers must know:** A `switch` over either vocabulary must move the case. Nothing in the narration seam changes shape — the resolution's `status` does.
- **Change: New diagnostic: `contact.commit_acknowledgment_mismatch` (`error`)**
  - **Callers must know:** —
- **Change: New stored-state failures: `duplicate_agency_decision`, `agency_does_not_cover_adjustment`**
  - **Callers must know:** —

Tests: 6 files / **167** cases in `contact/` (was 6 / 139 at slice 3A) — the
consulted agencies carried onto the resolution and into start identity and
surviving an update that moves nobody, a duplicate agency decision refused both
consulted and unconsulted, stored rows dropped for missing / non-`allowed` /
wrong-body / duplicated agency proof, a stale `endContact` no-op that a current
end still closes, a scene exit that spares the newer contact and still replays
coherently, a stale sweep that spares it and a current one that ends it, a
capacity refusal with nothing written and nothing to read off it, wrong-id,
wrong-kind, stale-event-ref, wrong-action and ended-contact acknowledgments, an
acknowledgment with no fold behind it, and the two reason-vocabulary laws.

## As built — item 1.2: pre-enablement repairs (2026-07-31)

Three bounded repairs from the trial, all in the CHAT LANE adapter/pipeline —
the shared contracts in `contracts/affordances/contact/` are unchanged.

### Current-cut material (the settle-race fix)

`chatContactMaterialSource` (chat-contact-adapter.ts) now takes the CURRENT
exchange's derived coverage — `coverage: EffectiveCoverageRead | null` — and
**never reads `ChatGarmentStore.coverage`**: the persisted capture lands at the
previous exchange's settle (the race), and an old capture may describe garments
the current wardrobe no longer wears. Callers derive the argument from the
current cut:

- the live leg reuses `affordanceRead.coverage` VERBATIM when either guidance
  flag took a read this turn, else derives through
  `chatGarmentCoverageForCut` (chat-garment-affordances.ts) — the same pure
  garment stages, no cue selection, from `resolveChatWardrobe`'s own
  `worn`/`partVisibility` rows;
- present ensemble members resolve their wardrobes once (cached in the
  pipeline's `memberWardrobe`; the ensemble prompt build reuses the cache) and
  derive by the identical path;
- the previews derive the same way, so the inspector cannot explain a silence
  the live turn no longer produces.

The three honest outcomes are unchanged: derived read (empty = genuinely bare)
⇒ `supported`; dressed but unmodellable (free text, legacy worn ids, failed
derivation — diagnostic `chat_contact.coverage.derive_failed`) ⇒ `unavailable`,
with NO fallback to a stored capture; authoritatively nothing worn ⇒
`supported(empty)`. Settlement persists the exact objects the leg consumed:
the pipeline threads `contactCoverageCaptures` (primary + members, keyed by
garment actor) into `finalizeChatState`'s `affordanceCoverage` merge.

### The reach premise (S3)

`chatContactReachPremise` (chat-contact-adapter.ts) → `ChatContactReachPremise
{ targetName, locus? }`, non-null ONLY for `unresolved / geometry_unavailable`
on a detected act — typed end to end, never diagnostic-string control flow.
Rendered by `renderChatPhysicalGuidance` (optional `reachPremise` input) as one
line — "Unestablished reach: the current scene does not establish that the
player's hand can reach X's Y. Do not depict that touch as landing, and do not
invent movement by either participant to make it land." — after the
action-outcome tier. Presentation only: the resolution stays `unresolved` (no
row, no fold, no acknowledgment), other statuses/reasons keep their own typed
wording, and the bytes exist only under `CHAT_PHYSICAL_CONSTRAINTS`.

### The reply-side NPC ending (minimal actor-control deliverable)

`chat-contact-reply.ts` — `detectChatNpcContactEnding` (conservative
whole-sentence allow-list over the COMPLETED reply's narration spans; curly
quotes normalized; shared vetoes + third-person hedges; pronouns resolve only
for a sole NPC, ensembles need an unambiguous name/alias/unique first name),
`applyChatNpcContactEnding` (ends every active contact involving that NPC —
`withdrawn` surface / `separated` whole-body — via the adapter's now-exported
`endCoveredContacts`; no starts, no movement, no proximity claims), and
`chatReplyContactEventRef` (`contact-reply:<assistant id>` — disjoint from the
player leg's `contact:` namespace even on beat exchanges).

Persistence identity: rows guard on the ASSISTANT message id.
`appendChatContactEventsWithScene` writes ends + projection in one verified
transaction; a mismatch fails closed (projection unchanged,
`chat_contact.ledger.mismatch`). Retakes prune the reply-side rows explicitly
beside the exchange-guard prune (a rerun's deletes cascade via the guard FK);
identical replays land nowhere. **Ordering invariant:** the producer is the
settle's LAST scene write — after `finalizeChatState` and the ensemble garment
reconcile, both of which re-write `character_chats.scene` with the pre-ending
projection.

Tests: `chat-contact-reply.test.ts` (36 — vetoes, allow-list, subject
resolution, the fold, identity), `chat-contact-reply.int.test.ts` (10 — the
durable obligations), plus the reworked material/race/reach sections in
`chat-contact-adapter.test.ts` and `chat-contact.int.test.ts`.
