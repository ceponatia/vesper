# Body-attribute visual affordances

Status: next (promoted from deferred/ 2026-07-28, owner ruling: the shared
affordance core — structural profiles, phenomenon registry, evidence,
perception + cue ranking — builds under this plan first; the foot-first
[romantic contact plan](romantic-contact-affordances.plan.md) queues directly
behind it and consumes that core. Companion specs ship and move to `finished/`
individually as their domains land; this plan ships when the owner is
satisfied the necessary domains are covered.)

## What

Build a deterministic read layer that turns **resolved body/appearance
attributes plus authoritative live state** into a small number of grounded
visual observations for narration and, later, scene composition.

The motivating case is hair. Given:

- shoulder-length, dense, coarse blonde hair;
- authoritative wetness after rain;
- a validated loose-hair presentation;
- asserted hair-to-neck contact;
- a light breeze;

the system can derive that damp clumps and neck adhesion are visible while
whole-hair lift is suppressed by water load. The narrator receives compact
structured observations and does not have to improvise the physical result
from unrelated prose attributes.

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

The narrator might realize that as “Damp strands of blonde hair cling to her
neck.” Prose is never stored in the affordance registry.

## Product outcome

This work exists to improve visual narration:

- body and garment details behave consistently across conditions;
- current forces, contact, support, and coverage produce concrete consequences;
- impossible or contradicted effects are suppressed before prompting;
- the narrator gets one or two high-value details instead of a coefficient dump;
- distinctive located features help characters remain recognizable without
  being restated every turn;
- the same structured read can later ground scene-image composition.

Success is not “more body description.” Success is fewer contradictions and
more selective, causally grounded visual detail.

The common case for every domain is silence. Static appearance still comes from
the existing appearance/impression paths; affordance cues describe a current
effect, meaningful transition, or action-relevant body relationship.

## Product boundary

This is a **visual-observation layer**, not a general physics or capability
engine.

It should answer:

- What visible state follows from these attributes and current conditions?
- What motion or deformation is actually occurring because of a current force,
  contact, pose, or committed impulse?
- What current constraint prevents a plausible visual effect?
- Which observation is relevant enough to offer the narrator now?

It should not become:

- rigid-body, fluid, or cloth simulation;
- strength, carrying, shelf-reach, passage-fit, or action-success rules;
- a behavior generator that decides what a character chooses to do;
- a second physiology, wardrobe, pose, contact, or image-generation system;
- a prompt-time vision-model call;
- a tick loop, worker, or persisted dirty-set cache.

Future action-capability consumers may reuse structural profiles through a
separate query contract. Possibility must never leak into ambient narration as
an effect that is actually happening.

## System boundaries

Keep these owners separate:

1. **Canonical attributes** own stable or slowly mutable appearance vocabulary.
2. **Physiology/body state** owns wetness, vascular signs, piloerection,
   swelling, temperature, and persistent marks.
3. **Wardrobe/presentation** owns garments, material identity, fit, support,
   binding, coverage, displacement, and structured hair arrangement.
4. **Pose/contact/space** owns current geometry, posture, contact pairs, and
   clearance facts.
5. **Events and environment** own wind, precipitation, subject motion, and
   committed impulses/exposures.
6. **Affordances** compile those reads into current physical observations and
   constraints without writing any owner state.
7. **Perception and ranking** decide what an observer can notice and whether it
   is worth a cue.
8. **Recognition memory** records which perception-safe identity details a
   specific observer has noticed; it never becomes body truth.

The [physiology stub](deferred/physiology.plan.md) owns processes such as exertion →
sweat or cold → piloerection. Affordances may consume the authoritative result,
never rederive the process.

Garments are an integration domain, not body attributes. The wardrobe/material
system remains the sole owner of their authored and persistent state.

## Architecture ruling

The shared implementation is organized by domain and compiles through named
layers:

```text
resolved canonical attributes
              ↓
typed structural profile
              ↓  + authoritative current body/presentation state
effective mechanics
              ↓  + forces, contact, pose, environment, events
domain frame
              ↓
narrow phenomenon functions
              ↓
actual observations and constraints
              ↓
perception, relevance, novelty, cue cap
              ↓
structured narrator cues
```

Individual phenomena generally do **not** receive raw values such as
`hair.density = "dense"`, and attributes do not collapse into an opaque
`hair.xyz`.

Reusable sub-calculations earn names when multiple phenomena consume them or
when they encode a stable domain invariant. Hair, for example, may derive:

- `dryBulkLoad`;
- `freeMovingFraction`;
- `exposedFreeArea`;
- `clumpStrength`;
- `retainedWater`;
- `mobilityCapacity`.

