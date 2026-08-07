# Romantic contact affordances — technical index

Status: companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28; verified against the working tree 2026-08-07). Affectionate
contact is live in character chat. Item 4's actor control and item 5's permission
owner are both fully built and both entirely dark; the item-4 shadow gate has
never been enabled, so its measurement window has not started.

This is the coding-agent entry point. The plan owns the product intent,
reader-facing rollout, success criteria, and all open questions. These specs
own contracts, state boundaries, phenomenon definitions, diagnostics, and
fixtures.

## Reading order

- **Document: [Shared contact core](romantic-contact-affordances.spec.contact-core.md)**
  - **Technical responsibility:** Attempted action versus committed contact, access result, contact frame, policy/perception gates, effects, cue ranking, retake capture, and shared tests.
- **Document: [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md)**
  - **Technical responsibility:** Observation/constraint contracts, perception and repetition rules, plus atomic, conservative, idempotent effect commits.
- **Document: [NPC actor control](romantic-contact-affordances.spec.actor-control.md)**
  - **Technical responsibility:** Item 4's live-lane NPC authority: stable actor/contact references, field-by-field evidence proof, chronological folding, post-settle presence/wardrobe reads, durable decision envelopes, guarded persistence, shadow gate, and fail-closed rollout.
- **Document: [Directional permission owner](romantic-contact-affordances.spec.permission.md)**
  - **Technical responsibility:** Item 5's exact `romantic_touch` scope, directional grants, player-target exception, branch-local events/projection, chronology, revocation, developer override, narrator handoff, and rollback tests.
- **Document: [Foot contact](romantic-contact-affordances.spec.foot.md)**
  - **Technical responsibility:** Foot surface topology, structural profiles, footwear integration, foot phenomena, and foot fixtures.
- **Document: [Intimate contact](romantic-contact-affordances.spec.intimate.md)**
  - **Technical responsibility:** Intimate topology, exposure and consent requirements, physiology inputs, intimate phenomena, and leak-prevention fixtures.

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

## Feature flags

Every switch this topic owns, with the value a production turn actually sees.
Read from `src/server/engine/prompts/constants.ts` and from the deployed Fly
secret set on **2026-08-07**. The five boolean flags treat anything other than
the literal `on` as off, so an unset variable is off everywhere; the sixth is a
comma-separated scope list, not a boolean.

| Flag                                      | Production  | Effect when on                                        |
| ----------------------------------------- | ----------- | ----------------------------------------------------- |
| `CHAT_CONTACT_ACTIONS`                    | **on**      | The contact lane: detect, resolve, commit, persist    |
| `CHAT_PHYSICAL_CONSTRAINTS`               | **on**      | The only prompt door for contact outcomes             |
| `CHAT_NPC_SCENE_DECISION_SHADOW`          | off (unset) | One dry classifier call per reply; no authority       |
| `CHAT_NPC_SCENE_DECISIONS`                | off (unset) | NPC scene authority (compound with the lane flag)     |
| `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS` | unset       | Subset of `movement,start,update`; unset = movement   |
| `CHAT_ROMANTIC_PERMISSION`                | off (unset) | `romantic_touch` ledger (compound with the lane flag) |

`CHAT_ROMANTIC_PERMISSION_DEV_OVERRIDE` is a seventh, deliberately independent
capability gate for the admin override route; it is unset in production too.

Two consequences worth stating plainly. `CHAT_NPC_SCENE_DECISION_AUTHORITY_KINDS`
being unset or blank grants **`movement` only** — the first reviewed increment —
so turning `CHAT_NPC_SCENE_DECISIONS` on without having set the scope cannot skip
the staged rollout in one step. Each later increment is an explicit widening
(`movement,start`, then `movement,start,update`). And authority wins over shadow
when both are on, so the measurement flag cannot be left on as a safety net
during rollout.

## Current capability status

Where each piece actually stands as of **2026-08-07**. These labels are exclusive:

- **implemented contract** — pure/tested code exists but no running lane calls it;
- **lane-wired but dark** — the live pipeline calls it, behind a flag that is off;
- **registered in production** — a real turn can reach it;
- **future design** — not built, or blocked on a named prerequisite/ruling.

