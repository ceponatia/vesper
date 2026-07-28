# Romantic contact affordances — foot domain

Status: technical companion to
[romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)
(promoted 2026-07-28 — the first proving domain, committed slices 0–4; ships
to finished/ when implemented)

## Scope

This domain proves the
[shared contact core](romantic-contact-affordances.spec.contact-core.md) through
foot-focused romantic play. It owns foot surface topology, stable regional
profile compilation, foot-specific mechanics, and foot phenomenon vocabulary.
It does not own pose, contact commitment, footwear state, moisture production,
residue persistence, reactions, or narrator wording.

## Semantic surface topology

This is an interaction map, not a biomechanical mesh.

```text
foot
├── plantar_surface (authoring label: sole)
│   ├── heel_pad
│   ├── arch
│   │   ├── medial_arch
│   │   └── lateral_arch
│   ├── ball
│   ├── inner_edge
│   └── outer_edge
├── dorsal_surface
│   └── top_of_foot
├── toes
│   ├── toe_tops
│   ├── toe_pads
│   ├── interdigital_spaces
│   └── toenails
└── ankle_boundary
```

Side and digit identity are carried by `BodyLocusRef`, not duplicated in every
surface id. The ankle boundary is adjacent topology rather than a child of the
sole.

## Profile compilation

```ts
interface FootSurfaceStructuralProfile extends RegionalStructuralProfile {
  domain: "foot";
  surfaceId: FootSurfaceId;
  parentSurfaceId?: FootSurfaceId;
  softness: UnitInterval;
  compliance: UnitInterval;
  drySurfaceFriction: UnitInterval;
  callusBand: UnitInterval;
  moistureRetention: UnitInterval;
  airflowExposure: UnitInterval;
  tactileTextureBand: FootTextureBand;
}
```

Child surfaces inherit a sparse parent profile and apply calibrated modifiers:

- heel increases firmness/callus and usually reduces compliance;
- arch reduces callus and usually increases softness/compliance;
- ball increases pressure exposure relative to the arch;
- interdigital spaces increase moisture retention and reduce airflow when
  current articulation closes the space;
- dorsal surface remains distinct from the plantar baseline;
- toenails use hard-surface structure rather than skin inheritance.

Character authoring should not require a complete profile per subregion.
Canonical attribute ids need a promotion-time registry audit; no new field is
added merely to encode a derived heel/arch difference.

## Current condition

```ts
interface FootSurfaceConditionRead extends SurfaceConditionRead {
  surfaceId: FootSurfaceId;
  moisture: UnitInterval;
  sweatContribution: UnitInterval;
  temperatureBand?: ContactTemperatureBand;
  cleanlinessBand?: CleanlinessBand;
  residues: readonly SurfaceResidueRead[];
  pressureMarks: readonly BodySurfaceMarkRead[];
  coveredDuration?: StoryDuration;
}
```

Body/physiology state supplies sweat, wetness, and temperature. Product,
environment, and contact events supply residues. The foot adapter may
distribute a nonzero coarse foot condition across regions using retention and
airflow modifiers, but it must preserve zero:

```text
no source wetness → no regional wetness
no residue event → no residue
no mark event → no mark
```

Regional distribution permits:

- sole damp while exposed dorsal skin has dried;
- interdigital spaces retaining moisture longer than toe tops;
- lotion on the arch but absent between toes;
- dirt or grass only on contacted surfaces;
- a strap line appearing only while an authoritative mark remains.

## Support and articulation

```ts
interface FootSupportRead {
  footId: FootId;
  supportRole: "weight_bearing" | "partial" | "free";
  mobility: "free" | "limited" | "fixed" | "trapped";
  supportSurfaceId?: EntitySurfaceId;
  evidence: readonly AffordanceEvidence[];
}
```

Support role does not determine whole-body posture. A seated character may
brace both feet; a lying character may press a foot against a wall; a standing
character may have one free foot.

Articulation capacity is stable/current mechanics. Actual toe curl, flex,
spread, point, or ankle rotation is committed pose state. Touch never causes an
expressive movement unless a behavior/reaction owner chooses and commits it.

## Footwear integration

Wardrobe supplies sparse semantic parts:

```text
sock / hosiery: cuff · leg_section · heel_section · sole_section · toe_section
shoe: upper · toe_box · tongue · closure · heel_counter · insole · outsole
```

```ts
interface FootwearContactRead {
  coveringLayers: readonly GarmentLayerRead[];
  containedSurfaces: readonly FootSurfaceId[];
  compression: UnitInterval;
  rigidity: UnitInterval;
  toeBoxVolume: UnitInterval;
  ankleRestriction: UnitInterval;
  effectiveFriction: UnitInterval;
  permeability: UnitInterval;
  closureState: GarmentClosureRead;
}
```

Invariants:

- socks, hosiery, and shoes block direct skin contact where their current parts
  cover the requested surface;