Wind-specific response remains inside the wind phenomenon. High mobility
capacity does not mean the hair is moving; actual motion still requires wind,
body motion, or an impulse.

The full contracts, domain abstraction, code layout, regional-collection
pattern, diagnostics, and architecture tests live in the
[architecture spec](body-attribute-affordances.spec.architecture.md).

Recognizable features are a read-side consumer across all domains, not another
physics phenomenon. They project stable attributes, located marks, anatomy
changes, conditions, and presentation into observer-specific candidates; see
the [recognizable-features spec](body-attribute-affordances.spec.recognizable-features.md).

## Output taxonomy

### Visual observation

An effect actually present now:

- damp hair gathered into clumps;
- loose wet strands adhering to exposed skin;
- a hem moving in current wind;
- moisture beading on skin;
- a tail pinned by the current chair and posture;
- a current eye-line or embrace alignment relevant to the action.

These may become narrator cues after perception and ranking.

### Constraint read

A current fact that suppresses or limits an effect:

- hair is bound, pinned, or covered;
- a wing is blocked by furniture or space;
- tissue motion is damped by support;
- a surface is hidden by opaque coverage.

Constraints normally remain diagnostic. Surface one only when it must prevent a
specific contradiction or explain a current action.

### Capability query

“Can she reach the shelf?”, “Can the wing shelter both people?”, and similar
questions are future consumers. They use a separate output type and never enter
the ambient visual-cue list.

Suppressed candidates and equations are diagnostics, not prose material.

## Resolution and capture

V1 is a pure current-cut read:

```text
authoritative inputs at story time
              ↓
compile relevant domain frames
              ↓
resolve phenomena
              ↓
perception-safe observations
              ↓
rank and select at most one or two cues
              ↓
capture the selected read with the committed presentation cut
```

Retakes reuse the captured read instead of resolving against later state.

The resolver performs no persistence reads or writes, creates no events, and
owns no hysteresis. Persistent aftermath such as a pressure mark, displaced
strap, or tangled hair must be explicit body/presentation state or an event
owned elsewhere.

Recompute the few relevant domains first. Dependency declarations support
validation, selective assembly, and debug explanations; they do not imply
persisted dirty sets. Fingerprint memoization is allowed only after profiling
proves it useful and the fingerprint covers every declared input.

## Reference-image boundary

Reference photographs are authoring inputs, never runtime physics inputs:

```text
reference image / manual authoring
              ↓
vision proposes canonical values
              ↓
confidence policy + validation + optional correction
              ↓
resolved AttributeValue records with provenance
              ↓
domain profile compilation
```

Raw vision prose and low-confidence guesses do not drive mechanics. Manual edits
and authoritative overlays win through the existing attribute-resolution law.

## Vocabulary prerequisites

### Hair

`hair.quality` currently entangles strand thickness, density, condition, and
surface appearance. Before it drives mechanics, split or conservatively
quarantine it in favor of orthogonal axes such as:

- `hair.strand_thickness`;
- `hair.density`;
- `hair.condition`;
- optional `hair.surface`.

The rename/removal requires the repository’s documented stored-value sweep
pattern; ambiguous old values must not silently expand into several
high-confidence facts.

Free-text `hair.style` remains display text. Runtime mechanics require validated
structured presentation such as arrangement, bound fraction, pinned fraction,
covered fraction, and loose-end length.

### Soft tissue

`breasts.fullness` mixes structural material language with live physiological
states. Promotion must separate rest geometry/material properties from current
swelling or other body state, or mark conservative mappings as provisional.

Attribute labels are descriptive vocabulary, not permission to invent precise
measurements.

## Rollout slices

### Slice 0 — vocabulary and ownership audit

- Resolve the `hair.quality` split/quarantine and stored-value sweep.
- Add validated structured hair presentation.
- Inventory authoritative wetness, coverage, contact, force, event, and cut
  seams in both chat lanes.
- Record lane adapters and prove they target one lane-neutral core.

### Slice 1 — core contracts and domain registry

- Add fixed-point, evidence, diagnostic, observation, constraint, perception,
  and registry contracts.
- Add the typed domain definition and explicit domain tuple.
- Add attribute-axis registration with ownership/reducer validation.
- No narrator consumer.

### Slice 2 — hair profile and mechanics

- Compile raw hair axes into `HairStructuralProfile`.
- Derive reusable `HairEffectiveMechanics` once per frame.
- Add fixtures and monotonic/invariant tests before phenomena.

### Slice 3 — hair phenomena

