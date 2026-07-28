# Romantic contact affordances — technical index

Status: companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28, foot-first: contact-core + foot are the committed
slices 0–4 scope; the intimate spec queues behind the foot proof)

This is the coding-agent entry point. The plan owns the product intent,
reader-facing rollout, success criteria, and all open questions. These specs
own contracts, state boundaries, phenomenon definitions, diagnostics, and
fixtures.

## Reading order

| Document | Technical responsibility |
| --- | --- |
| [Shared contact core](romantic-contact-affordances.spec.contact-core.md) | Attempted action versus committed contact, access result, contact frame, policy/perception gates, effects, cue ranking, retake capture, and shared tests. |
| [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md) | Observation/constraint contracts, perception and repetition rules, plus atomic, conservative, idempotent effect commits. |
| [Foot contact](romantic-contact-affordances.spec.foot.md) | Foot surface topology, structural profiles, footwear integration, foot phenomena, and foot fixtures. |
| [Intimate contact](romantic-contact-affordances.spec.intimate.md) | Intimate topology, exposure and consent requirements, physiology inputs, intimate phenomena, and leak-prevention fixtures. |

The shared core is deliberately minimal. A helper moves into it only after both
the foot and intimate domains require the same semantics. Domain-specific
profiles and vocabulary remain in their domain specs.

## Architecture

```text
attempted action intent
        │
        ▼
action resolver
  policy + consent + geometry + pose + support + wardrobe
        │
        ├── rejected / explicit transition required
        │
        └── committed contact or motion event
                         │
                         ▼
regional contact frame
  stable anatomy + live body state + garments + environment
                         │
                         ▼
pure domain phenomena
  pressure · texture · glide · deformation · sensory access
                         │
                         ├── observations
                         ├── constraints
                         └── proposed effects
                                  │
                                  ▼
effect owner commits body / garment / residue changes
                         │
                         ▼
perception gate + relevance + novelty + repeat cap
                         │
                         ▼
bounded narrator cue block captured with the cut
```

The affordance read begins only after the action resolver commits contact.
Proposed effects are not observations until their owning event has committed
them.

## Current lane capability audit

| Capability | Legacy character chat | Successor chat | Implementation consequence |
| --- | --- | --- | --- |
| Actor control and NPC agency | Prompt rules forbid puppeting, but there is no typed physical-action admission contract. | Command/deliberation authority is stronger. | Contact admission needs an explicit control/agency result; model prose cannot commit another actor's voluntary movement. |
| Adult eligibility | Known numeric minors are fenced. Unknown/nonnumeric/fantasy ages and player eligibility are not explicit adult proofs. | Shares character profile rules; no contact-specific eligibility contract. | Intimate slices are blocked until a product-level eligibility result exists for every participant. |
| Consent/permission | Intimate-scene and touch-welcomeness signals exist, but neither is a consent grant. | Consent ledger and `consent_covered` action preconditions are fail-closed. | Shared contact consumes a normalized decision while preserving lane strength/provenance; never derive consent from intimacy or arousal. |
| Fine pose, reach, articulation, and support | Not authoritative. | Not authoritative at body-region level. | Slice 0/1 must add the minimum owner or reduce production scope. |
| Active body-surface contact | No typed lifecycle. | No typed regional contact lifecycle. | The contact core must own/bridge start, update, continue, and end before phenomena run. |
| Clothing/material-between | Structured legacy garment graph exists. | Shared successor garment adapter is pending clothing-state Slice 7. | First product proof may target legacy chat; successor parity waits for its adapter. |
| Body-surface moisture/residue/marks | No shared regional owner. | No shared regional owner. | Unknown suppresses dependent reads; Slice 4 must add/choose an atomic effect owner. |
| Physiology/temperature | General physiology is deferred. | General physiology is deferred. | Foot warmth is conditional; intimate live-state phenomena remain blocked. |
| Perception | Turn-level allowance plus coverage, no full per-sense proximity model. | Structured witness/channel observations. | Normalize unavailable channels as unavailable, not open. |
| Retake | Snapshot rollback. | Same-cut re-render. | Capture adapters differ but must produce stable contact/effect/cue fingerprints. |

