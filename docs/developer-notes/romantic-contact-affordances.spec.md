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

## State ownership

| Truth | Owner | Contact layer usage |
| --- | --- | --- |
| Baseline anatomy, morphology, texture, sensitivity tendency | Canonical attributes and body configuration | Compile to typed regional profiles. |
| Current posture, articulation, support, proximity | Pose/space owner | Validate access; never infer whole posture from one local fact. |
| Garment instances, layer order, closures, displacement, material condition | Clothing state graph | Resolve material-between, exposure, compression, and filtering. |
| Wetness, sweat, vascular state, erection, swelling, lubrication, temperature | Physiology/body state | Read current values; never infer from genre, action, or anatomy. |
| Interaction permission and consent | Lane's authoritative policy/consent owner | Mandatory precondition; mechanics cannot manufacture consent. |
| Actual contact, motion, and implicit pose adjustment | Action/contact resolver | Authoritative cause for contact phenomena. |
| Marks, residues, fluid/product transfer | Body/garment/effect event owner | Affordances calculate eligibility; owner commits state. |
| Sensory access and point of view | Perception/exposure owner | Filter observations before ranking. |
| Mention and notice history | Presentation/visual-sensory memory | Suppress unchanged repetition without deleting physical truth. |
| Narrator wording | Narrator | Realize bounded semantic cues; no raw coefficients. |

## Non-negotiable invariants

1. An attempted or merely possible contact never enters a contact frame as
   current truth.
2. Intimate contact requires an authoritative adult-policy and consent pass.
   Missing or malformed policy data fails closed.
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
   as present only after the owner commits it.
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
  commitResolution(resolution: ContactResolution): CommittedContactRead;
  readFrame(contact: CommittedContactRead): RegionalContactFrame;
  commitEffects(effects: readonly ProposedContactEffect[]): CommittedEffectRead;
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
| Consent/policy for an intimate attempt | Reject or withhold intimate contact; never guess. |
| Pose or reach | Require explicit reposition or return geometry unavailable. |
| Clothing layer state | Treat potentially covered intimate skin as unavailable. |
| Live physiology | Omit physiology-derived phenomena; baseline anatomy may remain. |
| Surface moisture | Use dry/unknown semantics, never wet/slippery. |
| Perception channel | Suppress the observation. |
| Mention history | Preserve truth and use conservative selection; never expose more detail. |
| Effect commit result | Do not narrate the effect as present. |

Diagnostics remain bounded and structured. Suggested codes:

- `contact_action_context_invalid`;
- `contact_pose_unavailable`;
- `contact_policy_unavailable`;
- `contact_consent_required`;
- `contact_wardrobe_unavailable`;
- `contact_surface_state_unavailable`;
- `contact_perception_unavailable`;
- `contact_effect_not_committed`;
- `contact_observation_suppressed`;
- `contact_capture_degraded`.

## Cut capture

A committed turn that uses contact cues captures:

```ts
interface ContactPresentationCapture {
  contactIds: readonly ContactId[];
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
