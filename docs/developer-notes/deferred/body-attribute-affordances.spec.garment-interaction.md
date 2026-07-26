# Affordance spec draft — garment interaction

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Compose wardrobe-owned garment properties with body state, environment, pose,
and motion to derive current visual garment effects:

- wet cling;
- opacity/translucency change;
- surface beading or saturation;
- wind or body-motion response;
- pose-dependent drape.

Garments are not body attributes. This spec is an integration consumer of the
same phenomenon machinery because body-adjacent visual narration needs clothing
and body state to agree.

## Ownership boundary

The wardrobe/item system owns:

- material identity and layered construction;
- weight, stiffness, absorbency, and baseline opacity;
- fit and garment-region coverage;
- support function;
- worn location and current fastened state;
- persistent garment wetness, dirt, damage, displacement, and riding-up state.

The affordance layer receives a normalized `GarmentPhysicalRead`. It must not
create a second garment catalog or mutate worn state.

```ts
interface GarmentPhysicalRead {
  garmentId: ItemId;
  regions: readonly GarmentRegionPhysicalRead[];
}

interface GarmentRegionPhysicalRead {
  coveredBodyLocations: readonly BodyLocationId[];
  materialClass: GarmentMaterialClass;
  absorbency: UnitInterval;
  saturation: UnitInterval;
  clingAffinity: UnitInterval;
  baselineOpacity: UnitInterval;
  wetOpacityResponse: UnitInterval;
  flutterMass: UnitInterval;
  drapeStiffness: UnitInterval;
  fit: "loose" | "fitted" | "tight" | "structured";
}
```

Base color/lightness metadata may affect visible wet-opacity change, but it
belongs to the garment read, not to body attributes.

## Resolution order

Do not build a general cyclic phenomenon graph. Use an explicit staged pipeline:

1. wardrobe supplies authored coverage and current garment state;
2. garment phenomena derive current cling, displacement, and effective opacity;
3. those results produce a final `EffectiveCoverageRead`;
4. body-surface perception uses that final read;
5. narrator ranking happens after both garment and body observations exist.

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
body contact determine where cling occurs.

The observation carries affected garment/body regions and a contour-read band.
It does not invent uncovered anatomy; downstream exposure policy remains
binding.

### `garment.effective_opacity`

Derives a current opacity band from baseline opacity, saturation response,
material/construction, and color/lightness metadata. This feeds the staged
`EffectiveCoverageRead`.

Do not treat all white fabric as transparent when wet or all dark fabric as
unchanged. The authored garment/material profile decides the response.

### `garment.wind_or_motion_response`

Requires current wind, subject motion, or an impulse. Soaked fabric generally
loads and hangs more heavily; fit and construction constrain movement.

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
