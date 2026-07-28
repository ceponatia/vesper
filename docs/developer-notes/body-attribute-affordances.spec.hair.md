# Affordance spec draft — hair

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted with the plan 2026-07-28)

## Purpose

Hair is the proving domain for the
[profile → mechanics → frame architecture](body-attribute-affordances.spec.architecture.md).
It must show that canonical appearance attributes and live state can produce
current, physically consistent visual observations without asking every
phenomenon—or the narrator—to reinterpret raw hair vocabulary.

The flagship contrast:

- dry, fine, loose hair may lift in a moderate breeze;
- saturated, dense/coarse hair should clump, load with water, and resist the
  same breeze;
- wet loose strands may adhere to exposed skin only when contact is asserted;
- binding and coverage constrain otherwise-valid motion.

## Inputs and ownership

### Canonical attributes

Preferred executable axes:

- `hair.length` → length scale and nominal anatomical reach;
- `hair.strand_thickness` → strand mass band;
- `hair.density` → bulk density;
- `hair.texture` → flexibility and curl retention;
- `hair.condition` → surface friction, water absorption, and clump affinity;
- optional `hair.surface` → appearance response metadata;
- `hair.color` → cue-realization metadata, not adhesion or motion mechanics.

The current `hair.quality` entangles several of these dimensions. Promotion
must split it or quarantine ambiguous mappings as provisional.

### Presentation state

Free-text `hair.style` remains display text. Runtime mechanics consume validated
structure:

```ts
interface HairPresentationState {
  arrangement: "loose" | "ponytail" | "braid" | "bun" | "other";
  boundFraction: UnitInterval;
  pinnedFraction: UnitInterval;
  coveredFraction: UnitInterval;
  looseEndLengthBand?: HairLengthBand;
}
```

### Live state

- wetness and contamination at the hair location;
- current wind, subject motion, and committed impulses;
- current hair-to-body contact pairs;
- validated hair binding/coverage for mechanics, plus observer coverage/opacity
  for downstream perception;
- recent rain, immersion, splash, shake, gust, turn, run, or impact events.

Missing force, contact, or exposure fails closed for the corresponding claim.

## Structural profile

Each attribute map contributes only its own axes:

```ts
interface HairStructuralProfile {
  lengthScale: UnitInterval;
  nominalReach: ReadonlySet<BodyLocationId>;
  bulkDensity: UnitInterval;
  strandThickness: UnitInterval;
  flexibility: UnitInterval;
  curlRetention: UnitInterval;
  surfaceFriction: UnitInterval;
  waterAbsorption: UnitInterval;
  clumpAffinity: UnitInterval;
}
```

The profile is stable for a resolved attribute snapshot. It contains no current
wetness, binding, coverage, contact, or force.

`hair.length` and `hair.density` do not both write a vague final `mass`.
Combined terms belong to `deriveHairMechanics`.

## Effective mechanics

Hair structure and current presentation/body state compile once into reusable
current mechanics:

```ts
interface HairEffectiveMechanics {
  dryBulkLoad: UnitInterval;
  waterLoad: UnitInterval;
  effectiveLoad: UnitInterval;
  freeMovingFraction: UnitInterval;
  exposedFreeArea: UnitInterval;
  clumpStrength: UnitInterval;
  retainedWater: UnitInterval;
  mobilityCapacity: UnitInterval;
}
```

Conceptually:

```text
dryBulkLoad =
  lengthScale × bulkDensity × strandThickness

waterLoad =
  dryBulkLoad × waterAbsorption × wetness

freeMovingFraction =
  inverse(bound) × inverse(pinned) × inverse(covered)

exposedFreeArea =
  lengthScale × bulkDensity × freeMovingFraction

clumpStrength =
  wetness × clumpAffinity × surfaceFriction adjustment

retainedWater =
  waterLoad × clump retention adjustment

mobilityCapacity =
  flexibility × exposedFreeArea × inverse(clumpStrength)
  ----------------------------------------------------
  effectiveLoad
```

The implementation uses bounded fixed-point helpers and calibrated reducers,
not floating-point pseudo-precision. Division uses a declared nonzero floor.

These fields are shared because:

- effective load matters to wind and body-motion response;
- free moving fraction matters to motion, adhesion, and droplet shedding;
- clump strength matters to clumping, adhesion, and retained water;
- retained water matters to droplet eligibility;
- mobility capacity is a stable present response capacity.

High `mobilityCapacity` does not mean hair is moving. Actual motion still needs
a current force or committed impulse.

## Domain frame

```ts
interface HairAffordanceFrame {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: HairStructuralProfile;
  mechanics: HairEffectiveMechanics;
  presentation: HairPresentationState;
  wetness: UnitInterval;
  contamination?: ContaminationRead;
  actualContacts: readonly BodyContactPair[];
  wind?: WindRead;
  motion?: MotionRead;
  recentEvents: readonly AffordanceCausalEvent[];
}
```

