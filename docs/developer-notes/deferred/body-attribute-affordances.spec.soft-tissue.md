# Affordance spec draft — soft tissue

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Derive current visible or tactile effects of support, gravity, pose, motion, and
asserted contact on soft body regions. This is mechanics of an already-existing
body state, not physiology, behavior, or an invitation to mention body motion in
every scene.

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

## Physical profile

```ts
interface SoftTissueRegionProfile {
  restMassBand: UnitInterval;
  compliance: UnitInterval;
  damping: UnitInterval;
  freeMobility: UnitInterval;
  restGeometry: SoftTissueRestGeometry;
}
```

Current support, coverage, physiological modifiers, and pose are live inputs,
not profile fields.

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
damping. Ordinary walking should usually remain below the narrator threshold.
No impulse means no bounce/sway observation.

### `soft_tissue.contact_compression`

Requires an asserted contact pair or an authoritative tight-garment pressure
read. It may produce:

- visible deformation where exposure/coverage permits;
- tactile pressure/deformation for the participating contact observer;
- a constraint on incompatible narration.

The resolver never infers that bodies are pressed together merely because
characters are close.

## Suppression

Expected reasons include:

- `no_current_impulse`;
- `strong_support`;
- `high_damping`;
- `no_asserted_contact`;
- `opaque_heavy_coverage`;
- `observer_channel_unavailable`;
- `below_narrative_threshold`.

A physically valid hidden effect may remain in diagnostics while producing no
visual cue.

## Worked cases

### Unsupported region during a committed stair-running motion

A clear motion observation may resolve if mass/mobility exceed the threshold and
coverage permits it.

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

- no impulse produces no impulse-motion observation;
- stronger support never increases free motion;
- higher damping never increases post-impulse motion;
- contact compression requires asserted contact or garment pressure;
- opaque coverage blocks visual output without changing hidden mechanics;
- physiological modifiers affect live profile resolution but never rewrite
  canonical attributes;
- current entangled attributes are marked provisional rather than treated as
  precise material facts;
- repeated unchanged rest-state reads do not repeatedly enter narrator cues.

## Open questions

- Final orthogonal vocabulary for firmness, compliance, rest geometry, and live
  fullness.
- Whether the first implementation should cover breasts only or use one generic
  region contract with buttocks as a second fixture.
- Exact owner of support-strength reads in wardrobe state.
- The shared narrative-focus policy for intimate body and garment observations.