The body-side evidence is recorded in the
[body-affordance readiness audit](body-attribute-affordances.audit.md).

## State ownership

| Truth | Owner | Contact layer usage |
| --- | --- | --- |
| Baseline anatomy, morphology, texture, sensitivity tendency | Canonical attributes and body configuration | Compile to typed regional profiles. |
| Current posture, articulation, support, proximity | Pose/space owner | Validate access; never infer whole posture from one local fact. |
| Garment instances, layer order, closures, displacement, material condition | Clothing state graph | Resolve material-between, exposure, compression, and filtering. |
| Wetness, sweat, vascular state, erection, swelling, lubrication, temperature | Physiology/body state | Read current values; never infer from genre, action, or anatomy. |
| Adult-content eligibility | Product/life-stage policy owner | Hard precondition for romantic/intimate contact; known minors always fail. |
| Actor control and target agency | Lane action/behavior authority | Prove who may commit each voluntary movement. |
| Interaction permission and consent | Lane's authoritative policy/consent owner | Mandatory precondition; mechanics cannot manufacture consent. |
| Active contact lifecycle, motion, and implicit pose adjustment | Action/contact resolver | Authoritative start/update/end cause for contact phenomena. |
| Marks, residues, fluid/product transfer | Body/garment/effect event owner | Affordances calculate eligibility; owner commits state. |
| Sensory access and point of view | Perception/exposure owner | Filter observations before ranking. |
| Mention and notice history | Presentation/visual-sensory memory | Suppress unchanged repetition without deleting physical truth. |
| Narrator wording | Narrator | Realize bounded semantic cues; no raw coefficients. |

## Non-negotiable invariants

1. An attempted or merely possible contact never enters a contact frame as
   current truth.
2. Interpersonal contact requires an actor-control/agency decision and the
   applicable interaction permission. Intimate contact additionally requires
   an authoritative adult-eligibility and scope-compatible consent pass.
   Missing or malformed required policy data fails closed.
3. Stable attributes never store current erection, swelling, lubrication,
   sweat, garment displacement, contact, or residue.
4. A garment layer remains present until wardrobe state commits its movement or
   removal.
5. Physical possibility does not imply desire, pleasure, arousal, consent, or
   an expressive reaction.
6. A sensation needs its channel: texture requires touch; visible deformation
   requires sight; scent requires an olfactory path; taste requires qualifying
   oral contact.
7. A transfer, scratch, mark, or displacement is proposed first and narrated
   as present only after the owner commits it atomically and idempotently.
8. Identical authoritative inputs produce identical profiles, frames,
   observations, diagnostics, and repeat keys.
9. Retakes consume captured contact and presentation context, not later live
   state.
10. Narrator cues never expose raw mechanics, rejected alternatives, hidden
    anatomy, policy data, or diagnostic detail.

## Registry shape

The registry follows the body-affordance architecture but distinguishes
observation-only phenomena from effects that need a mutation owner.

```ts
type ContactPhenomenonMode = "observe" | "propose_effect";

interface ContactPhenomenonDefinition<
  TProfile extends RegionalStructuralProfile,
  TObservation extends ContactObservation,
> {
  id: ContactPhenomenonId;
  domain: ContactDomainId;
  mode: ContactPhenomenonMode;
  requires: readonly ContactInputCapability[];
  evaluate(
    profile: TProfile,
    frame: RegionalContactFrame,
  ): ContactPhenomenonResult<TObservation>;
}
```

`requires` is semantic capability metadata, not dependency injection. The
dispatcher fails closed when a required capability is unavailable and emits a
bounded diagnostic.

Initial shared observation families:

- `contact.pressure_area`;
- `contact.material_filter`;
- `contact.relative_temperature`;
- `contact.motion_friction`;
- `contact.deformation`;
- `contact.sensory_access`.

Initial domain phenomena retain domain ids:

- `foot.surface_texture_contact`;
- `foot.articulation_observation`;
- `foot.nail_contact`;
- `foot.scent_proximity`;
- `intimate.effective_exposure`;
- `intimate.physiology_geometry`;
- `intimate.garment_contour`;
- `intimate.surface_moisture`;
- `intimate.action_alignment`.

