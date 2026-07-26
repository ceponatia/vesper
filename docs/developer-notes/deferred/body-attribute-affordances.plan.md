# Body-attribute physics and visual affordances

Status: draft (stub — parked 2026-07-26, owner request; promote per
[CLAUDE.md](CLAUDE.md) before building)

## What

Build a deterministic backend layer that turns **resolved body/appearance
attributes plus authoritative live state** into structured facts about what is
physically and visually happening now.

The motivating case is hair:

- the character has shoulder-length, dense, coarse blonde hair;
- rain has raised hair wetness and produced clumping;
- the current pose/contact read says loose hair touches an exposed neck;
- a light breeze is present.

The system should derive that damp strands may cling to the neck while the
water-loaded hair is too heavy to lift freely. The narrator receives the
resulting observation and suppression facts rather than being asked to infer
all of that from vague prose.

The target output is a compact observation such as:

```ts
{
  kind: "visual_observation",
  id: "hair.strands_adhere_to_skin",
  sourceLocationId: "hair",
  targetLocationId: "neck",
  intensityBand: "clear",
  semanticTags: ["damp", "clumped", "several_strands"],
  cause: { kind: "recent_rain_exposure", endedMinutesAgo: 2 },
}
```

The narrator may realize that as:

> Damp strands of blonde hair cling to her neck after the walk through the
> rain.

The prose is not stored in the physics registry. The structured observation is
shared truth; narration is one consumer.

## Owner intent clarified

This plan is primarily about **grounded visual narration**, not a general
physics engine.

It should answer:

- What visible state follows from these attributes and current conditions?
- What motion or deformation is actually occurring because of a current force,
  contact, pose, or impulse?
- What visible consequence is suppressed by wetness, binding, support,
  coverage, or geometry?
- Which one or two observations are worth offering to the narrator now?

It should not become:

- a rigid-body, cloth, fluid, or differential-equation simulator;
- a general action-success validator;
- a strength/carrying rules system;
- a behavior generator that decides what a character chooses to do;
- a second physiology, wardrobe, pose, or image-generation system;
- a prompt-time vision model call.

The architecture may later support action validation or animation, but those
consumers must use separate query/output types rather than overloading the
narrator cue contract.

## Boundary with adjacent systems

Keep five layers separate.

1. **Canonical attributes** — structural or slowly mutable facts such as hair
   length, texture, density, body proportions, skin tone, or wing span.
2. **Authoritative live state** — wetness, dirt, temperature, support, binding,
   coverage, pose, contact, motion, and recent force/exposure events. The
   system that owns each state remains authoritative.
3. **Physical profile composition** — per-attribute files translate canonical
   values into normalized material or geometry parameters.
4. **Phenomenon resolution** — pure rules combine the profile with live state
   and context to derive actual observations or constraints.
5. **Perception and narration read** — observer visibility, novelty, salience,
   repetition control, and structured narrator cues.

The [physiology stub](physiology.plan.md) owns processes such as exertion →
sweat, embarrassment → vascular response, or cold → piloerection. This plan
may consume their authoritative results, but it must not derive them again.

The wardrobe system owns garments, material identity, fit, support, and worn
state. The pose/contact system owns asserted geometry. The affordance layer
reads those facts; it does not quietly replace them.

## Reference-photo input boundary

Reference photographs are useful upstream, but the affordance resolver should
never inspect an image during a turn.

```text
reference images / manual authoring
                ↓
vision extraction proposes canonical attribute values
                ↓
validation, confidence policy, and optional human correction
                ↓
resolved AttributeValue records with provenance
                ↓
physical-profile composition and phenomenon resolution
```

Rules:

- Raw vision prose is never executable physics input.
- Only values accepted into the canonical attribute registry may contribute.
- A low-confidence or unknown value fails closed; the resolver does not invent a
  material property from the image description.
- Manual edits and later authoritative overlays supersede extracted values
  through the existing attribute-resolution law.
- Extraction provenance may be retained for authoring/debugging, but runtime
  rules depend on the resolved value, not on which model guessed it.

This gives reference images descriptive power without making narration depend
on repeated, nondeterministic image interpretation.

## Output taxonomy

The earlier drafts used “affordance” for several different things. Keep the
contracts distinct.

### 1. Derived visual observation

A state or effect that is actually present now:

- damp hair gathered into clumps;
- loose strands adhering to exposed skin;
- a hem fluttering in the current wind;
- visible moisture beading on skin;
- a tail pinned to one side by the current chair and posture.