- **Capability: Foot registry defaults + existing-body backfill**
  - **Status:** **registered in production**
  - **Note:** Baselines are stored; the 2026-07-30 backfill completed and was idempotent
- **Capability: Contact core (resolution, lifecycle, identity)**
  - **Status:** **registered in production**
  - **Note:** The character-chat affectionate path resolves and commits through `src/contracts/affordances/contact/`
- **Capability: Scene/body-relations owner**
  - **Status:** **registered in production**
  - **Note:** Character chat seeds/reads proximity, facing, control, support, and active-contact projection
- **Capability: Player affectionate-contact adapter**
  - **Status:** **registered in production**
  - **Note:** Deterministic player movement/touch path, current-cut target coverage, resolver, guidance, and persistence
- **Capability: Contact persistence + retake restoration**
  - **Status:** **registered in production**
  - **Note:** `chat_contact_events` plus `character_chats.scene`; rows/projection commit together and discarded-take rows are pruned
- **Capability: NPC deterministic contact endings**
  - **Status:** **registered in production**
  - **Note:** Frozen reply-side withdrawal/departure floor; durable under `contact-reply:<assistantMessageId>`
- **Capability: NPC reply-scene shadow measurement**
  - **Status:** **lane-wired but dark**
  - **Note:** Built 2026-08-02 (migration 0094 + `chat-npc-scene-decision.ts`); `CHAT_NPC_SCENE_DECISION_SHADOW` has never been switched on, so no measurement exists
- **Capability: Broader NPC movement, starts, and updates**
  - **Status:** **lane-wired but dark**
  - **Note:** All three increments built 2026-08-04 in `chat-npc-scene-execute.ts` behind `CHAT_NPC_SCENE_DECISIONS`; blocked on the shadow measurement and the owner's cost ruling, not on code
- **Capability: Foot domain phenomena (pressure, texture, glide, articulation, nails)**
  - **Status:** **implemented contract**
  - **Note:** Pure domain exists but remains outside the production domain set
- **Capability: Perception channels (visual/tactile + perceiver binding)**
  - **Status:** **future design**
  - **Note:** No chat `touch` channel; blocks positive tactile output
- **Capability: `romantic_touch` permission owner**
  - **Status:** **lane-wired but dark**
  - **Note:** Built 2026-08-04 (migration 0096) behind `CHAT_ROMANTIC_PERMISSION`
    (off — no production turn reaches it yet); enablement rides the item-6
    romantic proof. As-built record: the
    [permission spec](romantic-contact-affordances.spec.permission.md) §As built
- **Capability: Positive texture/glide output**
  - **Status:** **future design**
  - **Note:** Still blocked on perception, path/cross-locus detail, and per-side footwear friction

The [truth-source audit](romantic-contact-affordances.audit.md) remains the
promotion-time evidence record; its 2026-07-28 capability matrix is historical,
not a statement of current wiring.

## Current lane capability audit

- **Capability: Actor control and NPC agency**
  - **Character chat now:** Player movement/touch is typed; NPC prose can deterministically end contact. General NPC movement/start/update is built but dark, so nothing beyond the ending floor is authoritative on a live turn.
  - **Successor chat:** Command/deliberation authority is stronger, but no regional contact adapter exists.
  - **Consequence:** The explicit-actor-per-decision rule is implemented and pinned; enabling it is a flag and measurement question, not a build one.
- **Capability: Consent/permission**
  - **Character chat now:** Intimate-scene/touch-welcomeness signals are not grants. The directional owner is built and lane-wired behind `CHAT_ROMANTIC_PERMISSION` (off).
  - **Successor chat:** Consent ledger is fail-closed.
  - **Consequence:** The lane adapter exists; parity may still not be claimed until both lanes enforce the same scope, direction, chronology, revocation, and rollback laws.
- **Capability: Pose, reach, support, and proximity**
  - **Character chat now:** Minimal scene owner and reach reads are live; seat/posture vocabulary remains incomplete.
  - **Successor chat:** No body-region pose/support owner.
  - **Consequence:** Keep NPC posture/support outside item 4; unresolved geometry stays silence/constraint.
- **Capability: Active body-surface contact**
  - **Character chat now:** Affectionate contact has typed lifecycle, durable rows, and a retake-safe projection.
  - **Successor chat:** No regional contact lifecycle.
  - **Consequence:** Character chat remains the first proof; successor parity is separate.
