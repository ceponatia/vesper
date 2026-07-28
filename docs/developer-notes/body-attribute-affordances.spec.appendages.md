# Affordance spec draft — morphology appendages

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Derive current constraints and observable physical effects for wings, tails,
and horns from morphology attributes plus authoritative pose, presentation,
space, wetness, and motion state.

The domain follows the shared
[profile → mechanics → frame architecture](body-attribute-affordances.spec.architecture.md).
It uses a tagged profile union because wings, tails, and horns share registry
and frame machinery but do not share every coefficient.

The central boundary is:

- this layer may say an appendage is currently free, folded, pinned, soaked,
  drooping, concealed, or moving because of an asserted force/motion;
- it may constrain narration that would contradict those facts;
- it does not decide that a pleased character chooses to sway a tail or spread
  wings;
- “could shelter another person” and similar offers are future action-capability
  queries, not ambient visual observations.

## Contributing attributes

- `wings.type`, `wings.shape`, `wings.span`, `wings.carriage`;
- `tail.type`, `tail.length`, `tail.tip`;
- `horns.shape`, `horns.length`, `horns.count`.

Before implementation, audit whether type values encode hidden dimensions such
as mass, prehensility, flexibility, or material. When a value is ambiguous, use
a conservative provisional mapping or add an orthogonal attribute.

## Structural profiles

```ts
interface WingPhysicalProfile {
  kind: "wing";
  locationId: "wings";
  foldedBulk: UnitInterval;
  spreadSpan: UnitInterval;
  flexibility: UnitInterval;
  waterAbsorption: UnitInterval;
  flightCapabilityClass?: FlightCapabilityClass;
}

interface TailPhysicalProfile {
  kind: "tail";
  locationId: "tail";
  lengthBand: UnitInterval;
  flexibility: UnitInterval;
  massBand: UnitInterval;
  prehensility: UnitInterval;
}

interface HornPhysicalProfile {
  kind: "horn";
  locationId: "horns";
  clearanceHeight: UnitInterval;
  lateralClearance: UnitInterval;
  snagAffinity: UnitInterval;
}

type AppendageStructuralProfile =
  | WingPhysicalProfile
  | TailPhysicalProfile
  | HornPhysicalProfile;

type AppendageProfile = readonly AppendageStructuralProfile[];
```

A capability class may constrain downstream action validation, but it is not a
narrator cue by itself. Profiles are created only for features present on the
realized body.

## Effective mechanics

Each present appendage combines structure with current carriage, wetness,
physical binding/garment pressure, and asserted space/contact constraints:

```ts
interface AppendageEffectiveMechanics {
  locationId: BodyLocationId;
  effectiveExtent: UnitInterval;
  effectiveLoad: UnitInterval;
  freeMobility: UnitInterval;
  constraintStrength: UnitInterval;
  wetResponse?: "feather_clump" | "membrane_bead" | "surface_darken";
}
```

These terms are reusable across constraint, motion, and wet-loading phenomena.
They do not prove motion or an attempted action.

## Domain frame

```ts
interface AppendageAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: AppendageProfile;
  mechanics: readonly AppendageEffectiveMechanics[];
  carriage: readonly AppendageCarriageRead[];
  actualContacts: readonly BodyContactPair[];
  space?: SpaceConstraintRead;
  wind?: WindRead;
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Phenomena iterate present appendage instances and receive narrowed tagged views.

## Live inputs

- current appendage carriage/pose;
- current clothing, binding, seating, and concealment;
- current space/clearance read;
- current wetness/contamination;
- current wind, body motion, or impulse event;
- asserted contact with furniture, surfaces, garments, or another body.

Unknown space or contact fails closed for specific clearance/contact claims.

## Phenomena

### `appendage.constraint_state`

Produces current constraint reads such as:

- `partially_constrained`;
- `pinned_by_seating`;
- `blocked_by_garment`;
- `space_limited`.

`free` is mechanics/diagnostic state, not a `ConstraintRead`; absence of a
constraint needs no narrator candidate. Emitted constraints prevent
incompatible narration. A constrained tail cannot lash; a folded wing blocked
by a chair cannot suddenly spread through it. Visual concealment belongs to
the downstream perception gate unless the garment also asserts a physical
constraint.

### `appendage.actual_motion`

Requires an authoritative pose/motion change, behavior event, wind, or impulse.
The resolver determines how the physical profile and constraints shape that
motion. It consumes `freeMobility`, `effectiveLoad`, and current force. Mood may
motivate a tail-sway action upstream, but this layer does not invent the action
from mood.

### `wing.wet_loading`

Current wetness plus wing material/type may produce observations such as:

- feather clumping or droop;
- beading on membrane;
- dripping after immersion;
- reduced movement or flight constraint.

The affordance read does not apply wetness or change flight state as a hidden
side effect. `effectiveLoad` is shared with motion resolution; any authoritative
capability change must be owned by body/action state.

### `appendage.clearance_conflict`

Combines current appendage pose/extent with an authoritative space or garment
clearance read. V1 emits a constraint only for current asserted extent/pose.
Warnings about a proposed action belong to the future capability-query surface,
not the ambient visual read.

## Future capability queries

The same profiles may later answer separate queries such as:

- can wings fully spread here?;
- can a wing cover an adjacent person?;
- can this tail grasp an object?;
- will these horns fit beneath this hood?.

Those belong to a dedicated `queryCapability(...)` surface. They must not enter
the narrator's visual-observation queue unless an action is actually attempted
or completed.

## Worked case

A membrane-winged, long-tailed character sits in a high-backed chair in a small
room:

- wings resolve as constrained by chair and available space;
- tail resolves as displaced or pinned according to asserted seating contact;
- no expressive movement is invented.

After she stands:

- seating constraints clear;
- room clearance may still prevent full wing spread;
- a committed tail-sway behavior could now be physically realized by the motion
  resolver.

## Acceptance tests

- phenomena never receive raw morphology enum values;
- structural profiles are created only for appendages on the realized body;
- wetness, binding, or stronger asserted constraints never increase free
  mobility;
- no motion/behavior/force input produces no actual-motion observation;
- chair contact can constrain wings/tail only when contact is asserted;
- unknown space does not license full-spread or blocked-space claims;
- wet loading differs by authored material/type mapping;
- constraint reads suppress incompatible narrator cues;
- possible-action queries never appear in ambient visual cue output;
- concealment blocks observer output without deleting physical state.

## Open questions

- Authoritative producer of coarse room, passage, and furniture clearance.
- Whether morphology type values need orthogonal material/flexibility attributes.
- Ownership of glamour/concealment state.
- Which appendage domain should be the first fixture: tail constraints or wing
  wet loading.