These may become narrator cues after perception and ranking.

### 2. Constraint read

A fact that prevents or limits an otherwise plausible effect:

- hair bound in a braid;
- wing span blocked by a narrow room;
- soft-tissue motion damped by strong support;
- skin hidden by opaque coverage.

Constraints normally stay out of the prompt unless they are needed to prevent a
specific contradiction or explain an action.

### 3. Action capability query — future consumer, not v1 narrator output

Questions such as “can this character reach the shelf?”, “can she carry another
character?”, or “could the wing shelter both people?” are useful but are not
visual observations. They should eventually query the same normalized profiles
through a separate API. They must not be mixed into the ambient visual-cue
list.

```ts
type AffordanceRead = VisualObservation | ConstraintRead;

interface VisualObservation {
  kind: "visual_observation";
  id: AffordanceId;
  subjectId: CharacterId;
  sourceLocationId: BodyLocationId;
  targetLocationId?: BodyLocationId;
  intensity: UnitInterval;
  intensityBand: "subtle" | "clear" | "strong";
  semanticTags: readonly string[];
  causalEventIds: readonly EventId[];
  evidence: readonly AffordanceEvidence[];
  repeatKey: string;
}

interface ConstraintRead {
  kind: "constraint";
  id: AffordanceConstraintId;
  subjectId: CharacterId;
  affectedPhenomenonIds: readonly AffordancePhenomenonId[];
  strength: UnitInterval;
  evidence: readonly AffordanceEvidence[];
}
```

Suppressed candidates and detailed equations are diagnostics. They are never
sent to the narrator as prose material.

## Design principles

### 1. Attribute files contribute orthogonal parameters

Each executable attribute gets one explicit file, but that file should not own
complete sentences or cross-input rules.

```text
hair.length            → length scale and nominal reach
hair.density           → bulk density
hair.strand_thickness  → strand mass band
hair.texture           → curl retention and flexibility
hair.condition         → friction, damage, and clump response
structured style state → binding and exposed-free fraction
```

Prefer one owner per physical-profile path. Two attribute files should not both
write an ambiguous `hair.mass` value and hope composition is obvious. Combined
quantities such as effective mass belong in the phenomenon resolver.

Where multiple inputs truly must contribute to one profile path, the profile
schema declares one central reducer (`add`, `multiply`, `min`, `max`, or a named
pure reducer). Merge order must never depend on file-registration order.

### 2. Phenomenon files own interactions

One file owns one cross-input behavior:

```text
resolved hair profile
+ hair wetness
+ structured binding/support
+ current coverage
+ current wind or motion impulse
                  ↓
phenomena/hair/wind-motion.ts
                  ↓
actual observation or explicit suppression
```

This avoids duplicating wind logic in every hair attribute definition.

### 3. Use semantic fixed-point physics

The source attributes are semantic enums, not laboratory measurements. Map them
to bounded fixed-point parameters (`0..10_000`) whose purpose is stable ordering
and deterministic calibration.

Do not claim exact strand diameters, kilograms, drag coefficients, tissue
elasticity, or heat transfer unless those values become real authored data.

### 4. Actual, not merely possible

A narrator cue must describe an effect supported by current authoritative
inputs.

- Hair length may make neck contact possible, but it does not prove contact.
- Flexible hair may respond to wind, but it is not moving without a current wind
  state, subject motion, or impulse event.
- A wing may be large enough to shelter someone, but that is a future capability
  query, not an observation that shelter is occurring.

Unknown inputs fail closed for specific claims.

### 5. Read-only derivation

The affordance resolver must not:

- write attributes or live body state;
- create or expire conditions;
- alter wetness, coverage, support, pose, or contact;
- emit gameplay events;
- decide a character's behavior;
- write narration;
- query persistence.

If droplets actually leaving hair must reduce retained water, the wetness owner
records that state transition. The affordance read may describe the observed
shedding event from the committed impulse, but it cannot mutate water state as
a side effect.

### 6. No affordance-owned hysteresis

The read layer should remain reconstructable from authoritative inputs.

An effect that persists after its cause — pressure marks after socks are
removed, a displaced strap, hair left tangled after wind — is real state and
belongs to the body/presentation owner or to an explicit event/condition. It is
not an invisible latch owned by the affordance cache.

Band thresholds may be used for output stability, but v1 stores no dirty flags,
activation latches, or standing candidates in the affordance layer.

### 7. Recompute first; optimize only after profiling