- **Capability: Clothing/material-between**
  - **Character chat now:** The live player-hand path reads the target's current-cut coverage. Two-sided material for arbitrary NPC actors is built in the dark authority executor.
  - **Successor chat:** Shared garment adapter remains pending.
  - **Consequence:** Nothing further is needed for NPC starts; the same-reply wardrobe-chronology veto ships with them.
- **Capability: Presence and reply settlement**
  - **Character chat now:** Presence may change during fan-out. The frozen ending floor still uses its pre-settle roster variable; the dark decision leg reloads an authoritative post-settle cut and covers openings, initiative, continue, action, and partial replies.
  - **Successor chat:** Presence is engine-owned.
  - **Consequence:** The post-settle cut arrives with the decision leg, so enabling that leg is also what fixes the floor's pre-settle read.
- **Capability: Body-surface moisture/residue/marks**
  - **Character chat now:** No shared regional mutation owner.
  - **Successor chat:** No shared regional mutation owner.
  - **Consequence:** Unknown suppresses dependent reads; effects remain parked.
- **Capability: Physiology/temperature**
  - **Character chat now:** General physiology is deferred.
  - **Successor chat:** General physiology is deferred.
  - **Consequence:** Foot warmth and intimate live-state phenomena remain blocked.
- **Capability: Perception**
  - **Character chat now:** Turn-level allowance + coverage, no explicit tactile channel.
  - **Successor chat:** Structured witness/channel observations.
  - **Consequence:** Normalize unavailable channels as unavailable, never open.
- **Capability: Retake/idempotency**
  - **Character chat now:** Contact rows are pruned and scenario restored. The per-assistant-message decision envelope — including trigger-miss, degraded, and rejected tombstones — is built, and its retake prune runs unconditionally rather than behind a flag.
  - **Successor chat:** Same-cut re-render/event identity.
  - **Consequence:** Retake safety no longer moves when a decision flag is turned on or off mid-conversation.

The body-side evidence remains in the
[body-affordance readiness audit](body-attribute-affordances.audit.md).

## State ownership

- **Truth: Baseline anatomy, morphology, texture, sensitivity tendency**
  - **Owner:** Canonical attributes and body configuration
  - **Contact layer usage:** Compile to typed regional profiles.
- **Truth: Current posture, articulation, support, proximity**
  - **Owner:** Pose/space owner
  - **Contact layer usage:** Validate access; never infer whole posture from one local fact.
- **Truth: Garment instances, layer order, closures, displacement, material condition**
  - **Owner:** Clothing state graph
  - **Contact layer usage:** Resolve material-between, exposure, compression, and filtering.
- **Truth: Wetness, sweat, vascular state, erection, swelling, lubrication, temperature**
  - **Owner:** Physiology/body state
  - **Contact layer usage:** Read current values; never infer from genre, action, or anatomy.
- **Truth: Actor control and target agency**
  - **Owner:** Lane action/behavior authority
  - **Contact layer usage:** Prove who may commit each voluntary movement.
- **Truth: Interaction permission and consent**
  - **Owner:** Lane's authoritative policy/consent owner, defined for item 5 by the [permission spec](romantic-contact-affordances.spec.permission.md)
  - **Contact layer usage:** Exact, directional precondition for romantic contact aimed at an NPC. Incidental/casual/affectionate touch is permission-neutral; the player-target exception leaves the player's reaction to the player. Mechanics cannot manufacture permission or a reaction.
- **Truth: Active contact lifecycle, motion, and implicit pose adjustment**
  - **Owner:** Action/contact resolver
  - **Contact layer usage:** Authoritative start/update/end cause for contact phenomena.
- **Truth: Marks, residues, fluid/product transfer**
  - **Owner:** Body/garment/effect event owner
  - **Contact layer usage:** Affordances calculate possible effects; the owner commits state.
- **Truth: Sensory access and point of view**
  - **Owner:** Perception/exposure owner
  - **Contact layer usage:** Filter observations before ranking.
- **Truth: Mention and notice history**
  - **Owner:** Presentation/visual-sensory memory
  - **Contact layer usage:** Suppress unchanged repetition without deleting physical truth.
