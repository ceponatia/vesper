# Affordance spec draft — garment interaction

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Compose wardrobe-owned garment properties with body state, environment, pose,
motion, and accepted body-garment interactions to derive current visual garment
effects:

- wet cling;
- opacity/translucency change;
- surface beading or saturation;
- wind or body-motion response;
- pose-dependent drape;
- occupancy- or grasp-dependent component deformation.

Garments are not body attributes. This spec is an integration consumer of the
same [domain architecture](body-attribute-affordances.spec.architecture.md)
because body-adjacent visual narration needs clothing and body state to agree.
The upstream [clothing state graph](clothing-state-graph.plan.md) draft owns the
compiled blueprint, stable instance/locus, presentation operations, condition
gradients, localized marks, and surface-feature condition this domain reads.
Its companion
[archetype/component spec](clothing-archetypes-components.spec.md) owns garment
families, reusable component fragments, and deterministic blueprint
compilation. This domain must not duplicate either catalog or mutate their
state.

## Ownership boundary

The wardrobe/item system owns:

- compiled material identity and layered construction;
- weight, stiffness, stretch, absorbency, and baseline opacity;
- fit and garment-region coverage;
- support and component capabilities;
- worn location and current fastened/positioned state;
- persistent garment wetness, dirt, damage, decoration condition,
  displacement, and riding-up state.

The pose/contact/interaction owner owns accepted current relations such as a
hand inserted into a pocket or gripping a cuff. A structural capability means
an interaction is possible; it is not proof that the relation currently
exists. This affordance domain consumes accepted relations and never invents or
persists them.

## Structural profile

The affordance layer receives a normalized structural profile from wardrobe. It
must not create a second garment catalog or mutate worn state.

```ts
interface GarmentStructuralProfile {
  garmentId: ItemId;
  regions: readonly GarmentRegionStructuralProfile[];
  componentCapabilities: readonly GarmentComponentCapabilityRead[];
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
  stretchElasticity: UnitInterval;
  fit: "loose" | "fitted" | "tight" | "structured";
}
```

`GarmentComponentCapabilityRead` is a narrowed, compiled read for useful
components such as pocket compartments/openings, hoods, drawstrings, closures,
and graspable hems/cuffs. It exposes only the relationships and mechanics a
phenomenon needs; it does not expose the archetype registry or raw component
template.

Base color/lightness metadata may affect visible wet-opacity change, but it
belongs to the garment read, not to body attributes.

Saturation, persistent displacement, damage, decoration fade/cracking, and
fastened/positioned state remain live wardrobe/presentation state. They are not
structural profile fields.

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
conformance is capacity, not proof that cling is occurring. Likewise, a pocket
capability is not proof of occupancy and a graspable cuff is not proof that a
hand is holding it.

## Domain frame

```ts
interface GarmentAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: GarmentStructuralProfile;
  mechanics: readonly GarmentRegionEffectiveMechanics[];
  currentState: GarmentPresentationRead;
  actualContacts: readonly GarmentBodyContactRead[];
  actualInteractions: readonly BodyGarmentInteractionRead[];
  pose: PostureRead;
  wind?: WindRead;
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Phenomena consume narrowed region/component views instead of the entire
wardrobe or interaction graph.

## Resolution order

Do not build a general cyclic phenomenon graph. Use an explicit staged pipeline:

1. wardrobe supplies compiled structural profiles and authoritative current
   state;
2. pose/contact supplies accepted current garment-body contacts and
   interactions;
3. garment mechanics derive saturation- and state-dependent regional terms
   once;
4. garment phenomena derive current surface, cling, occupied-component
   deformation, motion, drape, and opacity observations;
5. effective opacity plus authored coverage produce final
   `EffectiveCoverageRead`;
6. body-surface perception uses that final read;
7. narrator ranking happens after garment and body observations exist.

A garment phenomenon may change the **read** of coverage/opacity but cannot
silently rewrite the garment, body, pose, or interaction substrate.

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

### `garment.occupied_component_deformation`

Requires an accepted current interaction with an explicit garment component.
Examples include one or both hands inserted into a pocket, an item occupying a
pocket, or a hand gripping a cuff, drawstring, or hem.

The phenomenon consumes:

- the explicit compartment/opening or graspable-part capability;
- accepted interaction relations;
- current presentation and closure accessibility;
- material stretch, stiffness, mass, and garment fit;
- relevant pose/contact and motion.

It may emit current observations such as:

- a kangaroo pocket sagging around both hands;
- fabric pulling taut near the pocket openings;
- one pocket bulging from an inserted object;
- a held cuff or hem moving with the gripping hand.

It must not infer occupancy from a garment name, pocket capability, prior prose,
or a generic “hands hidden” state. It also does not persist the deformation;
only authoritative garment/interaction changes persist.

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

### Both hands in a pullover hoodie pocket

- the compiled blueprint establishes one kangaroo compartment with two
  openings and hand-insertion capability;
- pose/contact supplies two accepted `body_part_inserted` relations;
- material, fit, stretch, pose, and occupancy may derive sag or tension;
- hand visibility and manipulation availability come from the authoritative
  interaction/pose read, not from this phenomenon;
- the narrator may receive “both hands tucked into the front pocket” and, only
  when salient, one compatible deformation cue.

### Faded tee graphic

- the compiled blueprint establishes an addressable screen-print decoration;
- garment condition owns its fade/cracking bands;
- perception may surface the faded graphic directly when visible;
- this affordance domain does not invent fading merely because the tee is worn;
- a separate stretch/cracking phenomenon should be added only if current force
  and authored mechanics justify it.

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

- wardrobe is the sole owner of compiled garment structure, material, and
  persistent garment state;
- archetype/component registries are not duplicated inside affordances;
- pose/contact is the sole owner of accepted body-garment interactions;
- phenomena never receive raw item enum values or duplicate material
  calibration;
- each garment region derives shared effective mechanics once per cut;
- wet cotton and wet leather produce materially different observations;
- saturation cannot increase flutter for a fabric whose authored water loading
  should suppress it;
- wet cling requires current garment/body contact;
- opacity changes feed the staged effective-coverage read deterministically;
- no current force/motion means no garment-motion observation;
- occupied-component deformation requires an accepted interaction relation;
- a pocket capability or hoodie archetype alone never creates occupancy;
- a pullover hoodie's shared kangaroo pocket and a zip hoodie's two pockets can
  produce different occupancy/deformation reads;
- persistent displacement or decoration fade requires authoritative wardrobe
  state;
- hidden/intimate detail never bypasses exposure and narrative-focus policy.

## Open questions

- Exact normalized component-capability vocabulary emitted by the clothing
  blueprint compiler.
- Whether v1 proves only wet surface/cling before wind, drape, and occupied
  components.
- Ownership and cut-capture seam for body-garment contact/interaction reads.
- Shared narrative-focus policy for intimate body and garment observations.
- Whether effective coverage is captured in the presentation cut directly or
  reconstructed from captured garment reads.
