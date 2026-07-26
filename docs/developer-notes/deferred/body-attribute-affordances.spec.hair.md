# Affordance spec draft — hair

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Hair is the proving domain for the body-attribute affordance architecture. It
must show that canonical appearance attributes and live state can be assembled
into current, physically consistent visual observations without asking the
narrator to perform the physics.

The flagship contrast is:

- dry, fine, loose hair may lift in a moderate breeze;
- saturated, dense/coarse hair should clump, load with water, and resist the
  same breeze;
- wet loose strands may adhere to exposed skin only when current contact is
  asserted;
- binding and coverage suppress otherwise-valid motion.

## Canonical inputs

### Attribute-owned inputs

Promotion should replace or quarantine the current entangled `hair.quality`
value before it becomes authoritative physics.

Preferred executable axes:

- `hair.length` → length scale and nominal anatomical reach;
- `hair.strand_thickness` → fine / medium / coarse strand mass band;
- `hair.density` → sparse / average / dense / very_dense bulk density;
- `hair.texture` → curl retention and flexibility;
- `hair.condition` → dry/damaged friction and breakage response;
- optional `hair.surface` → matte / soft / silky / glossy appearance response;
- `hair.color` → realization metadata only, except for calibrated relative
  wet-darkening behavior.

Each axis owns orthogonal profile paths. `hair.length` and `hair.density` must
not both write an unexplained final `mass`; effective load is derived in the
phenomenon rule.

### Presentation-owned inputs

Free-text `hair.style` remains display text. Runtime rules consume validated
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

### Live inputs

- wetness at the hair location;
- current contamination;
- current wind and subject motion;
- current pose/contact pairs;
- current coverage at hair and target skin regions;
- recent rain, immersion, splash, shake, gust, turn, run, or impact events.

Missing live inputs fail closed for specific effects.

## Hair physical profile

```ts
interface HairPhysicalProfile {
  lengthBand: HairLengthBand;
  nominalReach: readonly BodyLocationId[];
  strandThickness: UnitInterval;
  bulkDensity: UnitInterval;
  flexibility: UnitInterval;
  surfaceFriction: UnitInterval;
  waterLoading: UnitInterval;
  clumpAffinity: UnitInterval;
  curlRetention: UnitInterval;
}
```

The profile stores semantic calibration, not laboratory measurements.

## Phenomena

### `hair.wet_clumping`

A standing visual observation derived from current wetness, clump affinity,
texture, condition, contamination, and arrangement.

Possible semantic tags:

- `slightly_gathered`;
- `distinct_strands`;
- `heavy_clumps`;
- `wet_darkened_relative_to_base`;
- `retains_droplets`.

No rain cause may be attached unless a recent authoritative exposure event
supports it.

### `hair.wind_or_motion_response`

An actual motion observation, not a generic statement that the hair “can” move.
It requires current wind, subject motion, or an impulse event.

Conceptually:

```text
force × exposed loose fraction × flexibility
-------------------------------------------------
effective strand/bulk load × water load × binding
```

Output bands:

- below threshold — silence;
- subtle — flyaways or exposed ends stir;
- clear — loose strands lift or sweep across a region;
- strong — unbound hair whips or streams.

Wetness must not increase whole-hair mobility. A strong gust may produce an
ends-only observation while the soaked or bound bulk remains constrained.

### `hair.strands_adhere_to_skin`

Hard requirements:

- current clumping/wetness above threshold;
- nominal reach includes the target region;
- a current hair ↔ skin contact pair is asserted by the geometry owner;
- source and target are not blocked by opaque coverage.

Hair length licenses possible reach only. It never invents contact.

### `hair.sheds_droplets`

Requires retained water plus a committed impulse such as a shake, sudden turn,
run, impact, or gust. The read may describe visible shedding but must not reduce
wetness as a side effect.

## Constraints and suppression

Expected suppression codes include:

- `no_current_force`;
- `bound`;
- `pinned`;
- `covered`;
- `water_loaded`;
- `insufficient_wetness`;
- `target_out_of_reach`;
- `no_asserted_contact`;
- `target_opaque`.

Suppression evidence is diagnostic and test-facing. It is not prose material.

## Worked cases

### A — dry, fine, shoulder-length, loose; moderate breeze

- motion observation may resolve at clear strength;
- no adhesion without wetness and asserted contact;
- no wet-clumping cue.

### B — saturated, dense/coarse, shoulder-length; light breeze; exposed neck contact

- whole-hair wind motion is suppressed by water load and density;
- wet clumping resolves;
- neck adhesion resolves;
- recent-rain cause is included only if the event exists.

### C — same as B, braided under a hood

- binding and coverage suppress motion;
- hood/coverage prevents visible neck adhesion;
- no cue is emitted merely because static hair attributes make it theoretically
  possible.

### D — damp thick hair, strong sudden gust, loose ends below hood

- bound/covered bulk remains constrained;
- exposed ends may stir at subtle strength;
- the narrator may mention the ends, not claim the hairstyle flies free.

## Narrator projection

```ts
{
  kind: "visual_observation",
  id: "hair.strands_adhere_to_skin",
  sourceLocationId: "hair",
  targetLocationId: "neck",
  intensityBand: "clear",
  semanticTags: ["damp", "clumped", "several_strands"],
  cause: { kind: "recent_rain_exposure", endedMinutesAgo: 2 },
  repeatKey: "hair:adhesion:neck",
}
```

The cue may include the resolved hair color for natural realization, but color
is not itself the reason adhesion occurred.

## Reference-image extraction

A vision model may propose hair length, texture, color, density, and strand
thickness during character authoring. Only canonical values accepted into the
attribute registry are physics-authoritative. Raw image descriptions and
low-confidence guesses do not enter this resolver.

## Acceptance tests

- wet dense hair in light wind never produces whole-hair flight;
- increasing wetness beyond the loading band never increases whole-hair
  mobility;
- stronger binding never increases exposed loose fraction;
- reach without current contact never produces adhesion;
- current wet contact behind opaque coverage produces no visual cue;
- droplet shedding requires an impulse event;
- no force/motion input produces no motion observation;
- identical inputs and registry version produce byte-identical output;
- repeated cues are capped downstream without changing the physical read.

## Open questions

- Final `hair.quality` split and stored-value sweep.
- Which authoring/presentation system owns `HairPresentationState`.
- Whether wet darkening needs per-color lightness metadata or only a relative
  semantic tag.
- Exact calibration tables and thresholds after fixture testing.