- Implement wet clumping, wind/body-motion response, skin adhesion, and droplet
  shedding over narrowed frame inputs.
- Add actual-versus-possible, fail-closed, suppression, and diagnostic tests.

### Slice 4 — production frame assembly and cut capture

- Assemble authoritative current-cut inputs through lane adapters.
- Resolve relevant domains by pure recomputation.
- Capture the selected physical/perception read with the committed cut.
- Prove retake stability and hidden-state safety.

### Slice 5 — perception, ranking, and chat narrator evaluation

- Gate by coverage, light, distance, orientation, contact, and channel.
- Rank by change, current action relevance, salience, novelty, and repeat key.
- Add a bounded cue block behind a feature flag.
- Compare contradiction rate, repetition, and concrete visual grounding against
  the current static-attribute path.

### Slice 6 — second-domain architecture proof

Implement either skin surface or garment wet-state/cling. It must reuse the
generic core without making the core hair-aware.

### Slice 7 — recognizable features and visual memory

- Project existing body truth into stable feature keys and fingerprints.
- Score current visibility, uniqueness, and importance separately.
- Track player-observer notice/mention history without a
  `recognizable_features[]` profile field.
- Prove first-notice, change-detection, hidden-feature, and anti-repetition
  fixtures before adding acquired topology.

### Slice 8 — shared visual consumers

Only after narration is stable, evaluate feeding the same captured observations
and relative-geometry reads into scene-image composition. Do not create a
second image-only physics path.

## Companion specs

- [Architecture](body-attribute-affordances.spec.architecture.md) — normative
  profile → mechanics → frame → phenomenon design and code organization.
- [Hair](body-attribute-affordances.spec.hair.md) — proving domain and
  calibration target.
- [Skin surface](body-attribute-affordances.spec.skin-surface.md) —
  authoritative body/physiology state turned into visible surface detail.
- [Garment interaction](body-attribute-affordances.spec.garment-interaction.md)
  — wardrobe-owned material profiles composed with saturation, contact, pose,
  and force.
- [Appendages](body-attribute-affordances.spec.appendages.md) — current
  constraints and actual motion for wings, tails, and horns.
- [Soft tissue](body-attribute-affordances.spec.soft-tissue.md) — reusable
  regional profiles for support, contact, and impulse-driven effects.
- [Relative geometry](body-attribute-affordances.spec.relative-geometry.md) —
  action-relevant eye-line and body blocking, not generic reach/carry rules.
- [Recognizable features](body-attribute-affordances.spec.recognizable-features.md)
  — distributed body truth projected into salience-ranked, observer-remembered
  identity cues without a duplicate feature list.

Passive thermal observations are out of scope. Visible breath belongs to
environment/perception; contact temperature belongs to physiology/body state
plus tactile perception.

## Open questions

- Hair vocabulary split, stored-value sweep, structured-presentation owner, and
  wet-darkening calibration
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions)).
- Domain-registry type erasure, lane-adapter location, and whether mechanics
  merit a developer preview
  ([architecture spec](body-attribute-affordances.spec.architecture.md#open-questions)).
- First authoritative coarse contact/pose producer and exact cut-capture seam
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions)).
- Physiology-sign contract, diverse skin-response calibration, grooming state,
  and persistent-mark owner
  ([skin spec](body-attribute-affordances.spec.skin-surface.md#open-questions)).
- Garment material vocabulary, contact owner, first phenomenon subset, and
  effective-coverage capture
  ([garment spec](body-attribute-affordances.spec.garment-interaction.md#open-questions)).
- Appendage material/flexibility vocabulary, clearance producer, concealment
  owner, and first fixture
  ([appendage spec](body-attribute-affordances.spec.appendages.md#open-questions)).
- Soft-tissue vocabulary, first regional collection, support owner, and shared
  intimate narrative-focus policy
  ([soft-tissue spec](body-attribute-affordances.spec.soft-tissue.md#open-questions)).
- Relative-stature calibration, posture/surface inputs, and first scene-image
  consumer
  ([relative-geometry spec](body-attribute-affordances.spec.relative-geometry.md#open-questions)).
- Recognizable-feature storage, fine-detail schemas, definition-vs-cast
  uniqueness, importance ownership, intimate gates, recognizable-motion scope,
  and visual-memory notice/decay/mention/RAG boundaries
  ([feature spec](body-attribute-affordances.spec.recognizable-features.md#open-questions);
  [memory detail](body-attribute-affordances.recognizable-features.memory.md#open-questions)).
- Which second domain follows hair: skin surface or garment wet state.
- How reference-image confidence becomes an accepted canonical value without
  filling uncertain mechanics axes.