Do not collapse these into one universal formula. Shared calculations may
produce mechanics, while domain phenomena decide which mechanics mean
something for that anatomy and interaction.

## Lane adapters

The pure contracts and phenomenon functions live in `src/contracts`. The chat
and successor lanes provide adapters for current truth:

```ts
interface ContactLaneAdapter {
  readActionContext(input: ContactActionIntent): ContactActionContext;
  startContact(resolution: CommittableContactResolution): ContactLifecycleCommit;
  updateContact(contactId: ContactId, patch: CommittedContactUpdate): ContactLifecycleCommit;
  endContact(contactId: ContactId, reason: ContactEndReason): ContactLifecycleCommit;
  readActiveContact(contactId: ContactId): CommittedContactRead | undefined;
  readFrame(contact: CommittedContactRead): RegionalContactFrame;
  commitEffects(
    effects: readonly ProposedContactEffect[],
  ): readonly ContactEffectCommitResult[];
  capturePresentation(capture: ContactPresentationCapture): void;
}
```

This interface is conceptual, not a demand for one class. Existing functional
seams should be used where they already carry the needed truth. In particular:

- successor chats consume the simulation action/consent/body substrate;
- legacy character chat may use a narrower adapter and must expose degraded
  limitations honestly;
- the two lanes share contracts and pure derivations, not a second contact
  store;
- a weak legacy-chat gate must not be labeled equivalent to successor ledger
  consent.

## Degraded behavior

Every trust-boundary adapter uses `parseOr`, records diagnostics, and returns a
safe degraded result:

| Missing input | Required behavior |
| --- | --- |
| Actor control/agency for interpersonal contact | Reject commitment; never turn player-authored NPC movement into truth. |
| Adult eligibility or consent/policy for an intimate attempt | Reject or withhold intimate contact; never guess. |
| Pose or reach | Require explicit reposition or return geometry unavailable. |
| Clothing layer state | Treat potentially covered intimate skin as unavailable. |
| Live physiology | Omit physiology-derived phenomena; baseline anatomy may remain. |
| Surface moisture/substance | Suppress moisture-dependent phenomena; unknown is not dry and never becomes wet/slippery. |
| Perception channel | Suppress the observation. |
| Mention history | Preserve truth and use conservative selection; never expose more detail. |
| Effect commit result | Do not narrate the effect as present. |

Diagnostics remain bounded and structured. Suggested codes:

- `contact_action_context_invalid`;
- `contact_actor_control_unavailable`;
- `contact_participant_eligibility_unavailable`;
- `contact_pose_unavailable`;
- `contact_policy_unavailable`;
- `contact_consent_required`;
- `contact_lifecycle_invalid`;
- `contact_wardrobe_unavailable`;
- `contact_surface_state_unavailable`;
- `contact_perception_unavailable`;
- `contact_effect_not_committed`;
- `contact_effect_conflict`;
- `contact_observation_suppressed`;
- `contact_capture_degraded`.

## Cut capture

A committed turn that uses contact cues captures:

```ts
interface ContactPresentationCapture {
  contactIds: readonly ContactId[];
  contactLifecycleEventIds: readonly EventId[];
  contactFingerprints: readonly string[];
  committedEffectEventIds: readonly EventId[];
  observationFingerprints: readonly string[];
  selectedCueIds: readonly ContactObservationId[];
  repeatKeys: readonly string[];
  perceptionSnapshotVersion: string;
  registryVersion: string;
}
```

The capture need not duplicate all body and wardrobe state if their event cut
is already replayable. It must carry enough identity to prove a retake resolved
the same physical moment and chose the same cues.

## Implementation sequence

1. Audit lane truth and registry vocabulary.
2. Implement the shared attempted/committed boundary and minimal frame.
3. Prove pressure, material filtering, and perception through foot fixtures.
4. Add foot motion/friction and effect commits.
5. Evaluate bounded cues in romantic chat.
6. Add intimate exposure, policy, and contact fixtures.
7. Consume authoritative physiology and aftermath.
8. Generalize only duplicated semantics.

All unresolved product and architecture questions are listed in the
[plan](romantic-contact-affordances.plan.md#open-questions).
