# Affordance spec draft — hair

Status: **implemented** — companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted 2026-07-28; built as `src/contracts/affordances/domains/hair/` in
slices 2–3 and wired to chat state in slice 4). Two of the four phenomena —
`hair.strands_adhere_to_skin` and `hair.sheds_droplets` — are built and
production-silent for want of a contact read and an impulse owner.

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
- `retains_droplets`;
- a `wetness_damp` / `wetness_wet` / `wetness_soaked` degree descriptor from
  the committed wetness unit (cuts at 4 000 / 8 000).

A cause tag is attached only when a recent authoritative wetting event
supports it — and **every** wetting kind now names itself (`recent_rain`,
`recent_immersion`, `recent_splash` per `hairWettingEventKinds`), superseding
the 2026-07-28 no-tag-for-immersion ruling: trial round R2 (2026-07-29)
measured that an unattributed wet read invites the narrator to invent the
ambient cause (bath wetness baited into "rain" at 2× control), so cause-true
provenance beats cause-free silence. `other` and stale causes still carry no
tag, and rain remains the only kind that may read as weather.

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

- Whether wet darkening needs per-color lightness metadata or only a relative
  semantic tag (default: relative tag until proven insufficient).
- **Owner calibration call — `HAIR_COVERED_OPAQUE` vs the ends-only motion
  threshold.** The review round mapped opaque headwear to perception
  `hinted`, which lets wet clumping under a hood reach the narrator, but at
  `coveredFraction 9_000` the free area cannot clear `ENDS_RESPONSE_MIN` at
  any hair length, so the fourth worked case's ends-only wind response is
  still unreachable in the chat lane (the domain fixture proves it at
  `6_000`). Either lower the adapter's opaque constant, add an ends-exposure
  carve-out, or accept that the case stays fixture-only — needs a ruling.
- ~~Whether immersion-caused wetness deserves its own provenance tag + cue
  clause~~ — **resolved 2026-07-29** by the rematch campaign's recorded
  cue-side change (trial R2 measured the gap: the cue arm misattributed
  bath wetness to baited rain at 2× control). Every wetting cause now tags
  itself (`recent_rain` / `recent_immersion` / `recent_splash` via
  `hairWettingEventKinds`) and the renderer appends a cause-true clause —
  immersion deliberately reads "still wet from the water it was in", never
  "the bath", because immersion covers pools, rivers, and dunkings. The
  wetness cue adjective now also follows the committed `wetness_*` degree
  descriptor (damp/wet/soaked) rather than the clump band, which understates
  on dense hair. `other` and stale causes stay clause-free. Detail:
  [rematch log](body-attribute-affordances.trial.md#rematch-log).

## Resolved (owner rulings, 2026-07-28)

- **Contact producer**: the ruled shared scene/body-relations owner
  (architecture spec §"Scene/body-relations owner") supplies pose, support,
  and actual contact; character chat ships it first. Hair adhesion consumes
  a simple normalized subset of its contact read. Until that owner ships,
  adhesion stays fixture-only and unknown contact means silence.
  **That owner shipped 2026-07-31** (`src/contracts/affordances/scene/`), but
  `chat-affordances.ts` still omits `contacts` from the hair payload, so the
  core suppresses adhesion with `affordance.input.unavailable` and the
  phenomenon remains fixture-only. Reading the scene owner's active-contact
  projection into that payload is the change that lights it up; nothing else
  in the domain has to move.

## Resolved (Slices 2–3, 2026-07-28)

- **Initial calibration tables and thresholds** ship in code, fixture-proven
  against the four worked cases and full-lattice monotonicity sweeps:
  per-axis contributions in
  `src/contracts/affordances/domains/hair/attribute-maps/`, the
  arrangement → bound/pinned table and derived-mechanics constants in
  `domains/hair/mechanics.ts`, and the per-phenomenon bands/gates in
  `domains/hair/phenomena/`. Two calibration laws worth knowing: hair at
  ≥ ~75% wetness never moves as a whole (a strong gust may still stir
  exposed ends), and `pinned` is checked before `bound` so a bun reports
  `pinned` while braid/ponytail report `bound`. The slice-5 narrator trial
  may retune numbers; the laws and the worked-case behavior are fixed.

## Resolved (Slice 0, 2026-07-28)

- **`hair.quality` split**: removed outright (it had zero code consumers) and
  replaced by executable axes `hair.density` (sparse/medium/dense, inherent,
  render-visual), `hair.strand_thickness` (fine/medium/thick, inherent), and
  `hair.condition` (silky/smooth/healthy/dry/frizzy/brittle/straw_like,
  mutable). Stored values sweep away via the idempotent
  `scripts/sweep-renamed-attribute-values.ts` removal lane; existing
  characters keep blank new axes (owner ruling) and author them through the
  registry-driven character form.
- **`HairPresentationState` ownership**: `arrangement` is the new
  `hair.arrangement` enum attribute (presentation kind, mutable, default
  `loose`), updated live by the archivist `attributeChanges` lane;
  `boundFraction`/`pinnedFraction` derive from arrangement via a calibration
  table inside the hair domain; `coveredFraction` derives from headwear
  garment coverage of the `hair` body location. Free-text `hair.style`
  remains display-only.
- **Chat frame-adapter and capture seams**: the frame assembles from
  committed pre-narration state in the chat pipeline (the
  `buildChatGarmentNarration` slot); wetness lives on `ChatState`, the
  environment read on `ChatScenario`, and the affordance cue/repeat memory
  rides the rolled-back state exactly as garment `cueState` does, so retakes
  recompute the identical read from the restored anchors. The successor
  adapter + narrative-cut capture is a named follow-up (see the audit's
  source map).