V1 should recompute the relevant phenomenon set for the characters in the
current presentation cut. The expected scale is small, and correctness is more
important than a reverse-dependency cache that can become stale.

Every phenomenon still declares dependencies for:

- test completeness;
- debug explanations;
- selective domain assembly;
- future memoization by complete input fingerprint if profiling proves useful.

Do not persist dirty sets. Do not add a worker or tick loop.

## Proposed code layout

```text
src/contracts/affordances/
  types.ts                         # fixed-point, evidence, observation/constraint contracts
  inputs.ts                        # immutable normalized resolution context
  profile.ts                       # typed profile composition + provenance
  registry.ts                      # explicit registration and validation
  dependencies.ts                  # declared paths for tests/debug; no persisted dirty state
  attributes/
    hair/
      length.ts
      density.ts
      strand-thickness.ts
      texture.ts
      condition.ts
      index.ts
    skin/
      tone.ts
      texture.ts
      index.ts
    build/
      height.ts
      frame.ts
      index.ts
    morphology/
      wing-span.ts
      tail-length.ts
      index.ts
    index.ts
  phenomena/
    hair/
      wet-clumping.ts
      wind-motion.ts
      skin-contact.ts
      droplet-shedding.ts
      index.ts
    skin/
      moisture-visibility.ts
      color-response.ts
      contamination.ts
      index.ts
    garment/
      wet-cling.ts
      wind-motion.ts
      index.ts
    appendages/
      constraint-state.ts
      wet-loading.ts
      index.ts
    soft-tissue/
      support-rest-state.ts
      impulse-motion.ts
      contact-compression.ts
      index.ts
    relative-geometry/
      stature-blocking.ts
      index.ts
    index.ts
  read/
    derive.ts                      # pure current-cut resolution
    perception.ts                 # coverage, light, distance, orientation, contact
    rank.ts                        # novelty, relevance, salience, repetition cap
    to-narrative-cues.ts           # structured projection, never final prose
  testing/
    fixtures.ts
    assertions.ts
```

Names are provisional. The rulings are:

- one file per executable attribute contribution;
- one file per cross-input phenomenon;
- explicit registry imports, never filesystem auto-discovery;
- typed domain profiles rather than one universal coefficient soup;
- no lane-specific duplicate implementation.

## Attribute-physics contract

```ts
interface AttributePhysicsDefinition<TValue extends string, TContribution> {
  attributeId: AttributeId;
  version: number;
  profileKind: PhysicalProfileKind;
  ownedPaths: readonly PhysicalProfilePath[];
  values: Readonly<Partial<Record<TValue, TContribution>>>;
  provisional?: boolean;
}
```

Definition-time invariants:

- `attributeId` exists in `attributeRegistry`;
- every mapped enum key is legal;
- contribution values are bounded and typed;
- each exclusive profile path has one owner;
- every shared path names a central reducer;
- free-text values cannot be authoritative physics;
- provisional mappings are visible in diagnostics and tests;
- definition versions never decrease.

Absence means “no distinct contribution known,” not “infer one from the label.”

## Vocabulary prerequisites

### Hair quality must be split

`hair.quality` currently mixes several dimensions:

- `fine`, `thick`, `coarse` — strand/bulk structure;
- `dry`, `brittle`, `straw_like` — condition/damage;
- `silky`, `soft`, `glossy` — surface feel/appearance.

Executable rules should not guess what `thick` means. Promotion should replace
or supplement it with orthogonal attributes, likely:

- `hair.strand_thickness` — fine / medium / coarse;
- `hair.density` — sparse / average / dense / very_dense;
- `hair.condition` — healthy / dry / brittle / damaged / straw_like;
- optional `hair.surface` — matte / soft / silky / glossy.

Existing stored values need an explicit migration/sweep policy. Ambiguous values
should not be silently expanded into multiple high-confidence axes.

### Hair style needs structured state

`hair.style` is free text and should remain useful display text, but runtime
physics cannot regex it every turn.

Add a validated presentation contract such as:

```ts
interface HairPresentationState {
  arrangement: "loose" | "ponytail" | "braid" | "bun" | "other";
  boundFraction: UnitInterval;
  pinnedFraction: UnitInterval;
  coveredFraction: UnitInterval;
  looseEndLengthBand?: HairLengthBand;
}
```

The forge/editor may derive a proposed structure once from the text, but only
the validated structure drives physics.

## Normalized live input

