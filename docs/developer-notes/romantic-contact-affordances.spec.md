# Romantic contact affordances — technical index

Status: companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28; affectionate contact is live in character chat;
continuation item 4 was revised 2026-08-02 and now requires foundation +
shadow gates before broader NPC authority)

This is the coding-agent entry point. The plan owns the product intent,
reader-facing rollout, success criteria, and all open questions. These specs
own contracts, state boundaries, phenomenon definitions, diagnostics, and
fixtures.

## Reading order

| Document | Technical responsibility |
| --- | --- |
| [Shared contact core](romantic-contact-affordances.spec.contact-core.md) | Attempted action versus committed contact, access result, contact frame, policy/perception gates, effects, cue ranking, retake capture, and shared tests. |
| [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md) | Observation/constraint contracts, perception and repetition rules, plus atomic, conservative, idempotent effect commits. |
| [NPC actor control](romantic-contact-affordances.spec.actor-control.md) | Item 4's live-lane NPC authority: stable actor/contact references, field-by-field evidence proof, chronological folding, post-settle presence/wardrobe reads, durable decision envelopes, guarded persistence, shadow gate, and fail-closed rollout. |
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

## Current capability status

Where each piece actually stands as of **2026-08-02**, after the internal trial,
the item-1.2 repairs, and production enablement. These labels are exclusive:

- **implemented contract** — pure/tested code exists but no running lane calls it;
- **registered in production** — a real turn can reach it;
- **future design** — not built, or blocked on a named prerequisite/ruling.

| Capability | Status | Note |
| --- | --- | --- |
| Foot registry defaults + existing-body backfill | **registered in production** | Baselines are stored; the 2026-07-30 backfill completed and was idempotent |
| Contact core (resolution, lifecycle, identity) | **registered in production** | The character-chat affectionate path resolves and commits through `src/contracts/affordances/contact/` |
| Scene/body-relations owner | **registered in production** | Character chat seeds/reads proximity, facing, control, support, and active-contact projection |
| Player affectionate-contact adapter | **registered in production** | Deterministic player movement/touch path, current-cut target coverage, resolver, guidance, and persistence |
| Contact persistence + retake restoration | **registered in production** | `chat_contact_events` plus `character_chats.scene`; rows/projection commit together and discarded-take rows are pruned |
| NPC deterministic contact endings | **registered in production** | Frozen reply-side withdrawal/departure floor; durable under `contact-reply:<assistantMessageId>` |
| Broader NPC movement, starts, and updates | **future design** | Revised [actor-control spec](romantic-contact-affordances.spec.actor-control.md): pure + durability foundations, then shadow, then three authority increments |
| Foot domain phenomena (pressure, texture, glide, articulation, nails) | **implemented contract** | Pure domain exists but remains outside the production domain set |
| Perception channels (visual/tactile + perceiver binding) | **future design** | No chat `touch` channel; blocks positive tactile output |
| `romantic_touch` permission owner | **future design** | Eight product decisions remain in the plan |
| Positive texture/glide output | **future design** | Still blocked on perception, path/cross-locus detail, and per-side footwear friction |

The [truth-source audit](romantic-contact-affordances.audit.md) remains the
promotion-time evidence record; its 2026-07-28 capability matrix is historical,
not a statement of current wiring.

## Current lane capability audit

| Capability | Character chat now | Successor chat | Consequence |
| --- | --- | --- | --- |
| Actor control and NPC agency | Player movement/touch is typed; NPC prose can deterministically end contact. General NPC movement/start/update is not authoritative yet. | Command/deliberation authority is stronger, but no regional contact adapter exists. | Item 4 must prove an explicit NPC actor per decision; prose alone never commits a voluntary action. |
| Consent/permission | Intimate-scene/touch-welcomeness signals are not grants. | Consent ledger is fail-closed. | Never label the chat signals equivalent to successor consent; wait for `romantic_touch`. |
| Pose, reach, support, and proximity | Minimal scene owner and reach reads are live; seat/posture vocabulary remains incomplete. | No body-region pose/support owner. | Keep NPC posture/support outside item 4; unresolved geometry stays silence/constraint. |
| Active body-surface contact | Affectionate contact has typed lifecycle, durable rows, and a retake-safe projection. | No regional contact lifecycle. | Character chat remains the first proof; successor parity is separate. |
| Clothing/material-between | Current player-hand path reads the target's current-cut coverage. It does not yet compose source-side gloves for arbitrary NPC actors. | Shared garment adapter remains pending. | NPC starts require two-sided material and post-settle wardrobe reads before authority. |
| Presence and reply settlement | Presence may change during fan-out; the shipped reply ending currently uses its pre-settle roster/scenario variable, and openings return early. | Presence is engine-owned. | Item 4 must reload post-settle presence/scenario and run the common leg for openings/initiative/continue/action/partial replies. |
| Body-surface moisture/residue/marks | No shared regional mutation owner. | No shared regional mutation owner. | Unknown suppresses dependent reads; effects remain parked. |
| Physiology/temperature | General physiology is deferred. | General physiology is deferred. | Foot warmth and intimate live-state phenomena remain blocked. |
| Perception | Turn-level allowance + coverage, no explicit tactile channel. | Structured witness/channel observations. | Normalize unavailable channels as unavailable, never open. |
| Retake/idempotency | Contact rows are pruned and scenario restored, but movement/model-empty outcomes have no durable identity yet. | Same-cut re-render/event identity. | Item 4 needs an assistant-message decision envelope, including trigger miss/degraded/rejected tombstones. |

