# Affordance spec draft — garment interaction

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Compose wardrobe-owned garment properties with body state, environment, pose,
and motion to derive current visual garment effects:

- wet cling;
- opacity/translucency change;
- surface beading or saturation;
- wind or body-motion response;
- pose-dependent drape.

Garments are not body attributes. This spec is an integration consumer of the
same [domain architecture](body-attribute-affordances.spec.architecture.md)
because body-adjacent visual narration needs clothing and body state to agree.
The upstream [clothing state graph](clothing-state-graph.plan.md) draft owns the
blueprint, stable instance/locus, presentation operations, condition gradients,
and localized marks this domain reads; this domain must not duplicate them.

## Ownership boundary

The wardrobe/item system owns:

- material identity and layered construction;
- weight, stiffness, absorbency, and baseline opacity;
- fit and garment-region coverage;
- support function;
- worn location and current fastened state;
- persistent garment wetness, dirt, damage, displacement, and riding-up state.

## Structural profile

The affordance layer receives a normalized structural profile from wardrobe. It
must not create a second garment catalog or mutate worn state.

```ts
interface GarmentStructuralProfile {
  garmentId: ItemId;
  regions: readonly GarmentRegionStructuralProfile[];
}

interface GarmentRegionStructuralProfile {
  regionId: GarmentRegionId;
  coveredBodyLocations: readonly BodyLocationId[];
  materialClass: GarmentMaterialClass;
  absorbency: UnitInterval;
  clingAffinity: UnitInterval;
  baselineOpacity: UnitInterval;
  wetOpacityResponse: UnitInterval;
  dryMass: UnitInterval;
  dryDrapeStiffness: UnitInterval;
  fit: "loose" | "fitted" | "tight" | "structured";
}
```

Base color/lightness metadata may affect visible wet-opacity change, but it
belongs to the garment read, not to body attributes.

Saturation, persistent displacement, damage, and fastened state remain live
wardrobe/presentation state. They are not structural profile fields.

## Effective mechanics

Each garment region compiles once per cut:

```ts
interface GarmentRegionEffectiveMechanics {
  regionId: GarmentRegionId;
  saturation: UnitInterval;
  waterLoad: UnitInterval;
  effectiveFlutterLoad: UnitInterval;
  effectiveDrapeStiffness: UnitInterval;
  contourConformance: UnitInterval;
  effectiveOpacity: UnitInterval;
}
```

These are named because several phenomena share them:

- water load affects surface state, motion, and drape;
- effective flutter load affects wind and body-motion response;
- contour conformance affects wet cling and pose drape;
- effective opacity feeds both the garment observation and final coverage read.

Actual cling still requires current garment/body contact. High contour
conformance is capacity, not proof that cling is occurring.

## Domain frame

```ts
interface GarmentAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: GarmentStructuralProfile;
  mechanics: readonly GarmentRegionEffectiveMechanics[];
  currentState: GarmentPresentationRead;
  actualContacts: readonly GarmentBodyContactRead[];
  pose: PostureRead;
  wind?: WindRead;
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Phenomena consume narrowed region views instead of the entire wardrobe.

## Resolution order

Do not build a general cyclic phenomenon graph. Use an explicit staged pipeline:

1. wardrobe supplies structural profiles and authoritative current state;
2. garment mechanics derive saturation-dependent regional terms once;
3. garment phenomena derive current surface, cling, motion, drape, and opacity
   observations;
4. effective opacity plus authored coverage produce final
   `EffectiveCoverageRead`;
5. body-surface perception uses that final read;
6. narrator ranking happens after garment and body observations exist.

A garment phenomenon may change the **read** of coverage/opacity but cannot
silently rewrite the garment or body substrate.

## Phenomena

### `garment.wet_surface_state`

Current saturation plus material response yields observations such as:

- droplets bead and run;
- fabric darkens;
- fabric appears saturated;
- water sheds with little absorption.

A leather jacket and cotton shirt should not use the same response.

### `garment.wet_cling`

Requires sufficient saturation and cling affinity. Fit, stiffness, lining, and
body contact determine where cling occurs. It consumes the shared contour-
conformance mechanics and asserted regional contacts rather than recalculating
wet flexibility from raw material fields.

The observation carries affected garment/body regions and a contour-read band.
It does not invent uncovered anatomy; downstream exposure policy remains
binding.

### `garment.effective_opacity`

Projects the shared current `effectiveOpacity` into a semantic observation band
and the staged `EffectiveCoverageRead`.

Do not treat all white fabric as transparent when wet or all dark fabric as
unchanged. The authored garment/material profile decides the response.

### `garment.wind_or_motion_response`

Requires current wind, subject motion, or an impulse. Soaked fabric generally
loads and hangs more heavily; fit and construction constrain movement. The
phenomenon consumes `effectiveFlutterLoad` and current force rather than raw
absorbency/saturation.

Outputs describe actual current movement — a hem stirring, loose sleeve
fluttering, cape snapping — not generic capability.

### `garment.pose_drape`

A current pose transition may change drape or settle state. Persistent changes
such as a hem remaining caught or a strap remaining displaced belong to
wardrobe/presentation state, not affordance memory.

## Worked cases

### Fitted cotton shirt in rain

- saturation rises in garment state;
- wet-cling may resolve over regions currently contacting the body;
- effective opacity may decrease according to the garment profile;
- the final coverage read determines what underlying surface observations are
  perceptible.

### Leather jacket in the same rain

- low absorption produces beading/runoff;
- no fabric cling or opacity downgrade;
- the useful observation is surface droplets or darkened wet leather.

### Soaked loose skirt in wind

- water loading suppresses flutter compared with its dry state;
- a strong gust may still move an exposed hem;
- no persistent riding-up state is invented without a wardrobe event/state
  change.

## Narrative-focus and exposure policy

A physical/perception read can establish that contour or underlying detail is
observable. A separate shared product/narrative-focus policy decides whether it
belongs in the current narration. The same policy should govern intimate soft-
tissue observations and garment opacity changes.

This layer must preserve:

- authored exposure/coverage rules;
- observer angle and distance;
- current action relevance;
- strict repetition limits;
- the distinction between subtle contour, partial opacity change, and actual
  uncovered exposure.

## Acceptance tests

- wardrobe is the sole owner of garment material and persistent garment state;
- phenomena never receive raw item enum values or duplicate material
  calibration;
- each garment region derives shared effective mechanics once per cut;
- wet cotton and wet leather produce materially different observations;
- saturation cannot increase flutter for a fabric whose authored water loading
  should suppress it;
- wet cling requires current garment/body contact;
- opacity changes feed the staged effective-coverage read deterministically;
- no current force/motion means no garment-motion observation;
- persistent displacement requires authoritative wardrobe state;
- hidden/intimate detail never bypasses exposure and narrative-focus policy.

## Open questions

- Exact garment material/profile vocabulary and existing wardrobe seams.
- Whether v1 proves only wet surface/cling before wind and drape.
- Ownership of garment-region contact reads.
- Shared narrative-focus policy for intimate body and garment observations.
- Whether effective coverage is captured in the presentation cut directly or
  reconstructed from captured garment reads.