```ts
interface AffordanceResolutionContext {
  storyTime: StoryTimestamp;
  subjectId: CharacterId;
  profile: ResolvedPhysicalProfile;
  bodyState: {
    wetnessByLocation: ReadonlyMap<BodyLocationId, UnitInterval>;
    contaminationByLocation: ReadonlyMap<BodyLocationId, ContaminationRead>;
    physiologySigns: readonly PhysiologySignRead[];
  };
  presentationState: {
    coverageByLocation: ReadonlyMap<BodyLocationId, CoverageRead>;
    constraints: readonly PresentationConstraintRead[];
    supportByLocation: ReadonlyMap<BodyLocationId, SupportRead>;
    hair?: HairPresentationState;
    wornGarments: readonly GarmentPhysicalRead[];
  };
  poseState: {
    posture: PostureRead;
    orientation?: OrientationRead;
    contactPairs: readonly BodyContactPair[];
    motion?: MotionRead;
  };
  environment: {
    wind?: WindRead;
    precipitation?: PrecipitationRead;
    humidity?: UnitInterval;
    space?: SpaceConstraintRead;
  };
  recentEvents: readonly AffordanceCausalEvent[];
}
```

The caller assembles this immutable context. Phenomenon code performs no
persistence reads and no prompt parsing.

## Trigger and resolution semantics

State changes do not directly write narration or a persisted affordance row.
They change the authoritative inputs that the next read consumes.

```text
attribute / body / presentation / pose / environment / event changes
                               ↓
current-cut input assembler reads authoritative state at story time
                               ↓
relevant domain phenomena resolve as pure functions
                               ↓
perception filters actual observations
                               ↓
ranking selects at most one or two useful cues
                               ↓
selected read captured with the committed presentation cut
```

Impulse observations require a matching committed event or current motion read.
Standing observations require current state. A retake renders the captured read
from the original cut rather than recomputing against a later clock.

## Hair proving domain

The first implementation should prove four phenomena.

### Wet clumping

Inputs: hair profile, current hair wetness, contamination, and current
presentation arrangement.

Outputs may include:

- `hair.wet_clumping`;
- `hair.appears_darker_when_wet` as a relative semantic change;
- retained-droplet eligibility.

### Wind or body-motion response

Inputs: exposed loose fraction, length, density, strand thickness, flexibility,
water loading, current wind, current subject motion, and binding/coverage.

Wetness raises effective load and clumping. It must not increase whole-hair wind
mobility. Strong motion may still move exposed ends while the bound or soaked
bulk remains constrained.

### Skin contact and adhesion

Hard requirements:

- nominal reach includes the target location;
- a current pose/contact read asserts hair ↔ target contact;
- sufficient wetness/clumping exists;
- source and target are not blocked by opaque coverage.

Hair length licenses reach, not contact. The target comes from the geometry
owner.

### Droplet shedding

Requires retained water plus a current impulse event such as a shake, abrupt
turn, run, impact, or gust. It may emit an observed shedding cue but cannot
reduce wetness itself.

### Worked cases

- **Dry, fine, loose hair + moderate wind:** visible strand movement may resolve;
  no adhesion without wet contact.
- **Saturated, dense/coarse hair + light wind + exposed neck contact:** clumping
  and adhesion resolve; whole-hair flight is suppressed.
- **Same hair braided under a hood:** binding/coverage suppress visible movement
  and neck adhesion.
- **Damp thick hair + strong gust + loose ends below a hood:** an ends-only
  movement observation may resolve; the narrator cannot claim the entire style
  flies free.

## Perception, salience, and narrator handoff

Physics answers what is present. Perception answers what this observer can
notice. Ranking answers whether it is worth mentioning now.

Consider:

- coverage, opacity, and occlusion;
- light, distance, orientation, and line of sight;
- visual versus tactile channel;
- change from the character's familiar baseline;
- relevance to the current action;
- recent use of the same `repeatKey`.

The prompt receives at most one or two cues. Static attributes remain available
for introductions and deliberate inspection; affordance cues are for current,
concrete behavior and change.

The narrator contract should require it to:

- integrate cues into current action rather than list them;
- preserve supplied intensity, target region, and cause;
- never invent a suppressed effect;
- avoid repeating familiar details merely because they remain physically valid.

## Testing strategy

### Registry tests

- all mapped IDs and enum values are legal;
- exclusive profile paths have one owner;
- shared paths have an explicit deterministic reducer;
- all coefficients are bounded;
- free-text attributes cannot drive physics directly;
- every phenomenon declares known dependencies and output IDs.

