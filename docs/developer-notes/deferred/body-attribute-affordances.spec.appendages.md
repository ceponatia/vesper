# Affordance spec draft — morphology appendages

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Derive current constraints and observable physical effects for wings, tails,
and horns from morphology attributes plus authoritative pose, presentation,
space, wetness, and motion state.

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

Promotion must audit whether type values encode hidden dimensions such as mass,
prehensility, flexibility, or material. When a value is ambiguous, use a
conservative provisional mapping or add an orthogonal attribute.

## Physical profiles

```ts
interface WingPhysicalProfile {
  foldedBulk: UnitInterval;
  spreadSpan: UnitInterval;
  flexibility: UnitInterval;
  waterLoading: UnitInterval;
  flightCapabilityClass?: FlightCapabilityClass;
}

interface TailPhysicalProfile {
  lengthBand: UnitInterval;
  flexibility: UnitInterval;
  massBand: UnitInterval;
  prehensility: UnitInterval;
}

interface HornPhysicalProfile {
  clearanceHeight: UnitInterval;
  lateralClearance: UnitInterval;
  snagAffinity: UnitInterval;
}
```

A capability class may constrain downstream action validation, but it is not a
narrator cue by itself.

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

- `free`;
- `partially_constrained`;
- `pinned_by_seating`;
- `blocked_by_garment`;
- `concealed`;
- `space_limited`.

These reads prevent incompatible narration. A constrained tail cannot lash; a
folded wing blocked by a chair cannot suddenly spread through it.

### `appendage.actual_motion`

Requires an authoritative pose/motion change, behavior event, wind, or impulse.
The resolver determines how the physical profile and constraints shape that
motion. Mood may motivate a tail-sway action upstream, but this layer does not
invent the action from mood.

### `wing.wet_loading`

Current wetness plus wing material/type may produce observations such as:

- feather clumping or droop;
- beading on membrane;
- dripping after immersion;
- reduced movement or flight constraint.

The affordance read does not apply wetness or change flight state as a hidden
side effect. Any authoritative capability change must be owned by body/action
state.

### `appendage.clearance_conflict`

Combines current appendage pose/extent with an authoritative space or garment
clearance read. It may produce a current constraint or an action-warning read,
but not an ambient claim that the character attempts the blocked action.

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