- flexible fabric may transmit touch while filtering texture;
- open-toed footwear may expose toe surfaces but not the sole or heel;
- a loose shoe may permit heel slip while containing the toes;
- tight/rigid footwear may restrict articulation and hide deformation;
- shoe/sock removal and closure changes are committed wardrobe actions;
- pressure marks are body-state reads after an owner event, not footwear
  affordance memory.

## Phenomena

### `foot.contact_pressure`

Consumes committed contact, pressure intent, surface geometry, support, area
hint, and motion.

Outputs:

- contact locus or path;
- `trace | light | moderate | firm`;
- `point | narrow | broad`;
- semantic distribution when a path crosses heel, arch, ball, edges, or toes.

It does not create redness or a pressure mark.

### `foot.surface_texture_contact`

Requires a tactile channel. Combines regional profile, current condition, and
material transmission.

Example tags:

- `soft_arch`;
- `firmer_ball`;
- `rougher_heel`;
- `smooth_dorsal_surface`;
- `ribbed_sock_filtered`;
- `stocking_filtered`;
- `moisture_softened`.

Tags remain relative and semantic; the narrator never sees coefficients.

### `foot.glide_response`

Requires current sliding motion. Inputs include local friction/compliance,
authoritative lotion/oil/sweat/water/residue, material between, pressure, area,
and the current path.

Outputs:

- `dragging`;
- `controlled_glide`;
- `smooth_glide`;
- `slippery`;
- `grip_breaks`;
- `rough_surface_catch` only when the path reaches a qualifying surface.

An absent moisture/product source cannot produce `slippery`.

### `foot.articulation_observation`

Consumes committed pose state and restriction:

- toes `relaxed | flexed | curled | pointed | spread`;
- arch `neutral | extended`;
- movement restriction from support, footwear, contact, or obstruction.

It never assigns emotional meaning.

### `foot.nail_contact`

Consumes actual nail contact, nail length/shape/condition, angle, pressure, and
motion.

It may emit `light_nail_trace` or `firm_nail_edge`. A scratch is only a proposed
effect until the body-state owner commits it.

### `foot.pressure_mark_surface_state`

Reads existing marks such as sock ribbing, strap lines, or shoe compression
after the covering changes. It carries mark provenance and owner expiry; the
affordance domain has no hidden aftermark timer.

### `foot.surface_transfer`

Calculates transfer eligibility from contact, motion, pressure, permeability,
and source residue. It proposes an effect with source amount and target locus.
Only a committed effect event makes the resulting residue observable.

### `foot.scent_proximity`

Requires current contributors plus olfactory access:

- authored baseline scent where applicable;
- current sweat/cleanliness;
- products/residues;
- exposure/permeability;
- distance and airflow.

Scent is a current perception result, not a permanent moral or hygiene label.

### `foot.contact_temperature`

Requires tactile contact and body/environment temperature reads. It emits only
a relative band (`cooler | similar | warmer`) and confidence. It is not the
passive visual thermal phenomenon excluded from body-attribute affordances.

## First calibration fixture

```text
target:
  seated; one bare, free foot resting in player's lap
  lotion present on arch and ball, absent on heel
  arch softer/smoother than heel

action:
  player's palm slides from arch across heel
  light-to-moderate broad pressure

expected:
  contact committed without major reposition
  direct skin path
  soft/smooth arch observation
  easy glide while path crosses lotion
  localized heel drag/catch
  no invented toe curl, sweat, scent, scratch, residue transfer, or pleasure
```

The first fixture should be evaluated as pure mechanics, then with cue ranking,
then in romantic chat.

## Required fixture matrix

- seated character with one bare free foot in the player's lap;
- standing character attempting to lift the only weight-bearing foot;
- free heel reachable after slight ankle rotation;
- trapped foot requiring explicit reposition;
- heel reachable by hand but not mouth from current geometry;
- shoe and sock blocking direct skin access;
- open-toed footwear exposing toes but not sole/heel;
- toe movement physically possible but hidden in rigid footwear;
- toe movement transmitted through flexible fabric during touch;
- arch versus heel tactile profile;
- sole damp while dorsal surface is drier;
- interdigital moisture retained after toe tops dry;
- between-toe access blocked by current articulation;
- nail trace versus uncommitted scratch;
- lotion-assisted glide with localized heel catch;
- pressure mark absent before owner event and visible after removal;
- transfer absent before commit and present afterward;
- scent suppressed by coverage/distance and allowed after qualifying change;
- held contact suppressed until pressure, path, material, or motion changes.

## Test properties

- parent inheritance and regional overrides are deterministic;
- increasing callus does not increase softness at the same locus;
- increasing authoritative moisture does not increase effective dry drag under
  an otherwise identical direct-skin sliding fixture;
- zero source moisture remains zero across regional distribution;
- no committed contact yields no pressure, texture, glide, nail, or transfer
  observation;
- footwear filters the correct surfaces rather than the whole foot;
- state owner rollback removes the corresponding mark/residue read;
- identical fixtures produce identical observations, evidence, and repeat keys.

Open questions are centralized in the
[plain-English plan](romantic-contact-affordances.plan.md#open-questions).
