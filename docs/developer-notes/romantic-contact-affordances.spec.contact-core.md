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
| `*.test.ts` | 5 files / 92 cases: resolve, lifecycle, material, state, neutrality. |

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
`CONTACT_ACTION_SCOPE` · ~~`CONTACT_RESOLUTION_ACTION_STATUS`~~ (removed in
slice 3A; `contactActionOutcomeStatus` replaces it).

### Deltas from the draft above — this section is the authority

| Draft | As built | Why |
| --- | --- | --- |
| `ContactResolution` has three statuses | **Four**: `committable`, `explicit_transition_required`, `rejected`, `unresolved` | The narrator seam already exists and its `PhysicalActionStatus` carries `unresolved`. An unanswerable owner is not a rejection: a rejection is a story fact the narrator must resolve, while `unresolved` produces silence. `partially_committed` is deliberately **not** modelled — no producer exists until the foot slice needs per-locus commitment. *(Slice 3A superseded the translation: `CONTACT_RESOLUTION_ACTION_STATUS` mapped `committable → committed` directly and is **gone** — see [As built — slice 3A](#as-built--slice-3a-authority-and-persistence-hardening).)* |
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
| The lifecycle `contentKey` fingerprints `materialBetween` by `layerId` | **(errata, 2026-07-30)** It fingerprints each layer's CONTENT — `layerId`, `order`, and the six transmission/visibility fields — after a canonical `sortContactMaterialLayers` | A `layerId` is the wardrobe's own instance id and it survives the garment changing underneath it: a sock soaking through keeps its id while its permeability, moisture transmission, and shape transmission all move. The id-only key took the `contact_continued` path for exactly that case, so the projection kept the dry snapshot and every observation downstream described a material that no longer existed. Two deliberate exclusions: **array position is not content** (the canonical order is total and `order` is itself fingerprinted, so a layer that genuinely moved in the stack is a change while an adapter returning the same layers in a different array order is not — otherwise a re-read of an unchanged cut would write an update event for a presentation detail); and **`evidence` is not content** (it is provenance, and a ref that varies per read would emit `contact_updated` every exchange for a contact nothing happened to — the mirror image of the bug being fixed). `implicitAdjustments` stay keyed by `id`: an accepted adjustment is minted by `classifyContactAdjustment` from one proposal and carries no magnitude that could drift. |
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
silence, an `unresolved` answer, or eligibility that stopped covering a
participant ends it as `state_invalidated` — the two reasons keep "she withdrew
it" distinguishable from "we could not ask" in the durable record. Kinds that
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

| Checked on read | Failure |
| --- | --- |
| `pairKey` recomputed from `source`/`target` | `pair_key_mismatch` |
| `contactId` re-derived from pair + start event (via `contactIdMatchesDerivation`, the non-throwing half of `deriveContactId` — a boundary check must return an answer, not raise) | `contact_id_not_derived` |
| `source.subjectId === actorId` | `source_is_not_the_actor` |
| `actorControl.actorId === actorId`, status `allowed` | `actor_control_names_another_subject` / `actor_control_did_not_allow` |
| `lastUpdatedAt >= startedAt` | `last_updated_precedes_start` |
| eligibility covers every participant, when the kind needs it | `eligibility_does_not_cover` |
| permission `allowed` and naming the action's scope, when the kind needs it | `permission_does_not_allow` / `permission_scope_missing` |

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

| Change | Callers must know |
| --- | --- |
| `ContactActionContext.targetAgency` → **`targetAgencies: readonly ContactTargetAgencyDecision[]`** | Wrap the single decision in a list. |
| `ContactTargetAgencyDecision.targetId` optional → **required** | Name the body the decision is about. |
| `CommittedContactUpdate` → **`CommittedContactSnapshot`**; `contact_updated.patch` → **`.snapshot`** | Full replacement, `null` for cleared optionals. |
| `ContactCommitOutcome` gains **`ended: readonly ContactEndedCommit[]`** (additive) | Persist `contactCommitEvents(outcome)`, ends first. |
| **`CONTACT_RESOLUTION_ACTION_STATUS` removed** | Use `contactActionOutcomeStatus`. |
| New: `outcome.ts`, `applyContactCommit`, `replayContactCommits`, `contactCommitEvents`, `endUnauthorizedContacts`, `contactIdMatchesDerivation` | — |
| `contactIdSchema` max 1024 → **4096** | A legal id composed from two verbose subject ids already crossed the old bound, which made `deriveContactId` a throw on the commit path. |
| New diagnostics: `contact.authorization_lapsed`, `contact.state_recomputed`, `contact.commit_unacknowledged`; `contact.lifecycle_invalid` now also `warn` for absorbed contradictions | — |

Tests: 6 files / 139 cases in `contact/` (was 5 / 92 at slice 1), including
every regression the review asked for — actor/source mismatch, wrong-target
authorization, several adjusted participants, changed contact preserving
orientation, cleared pressure/motion/area surviving replay, a stale assertion
refused through both the update and the framing door, permission
withdrawal under a live contact, malformed version, tampered pair key /
contact id / transmission / decision participants, capacity without
projection-only eviction, `committed` only after persistence, and no
contact-specific `partially_committed`.