The lane adapter assembles the frame from authoritative current-cut reads.
Hair code performs no persistence access.

## Phenomena

### `hair.wet_clumping`

Consumes profile/mechanics, wetness, contamination, and arrangement. It may
emit:

- `slightly_gathered`;
- `distinct_strands`;
- `heavy_clumps`;
- `wet_darkened_relative_to_base`;
- `retains_droplets`.

A rain cause is attached only when a recent authoritative exposure event
supports it.

### `hair.wind_or_motion_response`

Consumes only mechanics, presentation, current wind/motion, and relevant
impulse events.

```text
response = current force × mobilityCapacity × exposedFreeArea
```

Output bands:

- below threshold — silence;
- subtle — flyaways or exposed ends stir;
- clear — loose strands lift or sweep across a region;
- strong — unbound hair whips or streams.

Wetness must not increase whole-hair mobility. A strong gust may move exposed
ends while soaked or bound bulk remains constrained.

### `hair.strands_adhere_to_skin`

Consumes profile reach, clump/retained-water mechanics, presentation, actual
contacts, and final effective coverage.

Hard requirements:

- nominal reach includes the target;
- a current hair ↔ target contact is asserted;
- sufficient wetness/clumping exists;
- enough loose hair exists.

Reach licenses possible contact; it never invents contact.
Coverage/opacity may hide a physically present adhesion read during perception;
it does not erase the underlying contact.

### `hair.sheds_droplets`

Consumes retained water, free moving fraction, and current impulse events. A
shake, sudden turn, run, impact, or gust is required.

The read may describe visible shedding but cannot reduce authoritative wetness
as a side effect.

## Constraints and diagnostics

Expected suppression codes:

- `no_current_force`;
- `bound`;
- `pinned`;
- `covered`;
- `water_loaded`;
- `insufficient_wetness`;
- `target_out_of_reach`;
- `no_asserted_contact`;
- `no_current_impulse`;
- `below_response_threshold`.

Debug output exposes attribute contributions, derived mechanics, the
phenomenon-specific response, and the final threshold/suppression reason.
Perception diagnostics separately record `target_opaque`, occlusion, distance,
light, and unavailable channels.

## Worked cases

### Dry, fine, shoulder-length, loose; moderate breeze

- low effective load and high free-moving fraction support a clear motion read;
- no wet clumping;
- no adhesion without wetness and contact.

### Saturated, dense/coarse, shoulder-length; light breeze; exposed neck contact

- high effective load suppresses whole-hair wind motion;
- wet clumping resolves;
- asserted exposed neck contact licenses adhesion;
- rain provenance appears only if the event exists.

### Same hair braided under a hood

- binding and coverage reduce free-moving fraction and exposed area;
- visible motion is suppressed;
- any authoritative under-hood adhesion remains physically valid but is hidden
  by perception;
- no cue is emitted merely because structural reach made contact possible.

### Damp thick hair; strong gust; loose ends below hood

- covered bulk remains constrained;
- exposed loose ends may stir;
- the observation is ends-only and cannot be narrated as the whole style flying
  free.

## Narrator projection

Physics emits semantic facts:

```ts
{
  kind: "visual_observation",
  id: "hair.strands_adhere_to_skin",
  sourceLocationId: "hair",
  targetLocationId: "neck",
  intensityBand: "clear",
  semanticTags: ["damp", "clumped", "several_strands"],
  repeatKey: "hair:adhesion:neck",
}
```

Cue projection may enrich this with resolved hair color and recent-cause
metadata. Color helps phrase the observation but never affects whether
adhesion occurred.

The prompt gets only a ranked, perception-safe cue—not the hair profile,
mechanics object, equations, or suppressed alternatives.

## Reference-image extraction

A vision model may propose length, texture, color, density, and strand
thickness during authoring. Only accepted canonical values become profile
inputs. Raw image descriptions and low-confidence guesses never enter the
runtime frame.

## Acceptance tests

- phenomena never receive raw hair enum values;
- structural profile compilation is deterministic and registration-order
  independent;
- greater density, strand thickness, or wetness never lowers effective load;
- stronger binding/pinning/coverage never increases free-moving fraction;
- wet dense hair in light wind never produces whole-hair flight;
- reach without asserted contact never produces adhesion;
- contact behind opaque coverage produces no visual cue;
- retained water without an impulse produces no droplet-shedding observation;
- no force/motion input produces no motion observation;
- a strong gust may move exposed ends without moving constrained bulk;
- repeated cues are capped downstream without changing the physical read.

## Open questions

- Final `hair.quality` split and stored-value sweep.
- Which authoring/presentation system owns `HairPresentationState`.
- First authoritative coarse hair/body contact producer.
- Whether wet darkening needs per-color lightness metadata or only a relative
  semantic tag.
- Exact chat/successor frame-adapter and cut-capture seams.
- Calibration tables and thresholds after fixture testing.