### Domain mapping tests

- longer hair never reduces nominal reach;
- greater density or water load never lowers effective bulk load;
- stronger binding never increases exposed loose fraction;
- stronger opaque coverage never increases visual visibility.

### Phenomenon tests

- wet dense hair in light wind does not produce a whole-hair flight observation;
- current neck contact plus wet clumping can produce adhesion;
- reach without asserted contact cannot;
- an impulse is required for droplet shedding;
- opaque coverage blocks the visual channel without erasing physically valid
  hidden state;
- no current force/motion means no motion observation.

### System properties

- deterministic output for identical canonical inputs and registry version;
- pure resolvers do not mutate frozen context;
- missing geometry and state fail closed;
- no hidden-state leakage through observer reads;
- retakes reuse captured observations;
- no affordance-owned persistent latches or dirty rows;
- no cue block means byte-identical existing prompt behavior.

## Rollout slices

### Slice 0 — vocabulary and ownership audit

- Split or conservatively quarantine `hair.quality`.
- Add validated structured hair presentation state.
- Inventory authoritative wetness, coverage, pose/contact, force, and event
  inputs.
- Record the exact chat/successor cut seams.

### Slice 1 — contracts and explicit registries

- Add typed profile, context, observation, constraint, evidence, and registry
  contracts.
- Implement per-attribute contribution registration with path ownership/reducers.
- Implement pure profile composition and diagnostics.
- No production narrator consumer.

### Slice 2 — hair fixture proof

- Author hair contribution files.
- Implement the four hair phenomena as pure functions.
- Land mapping, matrix, fail-closed, and suppression tests using static fixtures.

### Slice 3 — production input assembly

- Assemble current-cut context from authoritative resolved state.
- Resolve relevant hair phenomena directly; no cache/dirty-state machinery.
- Add debug explanations that show inputs, contributions, and suppression.

### Slice 4 — perception and cut capture

- Gate observations by observer perception.
- Add novelty, salience, relevance, repeat keys, and a strict cue cap.
- Capture the read with the committed presentation cut.
- Prove hidden-state safety and retake stability.

### Slice 5 — chat narrator integration and evaluation

- Add a bounded cue block behind a feature flag.
- Add deterministic rain/adhesion and wet-heavy-wind suppression fixtures.
- Compare contradiction rate, repetition, and concrete sensory detail against the
  current static-attribute path.

### Slice 6 — second-domain proof

Choose one different but still visual domain — preferably skin surface or
worn-garment wet cling — and prove the architecture is not hair-shaped. Shared
scene-image or successor consumers may follow only after the narrator read is
stable.

## Companion spec drafts

- [body-attribute-affordances.spec.hair.md](body-attribute-affordances.spec.hair.md)
  — first implementation and calibration target.
- [body-attribute-affordances.spec.skin-surface.md](body-attribute-affordances.spec.skin-surface.md)
  — externally produced physiology/body-state signs turned into observable
  surface detail.
- [body-attribute-affordances.spec.garment-interaction.md](body-attribute-affordances.spec.garment-interaction.md)
  — wardrobe-owned material profiles composed with body state for wet cling,
  opacity change, and motion.
- [body-attribute-affordances.spec.appendages.md](body-attribute-affordances.spec.appendages.md)
  — morphology constraints and actual appendage state/motion; action capability
  offers stay separate.
- [body-attribute-affordances.spec.soft-tissue.md](body-attribute-affordances.spec.soft-tissue.md)
  — support, gravity, contact, and impulse-driven visible deformation with a
  strict narrative-focus gate.
- [body-attribute-affordances.spec.stature-reach.md](body-attribute-affordances.spec.stature-reach.md)
  — restricted here to relative stature/body blocking useful to narration;
  generic reach, passage, carry, and strength validation are future consumers.

Passive thermal observables were removed from this plan family. They depend
almost entirely on environment and physiology rather than body-attribute
composition and belong in a future environment/perception design if needed.

## Open questions

- Exact replacement/sweep strategy for `hair.quality`.
- Which system owns validated structured hair presentation state.
- First authoritative coarse contact-pair producer before a detailed pose model.
- Whether wet color change needs authored lightness metadata or only semantic
  relative tags.
- Whether affordances consume perception-safe physiology signs or lower-level
  body-state projections.
- Which domain follows hair: skin surface or garment wet cling.
- How reference-image extraction confidence becomes an accepted canonical value
  without silently filling uncertain physics axes.