The body-side evidence remains in the
[body-affordance readiness audit](body-attribute-affordances.audit.md).

## State ownership

| Truth | Owner | Contact layer usage |
| --- | --- | --- |
| Baseline anatomy, morphology, texture, sensitivity tendency | Canonical attributes and body configuration | Compile to typed regional profiles. |
| Current posture, articulation, support, proximity | Pose/space owner | Validate access; never infer whole posture from one local fact. |
| Garment instances, layer order, closures, displacement, material condition | Clothing state graph | Resolve material-between, exposure, compression, and filtering. |
| Wetness, sweat, vascular state, erection, swelling, lubrication, temperature | Physiology/body state | Read current values; never infer from genre, action, or anatomy. |
| Actor control and target agency | Lane action/behavior authority | Prove who may commit each voluntary movement. |
| Interaction permission and consent | Lane's authoritative policy/consent owner | Mandatory precondition **for `romantic` and `intimate` only** — incidental/casual/affectionate touch is permission-neutral. Mechanics cannot manufacture consent for any kind. |
| Active contact lifecycle, motion, and implicit pose adjustment | Action/contact resolver | Authoritative start/update/end cause for contact phenomena. |
| Marks, residues, fluid/product transfer | Body/garment/effect event owner | Affordances calculate possible effects; the owner commits state. |
| Sensory access and point of view | Perception/exposure owner | Filter observations before ranking. |
| Mention and notice history | Presentation/visual-sensory memory | Suppress unchanged repetition without deleting physical truth. |
| Narrator wording | Narrator | Realize bounded semantic cues; no raw coefficients. |

## Non-negotiable invariants

1. An attempted or merely possible contact never enters a contact frame as
   current truth.
2. Interpersonal contact requires an actor-control/agency decision — always,
   for every action kind. **Permission is scoped, not universal** (owner
   ruling, 2026-07-30): `romantic` and `intimate` contact additionally require
   the applicable interaction permission scope, while `incidental`, `casual`,
   and `affectionate` contact are **permission-neutral**. Intimate contact
   further requires a
   scope-compatible consent pass. Missing or malformed policy data fails closed
   for the kinds that require it.
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

The pure contracts and phenomenon functions live in `src/contracts`. Lane
adapters supply current truth and persistence. The shape remains conceptual:

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

Character chat now has functional seams for player-authored affectionate starts,
contact endings, projection/ledger persistence, and retake restoration. Those
are narrower than a complete implementation of the conceptual interface:

- the current start path assumes the player's hand and reads target-side
  material; item 4 must generalize actor control and compose both material sides;
- the core's ordinary update re-resolves a full mutable snapshot; NPC gesture
  updates require the narrower operation in the actor-control spec;
- effects, positive contact observations, and full presentation capture remain
  future;
- successor chats reuse pure contracts but need their own authoritative adapter,
  not a second shared store;
- weak character-chat permission signals are never equivalent to the successor
  consent ledger.

## Degraded behavior

Every trust-boundary adapter uses `parseOr`, records diagnostics, and returns a
safe degraded result:

| Missing input | Required behavior |
| --- | --- |
| Actor control/agency for interpersonal contact | Reject commitment; never turn player-authored NPC movement into truth. |
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

The current continuation order is:

1. Build the actor-control pure foundation and adversarial fixtures.
2. Add the durable assistant-message decision envelope, guarded scene CAS, and
   unconditional retake pruning.
3. Run one classifier per qualifying reply in shadow and review accuracy,
   latency, timeout rate, and cost.
4. Enable monotonic NPC movement authority.
5. Generalize the adapter for NPC starts with two-sided material and wardrobe
   chronology protection.
6. Add stable contact handles and a gesture-only update operation.
7. Design and ship `romantic_touch` before any genuinely romantic proof.
8. Resume parked phenomena/effects only in the plan's ruled order; generalize
   only semantics proven in more than one domain.

All unresolved product and architecture questions are listed in the
[plan](romantic-contact-affordances.plan.md#open-questions).

