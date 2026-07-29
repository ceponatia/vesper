# Affordance spec draft — soft tissue

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Derive current visible or tactile effects of support, gravity, pose, motion, and
asserted contact on soft body regions. This is mechanics of an already-existing
body state, not physiology, behavior, or an invitation to mention body motion in
every scene.

This is the proving case for the shared architecture's
[regional-collection pattern](body-attribute-affordances.spec.architecture.md#regional-collections):
one set of profile/mechanics/phenomenon contracts should serve every applicable
body region rather than duplicating “breast physics,” “buttocks physics,” and
“thigh physics.”

The domain is high-value for visual consistency and high-risk for repetitive or
voyeuristic narration. The common case must be silence; only meaningful change,
current motion, contact, or a support transition should produce a cue.

## Boundary

Out of scope:

- arousal, swelling, lactation, or other physiological processes;
- deciding that a character runs, jumps, laughs, or presses against someone;
- inventing contact from proximity;
- generic ambient descriptions of body size;
- deciding whether the story should dwell on an intimate region.

Physiology/body state supplies live changes. Pose/motion supplies actual
impulses. Wardrobe supplies support and coverage. This resolver combines them.

## Vocabulary prerequisites

The current attributes are not clean material axes.

- `breasts.fullness` mixes material words (`firm`, `soft`, `supple`, `plump`)
  with live physiological states (`swollen`, `engorged`, `heavy_with_milk`).
- `breasts.augmentation` must not automatically mean a single firmness or
  damping value; real outcomes vary.
- `breasts.shape` mixes rest geometry with placement and softness.

Before these values become executable physics, promotion must either split
orthogonal axes or adopt conservative, explicitly provisional mappings.
Preferred profile inputs include:

- rest volume/mass band;
- firmness/compliance;
- damping;
- attachment/rest geometry;
- current physiological volume modifier supplied by body state;
- current support strength supplied by wardrobe.

Do not write live swelling or milk state back into structural attributes.

## Contributing attributes

Potential canonical contributors:

- `breasts.size`, cleaned-up rest geometry, and an explicit firmness/compliance
  axis;
- `buttocks.size`, `buttocks.firmness`, `buttocks.shape`;
- `hips.width`, `waist.definition`, and `build.weight_presentation` for coarse
  surrounding contour only.

Attribute presence/body configuration gates whether a region profile exists.
Do not create negligible phantom regions merely to simplify a formula.

## Structural profile

```ts
interface SoftTissueRegionProfile {
  locationId: BodyLocationId;
  restMassBand: UnitInterval;
  compliance: UnitInterval;
  damping: UnitInterval;
  freeMobility: UnitInterval;
  restGeometry: SoftTissueRestGeometry;
}

type SoftTissueProfile = readonly SoftTissueRegionProfile[];
```

Current support, coverage, physiological modifiers, and pose are live inputs,
not profile fields. Compile entries only for regions present on the realized
body and supported by trustworthy attribute mappings.

## Effective mechanics

Each region combines its structure with current support and authoritative
physiological modifiers:

```ts
interface SoftTissueRegionEffectiveMechanics {
  locationId: BodyLocationId;
  effectiveMass: UnitInterval;
  effectiveDamping: UnitInterval;
  supportedMobility: UnitInterval;
  compressionResponse: UnitInterval;
  restContour: SoftTissueRestGeometry;
}
```

These terms are shared:

- supported mobility and effective damping feed both rest-state and impulse
  response;
- effective mass feeds impulse response and gravity-dependent rest state;
- compression response feeds body contact and tight-garment pressure.

They describe current capacity and material condition. They do not prove an
impulse, contact, or narratively relevant change.

## Domain frame

```ts
interface SoftTissueAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: SoftTissueProfile;
  mechanics: readonly SoftTissueRegionEffectiveMechanics[];
  pose: PostureRead;
  supportByLocation: ReadonlyMap<BodyLocationId, SupportRead>;
  actualContacts: readonly BodyContactPair[];
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Phenomena operate over narrowed region frames, so adding another region reuses
the same motion/compression implementation.

## Phenomena

### `soft_tissue.supported_rest_state`

A standing observation of current contour/rest state derived from:

- posture/orientation;
- support strength and support placement;
- region profile;
- current physiological volume modifier, when any.

This may help narration or scene-image prompting after a posture or wardrobe
change. It should not emit a cue every turn while unchanged.

### `soft_tissue.impulse_motion`

Requires an actual current motion read or committed impulse event: running,
stairs, jumping, sudden turn, collision, laughter, vehicle motion, and similar.

Motion strength is scaled by rest mass and mobility, then reduced by support and
damping. The phenomenon consumes the shared effective mechanics plus a current
impulse; it does not reinterpret raw regional attributes. Ordinary walking
should usually remain below the narrator threshold. No impulse means no
bounce/sway observation.

### `soft_tissue.contact_compression`

Requires an asserted contact pair or an authoritative tight-garment pressure
read. It may produce:

- physical deformation at the asserted contact region;
- channel-agnostic pressure/deformation evidence for perception;
- a constraint on incompatible narration.

The resolver never infers that bodies are pressed together merely because
characters are close. Coverage and observer participation decide downstream
visual/tactile availability without deleting the physical read.

## Suppression and filtering

Expected reasons include:

- `no_current_impulse`;
- `strong_support`;
- `high_damping`;
- `no_asserted_contact`;
- `observer_channel_unavailable`;
- `below_narrative_threshold`.

`observer_channel_unavailable` and opaque coverage are perception-stage
suppression, not physical-phenomenon failure. A physically valid hidden effect
may remain in the captured read while producing no visual cue.

## Worked cases

### Unsupported region during a committed stair-running motion

A clear motion observation may resolve if mass/mobility exceed the threshold and
perception permits it.

### Same body with strong support

The same impulse resolves below threshold or as suppressed. The narrator must
not reuse the unsupported result.

### Character lying back after removing support

The standing rest-state read changes because pose and support changed. This is a
current contour observation, not a motion event.

### Pressed against a partner

Only an asserted body contact licenses compression or a tactile cue. Mere
adjacency does not.

## Narrative-focus gate

Physics/perception may establish that an effect is observable. A separate
product/narrative-focus rule decides whether it is appropriate and useful to
surface. This gate belongs above the physical resolver and applies consistently
to intimate body regions and garment translucency.

At minimum:

- current action relevance is required for intimate-region cues;
- unchanged cues have aggressive repetition suppression;
- one body-motion cue must not crowd out dialogue or the primary action;
- exposure rules remain authoritative.

## Acceptance tests

- phenomena never receive raw regional attribute enums;
- adding a compatible region reuses the shared profile/mechanics/phenomenon
  pipeline;
- absent body regions do not receive phantom profiles;
- no impulse produces no impulse-motion observation;
- stronger support never increases free motion;
- higher damping never increases post-impulse motion;
- contact compression requires asserted contact or garment pressure;
- opaque coverage blocks visual output without changing hidden mechanics;
- physiological modifiers affect live mechanics but never rewrite
  canonical attributes;
- current entangled attributes are marked provisional rather than treated as
  precise material facts;
- repeated unchanged rest-state reads do not repeatedly enter narrator cues.

## Resolved (owner rulings, 2026-07-28)

### Orthogonal vocabulary — four separate concepts

The existing breast vocabulary mixes permanent structure with temporary body
state (`breasts.fullness` combines firmness words with states like `swollen` /
`engorged`). It splits into four:

1. **rest size or mass band** — `restMassBand`;
2. **compliance** — firm through soft;
3. **rest geometry and placement** — `restGeometry`;
4. **live volume/fullness modifier** — supplied by physiology as a live input,
   never written back into structure.

`damping` is **not** a fifth authored axis: it is initially derived
conservatively from compliance and mass at profile-compile time and is not
exposed as an author-facing field. `breasts.augmentation` does not
automatically determine firmness.

### One generic regional contract from the start

Do not ship a breast-only implementation. The regional contract is generic on
day one: **breasts are the first fixture, buttocks the immediate second**, and
the abstraction is not declared proven until buttocks pass the same pipeline.
Later regions (thighs, abdomen) reuse it.

### Support ownership

Support belongs to **wardrobe**: a bra, compression garment, or structured
bodice supplies support strength **by covered region**, adjusted by fastening
and displacement. That is `SupportRead`.

Unknown support must be **unavailable**, not treated as unsupported — a missing
read never resolves as a free-moving region.

### Shared live inputs

`pose`, `actualContacts`, and committed `motion`/impulse events come from the
shared scene/body-relations owner (architecture spec §Scene/body-relations
owner). Unknown contact still means silence.

### Shared narrative-focus policy (also binding on garment observations)

An intimate-region cue requires a **current relevant action, contact, motion,
pose transition, or support transition**. Ordinary unchanged visibility is
insufficient.

- Exposure and consent remain hard gates.
- **At most one** intimate body-or-garment cue per exchange.
- Aggressive cooldown across the shared intimate cue family.
- The cue must not displace dialogue or the exchange's primary action.

The mechanics may remain true while the narrator remains silent; that
suppression is never a physical-resolver failure.

### Calibration stance

Soft-tissue motion coefficients — and every other number in this domain — are
fixture-tested calibration defaults, not permanent product law.