- **Truth: Narrator wording**
  - **Owner:** Narrator
  - **Contact layer usage:** Realize bounded semantic cues; no raw coefficients.

## Non-negotiable invariants

1. An attempted or merely possible contact never enters a contact frame as
   current truth.
2. Interpersonal contact requires an actor-control/agency decision — always,
   for every action kind. Permission is scoped, directional, and never inferred
   from relationship or scene tone. Romantic contact aimed at an NPC requires
   the exact applicable grant; `incidental`, `casual`, and `affectionate`
   contact are permission-neutral. The player-target exception does not
   pre-calculate a grant before an NPC acts, but the narrator may not author the
   player's acceptance or reaction. Intimate actions require their own future
   exact scopes. Missing or malformed policy data fails closed for the kinds
   that require it. See the
   [permission spec](romantic-contact-affordances.spec.permission.md).
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

- the **live** start path assumes the player's hand and reads target-side
  material; the arbitrary-actor path that composes both material sides exists in
  the dark authority executor, not in the enabled lane;
- the core's ordinary update re-resolves a full mutable snapshot; the narrower
  gesture-only operation (`modulateContactGesture`) exists and is likewise dark;
- effects, positive contact observations, and full presentation capture remain
  future;
- successor chats reuse pure contracts but need their own authoritative adapter,
  not a second shared store;
- weak character-chat permission signals are never equivalent to either the
  item-5 permission owner or the successor consent ledger;
- the permission owner supplies branch-local, ordered policy reads; the contact
  adapter does not derive grants from relationship labels or prompt framing.

## Degraded behavior

Every trust-boundary adapter uses `parseOr`, records diagnostics, and returns a
safe degraded result:

- **Missing input: Actor control/agency for interpersonal contact**
  - **Required behavior:** Reject commitment; never turn player-authored NPC movement into truth.
- **Missing input: Pose or reach**
  - **Required behavior:** Require explicit reposition or return geometry unavailable.
- **Missing input: Clothing layer state**
  - **Required behavior:** Treat potentially covered intimate skin as unavailable.
- **Missing input: Live physiology**
  - **Required behavior:** Omit physiology-derived phenomena; baseline anatomy may remain.
- **Missing input: Surface moisture/substance**
  - **Required behavior:** Suppress moisture-dependent phenomena; unknown is not dry and never becomes wet/slippery.
- **Missing input: Perception channel**
  - **Required behavior:** Suppress the observation.
- **Missing input: Mention history**
  - **Required behavior:** Preserve truth and use conservative selection; never expose more detail.
- **Missing input: Effect commit result**
  - **Required behavior:** Do not narrate the effect as present.

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

Steps 1, 2, and 7 are **done**; steps 4, 5, and 6 are **built but not enabled**.
Only step 3 has no code work left and no result either — it is a switch nobody
has flipped.

1. ~~Actor-control pure foundation and adversarial fixtures.~~ Built 2026-08-02.
2. ~~Durable assistant-message decision envelope, guarded scene CAS, and
   unconditional retake pruning.~~ Built 2026-08-02 (migration 0094).
3. **Run one classifier per qualifying reply in shadow** and review accuracy,
   latency, timeout rate, and cost. Nothing has run: the flag is unset in
   production. This is the only gate between here and step 4.
4. Enable monotonic NPC movement authority. Code built 2026-08-04; enabling means
   setting the authority-kinds scope to `movement`, then the authority flag.
5. NPC starts with two-sided material and wardrobe chronology protection. Code
   built 2026-08-04; enabling means adding `start` to the scope.
6. Stable contact handles and a gesture-only update operation. Code built
   2026-08-04; enabling means adding `update` to the scope.
7. ~~Implement the owner-ruled
   [`romantic_touch` permission spec](romantic-contact-affordances.spec.permission.md).~~
   Built 2026-08-04 (migration 0096), out of order and still dark; the plan's
   genuinely romantic proof consumes it once steps 3–6 land.
8. Resume parked phenomena/effects only in the plan's ruled order; generalize
   only semantics proven in more than one domain.

All unresolved product and architecture questions are listed in the
[plan](romantic-contact-affordances.plan.md#open-questions).

