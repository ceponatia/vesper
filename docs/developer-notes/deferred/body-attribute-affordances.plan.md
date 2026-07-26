# Body-attribute physics and visual affordances

Status: draft (stub — parked 2026-07-26, owner request; promote per
[CLAUDE.md](CLAUDE.md) before building)

## What

Build a deterministic backend layer that turns authored body attributes plus
live state into **currently valid physical and visual affordances**.

The motivating example is hair. `hair.length = shoulder_length`,
`hair.texture = wavy`, and `hair.quality = thick` are static or slow-changing
facts. Rain, wind, motion, styling, coverage, and contact are live context. The
system should combine them so it can conclude that:

- saturated, thick hair is heavy, clumped, and unlikely to lift in a light
  breeze;
- loose damp strands that reach an exposed neck may adhere to it;
- dry, fine, loose hair may lift readily in the same breeze;
- tied, pinned, braided, hooded, or otherwise constrained hair suppresses
  otherwise-valid motion;
- a strong gust may move only loose ends when the whole hairstyle is too heavy
  to "fly."

The output is not finished prose. It is a structured, perception-gated fact
such as `hair.strands_adhere_to_skin` with strength, affected regions, causes,
and suppression evidence. The narrator decides how to realize that fact in a
sentence. Image prompts and future animation systems may consume the same fact,
but this plan is about the shared backend derivation, not image generation.

This is deliberately a **domain-specific authored physics model**, not a
general rigid-body, cloth, fluid, or differential-equation engine. It should be
predictable, inspectable, cheap, and good enough to reject obvious nonsense.

## Boundary with adjacent systems

Keep four layers separate:

1. **Attributes** — structural or slowly mutable authored facts:
   `hair.length`, `hair.texture`, shoulder width, skin texture, breast size,
   body hair, and so on.
2. **Live body/presentation state** — transient facts: wetness, binding,
   coverage, temperature, dirt, sweat, pose, contact, and recent force events.
   Do not write these back into the attribute registry; the registry explicitly
   removed a `temporary` mutability tier.
3. **Affordance resolution** — pure calculations that answer what a feature can
   do or visibly is doing now, including why competing effects were suppressed.
4. **Read and realization** — observer visibility, salience, novelty, repetition
   control, then narrator phrasing.

The existing [physiology stub](physiology.plan.md) owns changes such as cold →
shivering, exertion → sweat, and arousal → blood-flow responses. This plan may
**read physiology results** as live inputs — sweat can increase skin wetness,
for example — but must not duplicate the physiological transfer functions.
Physiology changes the body state; affordances determine what that state permits
or makes observable.

Likewise, `narratorGuidance` remains a vocabulary gloss for one attribute value.
It is not executable physics and must not become a hiding place for cross-field
conditionals.

## Why it matters

Today the narrator receives mostly descriptive values and must improvise their
physical consequences. That creates contradictions across models and turns:
wet heavy hair flying in a mild breeze, covered skin visibly flushing, a loose
necklace moving through a zipped coat, or a body part reaching a location that
the current pose does not permit.

A shared affordance layer gives every consumer the same answer:

- narration can show one concrete, relevant detail instead of repeating static
  appearance;
- impossible consequences are suppressed before they reach the model;
- scene-image prompts and prose can agree about live appearance;
- future pose, animation, and interaction validation can reuse the same
  normalized material and geometry vocabulary;
- each rule can be unit-tested without judging prose quality.

The important improvement is not "more description." It is making appearance
attributes **operational**: they contribute to a bounded world model whose
current consequences can be explained.

## What already exists (evidence 2026-07-26 — re-verify at promotion)

- Attribute vocabulary is already registry-as-data. Each category has one file
  under `src/contracts/attributes/categories/`, registered centrally in
  `categories/index.ts`, with value validation derived by
  `attributes/registry.ts`.
- Every `AttributeDefinition` may name a `bodyLocationId`, giving the affordance
  layer a stable anatomical anchor rather than requiring prompt-text matching.
- Runtime attribute overlays and source provenance already separate base facts
  from changes, but transient live state intentionally does not belong in an
  attribute mutability tier.
- `narratorGuidance` already proves the project pattern of per-value authored
  metadata with definition-time validation. Affordance parameters need a
  parallel registry, not prose stuffed into that field.
- Engine spec §25 already fixes the three-layer law: substrate, resolution,
  read. It also requires pure, contextual, perception-gated reads and favors
  analytical/lazy resolution instead of minute ticks.
- The physiology stub already rules that derived live levels are never written
  back into tendency attributes and that cuts capture the body facts they were
  rendered against. The same write barrier and cut-stability rule apply here.
- Body locations, clothing coverage, conditions, recent events, and successor
  presentation cuts provide partial inputs. Exact pose/contact geometry is not
  complete enough to assume; v1 must fail closed or use explicitly coarse
  contact facts rather than hallucinating precision.

## Design principles

### 1. Attribute files contribute parameters; phenomenon files own interactions

Do not put a complete rule such as "hair flies in wind" in every contributing
attribute definition. That would duplicate wind logic across `hair.length`,
`hair.texture`, `hair.quality`, `hair.style`, wetness, and clothing coverage.

Instead use two registries:

- **Attribute-physics definitions** translate one authored attribute value into
  a partial normalized physical profile.
- **Phenomenon definitions** combine several profile components with live state
  and context to derive one class of affordances.

For example:

```text
hair.length       ─┐
hair.texture       ├─> resolved HairPhysicalProfile ─┐
hair.quality       │                                 ├─> hair wind-motion rule
hair.style tags   ─┘                                 │
hair wetness / binding / coverage / wind / motion ──┘
```

This preserves the owner's desired one-file-per-attribute authoring surface
without making each file responsible for the entire interaction graph.

### 2. Use calibrated semantic physics, not fake laboratory precision

The current attributes are semantic enums. Assigning an exact strand diameter,
mass in grams, or drag coefficient would imply scientific accuracy the data does
not have. Map values into normalized game parameters, preferably fixed-point
integers where replay determinism matters:

```ts
type UnitInterval = number; // contractually 0..10_000; 10_000 == 1.0

interface HairPhysicalProfile {
  nominalReach: readonly BodyLocationId[];
  exposedArea: UnitInterval;
  strandMass: UnitInterval;
  bulkDensity: UnitInterval;
  flexibility: UnitInterval;
  surfaceFriction: UnitInterval;
  waterLoading: UnitInterval;
  clumpAffinity: UnitInterval;
  curlRetention: UnitInterval;
}
```

The values are authored calibration knobs. Their important properties are
ordering, monotonic behavior, and stable output — not SI-unit realism.

### 3. Affordances are graded, not booleans

Most behavior should resolve to a strength plus evidence. Thresholds decide
whether a candidate is worth surfacing, but retain the underlying score for
ranking and diagnostics.

A mild breeze may produce no candidate for saturated thick hair, a low-strength
`hair.ends_shift` candidate for a stronger gust, and a high-strength
`hair.whips_across_face` candidate for dry fine hair in the same gust.

### 4. Suppression is first-class evidence

A rejected candidate should be explainable in tests and diagnostics:

```ts
{
  affordanceId: "hair.moves_in_wind",
  eligible: false,
  suppression: [
    { code: "covered", sourcePath: "presentation.hood.coverage" },
    { code: "water_loaded", contribution: 6_800 },
  ],
}
```

Do not send suppression records to the narrator. Keep them available for tests,
debugging, authoring previews, and future "why did this not happen?" tools.

### 5. Triggers invalidate; reads resolve

A trigger should usually mark affected affordances dirty, not eagerly generate
narration or persist a visible consequence. Resolution remains pure and lazy at
the story clock when a consumer asks for a read.

Persist only state with duration or hysteresis that cannot be reconstructed from
current authoritative inputs. "Hair is wet" may be stored body/presentation
state. "Wet hair can cling to skin" is a derived affordance and should not be
stored as a second truth.

## Proposed code layout

The pure shared contracts should live under `src/contracts/affordances/` so chat
and successor simulation consume one implementation from day one. Lane-specific
orchestration may live beside the existing chat/simulation surfaces, but no lane
owns a private second registry.

```text
src/contracts/affordances/
  types.ts                         # shared schemas and branded fixed-point types
  registry.ts                      # build + validate both registries
  dependency-index.ts              # reverse index from input path to phenomena
  profile.ts                       # compose partial attribute contributions
  inputs.ts                        # normalized resolution-context contract
  outputs.ts                       # candidates, suppression, narrative cues
  attributes/
    hair/
      color.ts                     # hair.color contribution, if physically relevant
      length.ts                    # hair.length -> reach / area / length band
      texture.ts                   # hair.texture -> flexibility / curl retention
      quality.ts                   # hair.quality -> provisional material contribution
      style.ts                     # structured style tags -> binding / exposure
      index.ts
    skin/
      texture.ts
      hair.ts                      # category-specific body-hair attributes as needed
      index.ts
    build/
      height.ts
      frame.ts
      musculature.ts
      weight-presentation.ts
      index.ts
    ...                            # only attributes with executable consequences
  phenomena/
    hair/
      wind-motion.ts
      body-motion.ts
      wet-clumping.ts
      skin-adhesion.ts
      droplet-shedding.ts
      index.ts
    skin/
      moisture-visibility.ts
      compression.ts
      temperature-surface.ts
      index.ts
    soft-tissue/
      gravity-and-support.ts
      compression.ts
      movement.ts
      index.ts
    index.ts
  read/
    derive-affordances.ts          # dirty-set-aware pure resolver
    perception.ts                  # coverage, distance, light, line of sight, contact
    rank.ts                        # salience / novelty / relevance / anti-tedium
    to-narrative-cues.ts           # structured cue projection, never final prose
  testing/
    fixtures.ts                    # canonical profiles, states, environments
    assertions.ts                  # monotonicity and suppression helpers
```

Names are provisional. The separation is the ruling: **one attribute file per
executable attribute; one phenomenon file per cross-input behavior**.

Do not use filesystem auto-discovery. Follow the existing explicit registry
pattern with `index.ts` imports. Missing registration must be visible in review
and test failures.

## Attribute-physics definition contract

Each per-attribute file exports one definition keyed to an existing attribute
ID. It may cover all values or only values that materially differ. The registry
validates the linkage against `attributeRegistry`.

```ts
export interface AttributePhysicsDefinition<TContribution> {
  readonly attributeId: AttributeId;
  readonly version: number;
  readonly contributesTo: readonly PhysicalProfilePath[];
  readonly values: Readonly<Record<string, TContribution>>;
  readonly defaultContribution?: TContribution;
  readonly notes?: string;
}

export function defineAttributePhysics<T>(
  definition: AttributePhysicsDefinition<T>,
): AttributePhysicsDefinition<T>;
```

Example:

```ts
export const hairLengthPhysics = defineAttributePhysics({
  attributeId: "hair.length",
  version: 1,
  contributesTo: [
    "hair.nominalReach",
    "hair.exposedArea",
    "hair.strandMass",
  ],
  values: {
    shaved: {
      nominalReach: ["hair"],
      exposedArea: 300,
      strandMass: 100,
    },
    short: {
      nominalReach: ["hair", "forehead", "ears"],
      exposedArea: 2_500,
      strandMass: 1_800,
    },
    shoulder_length: {
      nominalReach: ["hair", "face", "neck", "shoulders"],
      exposedArea: 6_000,
      strandMass: 5_000,
    },
    waist_length: {
      nominalReach: ["hair", "face", "neck", "shoulders", "back", "waist"],
      exposedArea: 9_000,
      strandMass: 9_000,
    },
  },
});
```

The exact numbers are design calibration. Tests should enforce intended order
and bounds instead of treating the example values as measurements.

### Registry invariants

At build/test time, fail loudly when:

- `attributeId` does not exist in `attributeRegistry`;
- a keyed value is not in the attribute's `allowedValues`;
- a numeric contribution is outside its declared range;
- two files write incompatible values to the same exclusive profile path;
- a phenomenon declares an unknown dependency path;
- an enum value that requires distinct physics is unintentionally uncovered;
- a free-text attribute is used as authoritative physics without a structured
  companion value or validated tag contract;
- a definition version is missing or decreases.

Partial maps are allowed. Absence means "no distinct contribution," not "guess
from the word."

## Vocabulary prerequisites revealed by the hair example

The current `hair.quality` vocabulary mixes several physical dimensions:
`fine`/`thick`/`coarse` describe strand or bulk structure, while
`dry`/`brittle`/`straw_like` describe condition, and `silky`/`glossy` describe
surface feel or appearance. One enum value cannot faithfully populate all hair
physics parameters.

Promotion should first decide whether to split this into orthogonal attributes,
for example:

- `hair.strand_thickness` — fine / medium / coarse;
- `hair.density` — sparse / average / dense / very_dense;
- `hair.condition` — healthy / dry / brittle / damaged / straw_like;
- `hair.surface` or retained presentation guidance — silky / soft / glossy.

Do not silently infer density from `thick`: users may mean thick strands, dense
hair, or both. Until the vocabulary is split, `hair.quality` physics must be
conservative and explicitly provisional.

`hair.style` is currently free text. Authoritative rules must not regex arbitrary
prose each turn. Preserve the display text, but add structured style state or
tags such as:

```ts
type HairConstraintTag =
  | "loose"
  | "partially_pinned"
  | "ponytail"
  | "braid"
  | "bun"
  | "under_hood"
  | "under_hat";
```

The authoring layer may derive candidate tags from text once and let a human or
validated forge result confirm them. Runtime physics consumes only the tags.

This is the same orthogonality rule already applied to narrator vocabulary,
now with a stricter consequence: entangled values make executable derivation
ambiguous, not merely vague.

## Normalized live input contract

Phenomenon resolvers should not query databases or parse prompts. They receive a
complete, immutable context assembled by the caller:

```ts
interface AffordanceResolutionContext {
  storyTime: StoryTimestamp;
  subjectId: CharacterId;
  profile: ResolvedPhysicalProfile;
  bodyState: {
    wetnessByLocation: ReadonlyMap<BodyLocationId, UnitInterval>;
    temperatureByLocation?: ReadonlyMap<BodyLocationId, FixedPoint>;
    contaminationByLocation?: ReadonlyMap<BodyLocationId, UnitInterval>;
    physiologySigns?: readonly PhysiologySign[];
  };
  presentationState: {
    coverageByLocation: ReadonlyMap<BodyLocationId, CoverageRead>;
    constraints: readonly PresentationConstraint[];
  };
  poseState: {
    posture: PostureRead;
    facing?: FacingRead;
    contactPairs: readonly BodyContactPair[];
    motion?: MotionRead;
  };
  environment: {
    wind?: WindRead;
    precipitation?: PrecipitationRead;
    humidity?: UnitInterval;
    gravityBand: "low" | "normal" | "high";
  };
  recentEvents: readonly AffordanceCausalEvent[];
}
```

Every optional field is fail-closed. Missing contact geometry does not license
skin adhesion. Missing wind does not imply a breeze. A coarse v1 caller may
assert `hair` ↔ `neck` contact after a pose/clothing resolver establishes that
possibility; the affordance layer must not invent the contact itself.

## Phenomenon definition contract

Each phenomenon declares all inputs that can change its answer. The registry
builds a reverse dependency index for invalidation and verifies that the
resolver is pure.

```ts
interface AffordancePhenomenonDefinition {
  readonly id: AffordancePhenomenonId;
  readonly version: number;
  readonly dependsOn: {
    attributes?: readonly AttributeId[];
    profilePaths?: readonly PhysicalProfilePath[];
    bodyStatePaths?: readonly BodyStatePath[];
    presentationPaths?: readonly PresentationStatePath[];
    posePaths?: readonly PoseStatePath[];
    environmentPaths?: readonly EnvironmentStatePath[];
    eventKinds?: readonly AffordanceCausalEventKind[];
  };
  resolve(context: AffordanceResolutionContext): AffordanceResolution;
}
```

A resolution contains zero or more candidates plus optional suppressed
candidates for diagnostics:

```ts
interface AffordanceCandidate {
  id: AffordanceId;
  subjectId: CharacterId;
  sourceLocationId: BodyLocationId;
  targetLocationId?: BodyLocationId;
  intensity: UnitInterval;
  durationKind: "standing" | "impulse" | "contact_bound";
  semanticTags: readonly string[];
  causalEventIds: readonly EventId[];
  evidence: readonly AffordanceEvidence[];
  repeatKey: string;
}
```

Do not include literary sentences in this contract. A `realizationKey` with
structured arguments is acceptable if useful for deterministic debug output or
a non-LLM fallback, for example:

```ts
{
  realizationKey: "hair.strands_cling_to",
  arguments: {
    moistureBand: "damp",
    targetLocationId: "neck",
    amountBand: "several_strands",
  },
}
```

The narrator may phrase the cue freely but may not contradict its arguments.

## Trigger and invalidation model

### Trigger classes

A phenomenon can become dirty through six classes of change:

1. **Effective attribute change** — haircut, hair damage, weight change,
   transformation, or an overlay changing an input attribute.
2. **Body-state threshold change** — wetness, sweat, temperature, dirt, swelling,
   or another authoritative state crossing a material band.
3. **Presentation change** — tying hair, putting up a hood, fastening clothing,
   removing support, or changing coverage.
4. **Pose/contact change** — turning, bending, lying down, a contact pair
   appearing/disappearing, or a body region becoming occluded.
5. **Environment change** — wind band, rain, humidity, gravity, immersion.
6. **Impulse event** — gust, jump, sudden turn, impact, shake, splash.

### Dirty-set flow

```text
state/event changes
        ↓
collect changed dependency paths
        ↓
reverse dependency index selects phenomenon IDs
        ↓
mark (subject, phenomenon) dirty
        ↓
next read resolves only dirty phenomena at the story clock
        ↓
cache candidate set by input fingerprint + registry version
```

Do not rescan every affordance for every character on every turn. Standing
context changes should invalidate only dependent phenomena. Impulse events may
resolve immediately when the presentation cut is built, but still through the
same pure resolver.

### No tick loop

Wind response, clumping eligibility, and contact adhesion are algebraic reads.
They do not need scheduled ticks. Slow live state such as drying belongs to the
body-state/physiology machinery, which may integrate analytically and schedule
material thresholds. When wetness crosses a band, it invalidates dependent
affordances.

### Hysteresis

Use separate enter/exit thresholds where a candidate would otherwise flicker
around a boundary. Example: `hair.strands_adhere_to_skin` may enter at adhesion
6,000 and remain active until it falls below 4,500. Persist only the minimal
hysteresis latch if current inputs cannot derive it; do not persist the whole
candidate as body truth.

## Hair resolution example

A first implementation can prove the architecture with four hair phenomena.
The formulas below are illustrative authored transfer functions, not scientific
claims.

### 1. Wind motion

Inputs:

- exposed area, strand mass, bulk density, flexibility;
- wetness-derived water load;
- structured style binding;
- hood/hat coverage;
- wind force and subject motion.

```ts
const effectiveMass = multiply(
  profile.hair.strandMass,
  add(UNIT, multiply(wetness, profile.hair.waterLoading)),
);

const unconstrainedMobility = divide(
  multiply(windForce, profile.hair.exposedArea, profile.hair.flexibility),
  max(effectiveMass, MIN_NONZERO),
);

const mobility = multiply(
  unconstrainedMobility,
  invert(bindingStrength),
  invert(coverageStrength),
);
```

Candidate bands may be:

- below threshold — no visible motion cue;
- low — loose ends or short flyaways stir;
- medium — strands lift or sweep across a region;
- high — hair whips, streams, or repeatedly crosses the face.

Wetness generally increases effective mass and clumping, so it must not increase
whole-hair mobility. A violent impulse may still produce an ends-only candidate.

### 2. Wet clumping

Inputs: wetness, strand/surface parameters, curl retention, contamination,
recent rain/immersion event.

Output: clump amount, apparent darkening eligibility, strand separation, and
possible droplet retention. Hair color remains an appearance fact; the rule may
say "wet-darkened relative to base" without inventing a new color attribute.

### 3. Skin adhesion

Hard requirements:

- clumping above threshold;
- hair's nominal reach includes the target body location;
- an asserted current hair↔skin contact pair exists;
- neither source nor target is blocked by clothing;
- sufficient hair or skin surface wetness.

The target location comes from the contact resolver, not from hair length alone.
Shoulder-length hair makes neck contact possible; it does not prove contact in
the current pose.

### 4. Droplet shedding

Requires retained water plus an impulse such as a head turn, run, shake, impact,
or strong gust. It emits an impulse candidate and may request an authoritative
body-state delta only through the owning wetness system. The affordance resolver
must not secretly drain wetness as a side effect.

### Worked cases

**Case A — dry, fine, shoulder-length, loose hair; uncovered; moderate wind**

- high exposed area + flexibility;
- low water load and binding;
- `hair.strands_lift_in_wind` eligible at medium/high strength;
- no skin-adhesion candidate without wetness and contact.

**Case B — saturated, dense/coarse shoulder-length hair; uncovered; light wind;
hair touching exposed neck**

- water load and density suppress whole-hair wind motion;
- wet clumping is high;
- skin adhesion is eligible;
- resulting cue can carry the cause `recent_exposure: rain`.

**Case C — same as B, but braided under a hood**

- binding + coverage suppress wind motion;
- coverage/contact rules suppress visible neck adhesion;
- no hair cue is emitted merely because the static attributes would allow one.

**Case D — damp, thick hair; strong sudden gust; loose ends exposed below hood**

- whole-hair motion remains suppressed;
- an ends-only impulse candidate may pass at low strength;
- the narrator may say the ends stir, not that all her hair flies.

## Perception, salience, and narrator handoff

Affordance resolution answers what is physically valid. A separate read layer
answers what this observer can perceive and what is worth mentioning.

Perception filters should consider:

- region coverage and opacity;
- distance, lighting, orientation, and line of sight;
- whether the effect is visible, audible, tactile, or only privately felt;
- observer familiarity and whether the detail is newly changed;
- current narrative focus and action relevance.

The final narrator payload should be compact:

```ts
interface NarrativeAffordanceCue {
  cueId: string;
  subjectId: CharacterId;
  affordanceId: AffordanceId;
  sourceLocationId: BodyLocationId;
  targetLocationId?: BodyLocationId;
  intensityBand: "subtle" | "clear" | "strong";
  semanticTags: readonly string[];
  cause?: CausalRead;
  novelty: UnitInterval;
  salience: UnitInterval;
  repeatKey: string;
  realization?: {
    key: string;
    arguments: Readonly<Record<string, string>>;
  };
}
```

Example handoff:

```ts
{
  affordanceId: "hair.strands_adhere_to_skin",
  sourceLocationId: "hair",
  targetLocationId: "neck",
  intensityBand: "clear",
  semanticTags: ["damp", "clumped", "several_strands"],
  cause: { kind: "recent_rain_exposure", endedMinutesAgo: 2 },
  realization: {
    key: "hair.strands_cling_to",
    arguments: {
      color: "blonde",
      moistureBand: "damp",
      target: "neck",
    },
  },
}
```

That is enough for prose such as "Damp strands of blonde hair cling to her neck
after the walk through the rain" without asking the LLM to derive the physics.

The narrator contract should instruct it to:

- use at most one or two high-salience cues in a beat;
- integrate cues into current action instead of listing attributes;
- prefer changes, movement, contact, contrast, and action-relevant details;
- never strengthen a cue beyond its supplied intensity or target region;
- never invent a suppressed consequence;
- avoid repeating the same `repeatKey` until novelty recovers.

Capture the selected cues — or the complete perception-filtered affordance read
from which they were selected — in the committed cut's presentation context.
A retake must render against the same body observation, not recompute against a
later live clock or changed registry.

## State ownership and write barriers

The affordance layer is read-only. Its pure resolver must not:

- modify attributes;
- change wetness, temperature, coverage, pose, or contact;
- create conditions;
- emit body events;
- write narration;
- query persistence.

When a phenomenon implies a real state transition — a droplet leaves hair, a
strap slips, a fragile nail breaks — the owning command/event resolver must
explicitly decide and record that event. The affordance layer may expose a
**possible action/outcome** or a requested effect proposal, but it cannot mutate
substrate while resolving a read.

This keeps the engine's substrate/resolution/read boundary intact and prevents a
read operation from changing replay truth.

## Versioning and replay

Both registries need explicit versions:

```ts
interface AffordanceRegistryIdentity {
  attributePhysicsVersion: string;
  phenomenonVersion: string;
}
```

Registry tuning is code/data versioning, not a database migration. However:

- committed cuts capture the selected/read affordances for retake stability;
- debug records include the registry identity and input fingerprint;
- deterministic tests pin registry versions;
- a future persisted hysteresis latch stores the version that produced it;
- changing a mapping must not reinterpret historical committed prose as if it
  had been derived under the new version.

The system need not retain executable copies of every old registry if committed
presentation context contains the relevant read. If future game mechanics make
an affordance causally authoritative, that outcome must be an event and follow
the engine's normal upcasting/version rules.

## Performance model

- Build the reverse dependency index once per registry version.
- Resolve per subject, not globally.
- Cache the composed physical profile until effective attributes change.
- Cache standing phenomenon outputs by an input fingerprint.
- Resolve impulse phenomena only for matching recent event kinds.
- Rank and cap cues before prompt construction; never dump every valid
  affordance into the narrator context.
- Avoid database access and LLM calls in all registry/profile/phenomenon code.
- Do not add a background worker or per-minute tick.

The likely hot path is one profile composition plus a small dirty phenomenon set
for the characters in the current cut, not `characters × all rules`.

## Testing strategy

### Registry and mapping tests

- every attribute-physics ID exists;
- every mapped enum key is legal;
- fixed-point parameters remain in range;
- explicit registration contains every definition exactly once;
- dependency paths and realization keys are known;
- provisional mappings are marked and cannot silently become authoritative.

### Per-attribute tests

Each attribute file owns table tests for its mapping and ordering. Examples:

- longer hair never has a smaller nominal reach than an adjacent shorter band;
- higher density never lowers dry effective mass;
- stronger binding never increases exposed free area;
- adding coverage never increases visibility.

### Phenomenon matrix tests

Use compact pairwise matrices rather than exhaustively enumerating every
attribute combination. Include boundary cases and owner examples:

- dry/fine/loose vs wet/dense/loose under the same wind;
- wet/dense/loose vs wet/dense/braided;
- reachable target with no contact vs asserted contact;
- contact under opaque coverage vs exposed contact;
- light wind vs severe impulse with ends-only movement.

### Property tests

- determinism: same context + registry version → byte-identical resolution;
- purity: resolver cannot mutate the frozen input;
- monotonic suppression: increasing wetness beyond the loading band cannot
  increase whole-hair wind mobility;
- partition invariance where state integration is involved: integrating live
  wetness before resolution in pieces or at once gives the same input/read;
- bounds: extreme authored inputs cannot produce values outside 0..10,000;
- fail-closed missing data: absent pose/contact/coverage never licenses a more
  specific effect;
- no hidden-state leakage through perception-gated reads;
- retake stability from captured presentation context;
- cache invalidation: every declared dependency change dirties the right rules,
  and unrelated changes do not.

### Narrative integration tests

Test structured cue inclusion and exclusion, not exact creative prose:

- the rain case includes one neck-adhesion cue with `blonde`, `damp`, and rain
  cause arguments;
- the wet-thick-light-wind case does not include a flying-hair cue;
- a suppressed or unperceivable candidate never reaches the prompt;
- repeated `repeatKey`s are capped;
- no cues means byte-identical prompt behavior outside the new block.

A small deterministic template renderer may make debug snapshots readable, but
its wording is not the production narrator contract.

## Observability and authoring tools

Before broad rollout, add a development-only explanation view or serialized
diagnostic record:

```text
hair.moves_in_wind: suppressed
  + wind force: 0.42
  + exposed area: 0.61
  - water loading: 0.68
  - braid binding: 0.80
  = final mobility: 0.09 (threshold 0.22)

hair.strands_adhere_to_skin: eligible
  + wet clumping: 0.81
  + asserted contact: hair -> neck
  + neck exposed: yes
  = intensity: 0.74
```

This is essential for tuning authored coefficients without guessing from model
output. It also gives the character editor a future preview: change a hair value
and see which material tendencies it affects.

## Rollout and compatibility

Chat should be the first consumer because it provides the fastest qualitative
feedback, but the contracts and pure derivation are shared from the first slice.
Do not replace existing attribute rendering wholesale. Add a bounded
`visualAffordanceCues` block beside the current appearance/state context and
preserve the old route behind a feature flag until the cue path is evaluated.

Static attributes remain available for introductions, deliberate inspection,
and identity anchoring. Affordances do not eliminate descriptions; they stop the
narrator from treating static descriptors as unconditional behavior.

## Open questions

- **Hair vocabulary split.** Which orthogonal hair fields should replace or
  supplement `hair.quality`, and how are existing stored values swept?
- **Structured style ownership.** Is a style-tag set another attribute, wardrobe
  state, or a dedicated presentation-state contract? The free-text display name
  can remain, but it cannot be authoritative physics.
- **Profile path granularity.** One generic material profile is tempting, but
  hair, skin, soft tissue, horn, wing, and clothing behavior may need typed
  subprofiles to avoid a meaningless universal coefficient soup.
- **Geometry source.** What is the first authoritative producer of coarse
  contact pairs and reach/coverage facts before a full pose system exists?
- **Hysteresis storage.** Can v1 avoid all latches by using current state plus
  event history, or do a few effects require minimal persisted activation?
- **Narrative cause window.** How long after rain should "after the walk through
  the rain" remain an eligible causal explanation, and which system owns that
  recency policy?
- **Color changes.** Should wet-darkening be a semantic effect only, or should
  color attributes expose calibrated lightness metadata for consumers?
- **Physiology interface.** Should affordances consume raw perception-safe
  physiology signs or a lower-level body-state projection such as skin wetness
  and surface temperature?
- **Authoring calibration.** Which values require human-authored coefficients,
  and where can monotonic defaults be derived safely from ordered enum scales?
- **Scope.** After hair proves the system, which body domains produce enough
  narrative value to justify simulation next: skin moisture/flush visibility,
  body hair, soft-tissue support/compression, wings/tails, or clothing? Each
  candidate now has a draft spec sketching its shape (see
  `## Companion spec drafts`); the question is ordering, not shape.

## Proposed slices

### Slice 0 — vocabulary and dependency audit

- Re-verify attribute, body-location, coverage, condition, and cut contracts.
- Decide the `hair.quality` split or document a conservative provisional map.
- Add structured hair-style constraint tags; do not parse free text at runtime.
- Inventory authoritative live inputs already available vs missing.
- Record the exact chat and successor presentation seams that will consume cues.

### Slice 1 — shared contracts and registries

- Add fixed-point/profile/input/output schemas.
- Add `defineAttributePhysics`, explicit per-attribute registration, and
  registry invariants.
- Add phenomenon definition + dependency-index contracts.
- Implement profile composition with provenance and diagnostics.
- No narrator consumer and no live-state writes.

### Slice 2 — hair proof with static fixtures

- Author `hair.length`, `hair.texture`, split quality/density fields, and style
  constraint contributions.
- Implement wind motion, wet clumping, skin adhesion, and droplet-shedding
  phenomena as pure functions.
- Land mapping, matrix, property, and suppression-explanation tests.
- Use fixture contexts only; no production route yet.

### Slice 3 — live input assembly and dirty resolution

- Assemble normalized context from resolved attributes, body/presentation state,
  coarse contact/coverage, environment, and recent events.
- Build dirty-set invalidation and per-subject caches.
- Integrate at the story clock; no tick worker.
- Add deterministic diagnostics and cache-invalidation tests.

### Slice 4 — perception, ranking, and cut capture

- Gate candidates by observer perception.
- Add salience, novelty, relevance, repeat keys, and a strict cue cap.
- Project to `NarrativeAffordanceCue`.
- Capture the selected/read cues in committed presentation context.
- Prove retake stability and hidden-state non-leakage.

### Slice 5 — chat narrator integration and evaluation

- Add the bounded cue block behind a feature flag.
- Instruct the narrator to realize supplied effects without inventing or
  strengthening consequences.
- Add the wet-thick-hair suppression fixtures and rain/neck adhesion fixtures to
  deterministic narration tests.
- Compare repetition, contradiction rate, and sensory detail against the current
  static-attribute prompt path before making it default.

### Slice 6 — second-domain proof and shared-consumer adoption

- Choose one materially different domain, preferably skin moisture/coverage or
  soft-tissue support/compression, to prove the architecture is not hair-shaped.
- Reuse the same affordance read in successor presentation and scene-image state
  prompts.
- Keep all consumer-specific wording outside the shared resolver.

## Companion spec drafts

This plan fans out into per-domain specs (drafted 2026-07-26, all
`Status: draft`, parked beside this stub). Each targets one focused area; the
shared contracts above are the law they all follow. Promotion turns this stub
into a real plan and freezes — per adopted domain — the profile vocabulary,
fixed-point rules, registry invariants, input ownership, cue contract, and
first formulas in the matching spec before implementation. Hair promotes
first; other domains promote only when scheduled (see the Scope open
question).

- [body-attribute-affordances.spec.hair.md](body-attribute-affordances.spec.hair.md)
  — the proving domain; landing spec for the worked design this plan carries
  (wind motion, wet clumping, skin adhesion, droplet shedding).
- [body-attribute-affordances.spec.skin-surface.md](body-attribute-affordances.spec.skin-surface.md)
  — moisture sheen, flush/pallor visibility vs skin tone, goosebumps,
  compression marks (the hysteresis flagship), contamination.
- [body-attribute-affordances.spec.soft-tissue.md](body-attribute-affordances.spec.soft-tissue.md)
  — gravity/support state, impulse motion response, contact compression for
  breasts/buttocks/soft mass; strictest anti-tedium discipline.
- [body-attribute-affordances.spec.appendages.md](body-attribute-affordances.spec.appendages.md)
  — wings/tail/horns capability-and-constraint reads, clearance vs space,
  wet wing loading, offered-action shelter.
- [body-attribute-affordances.spec.stature-reach.md](body-attribute-affordances.spec.stature-reach.md)
  — pairwise height-differential geometry (kiss/embrace/eye-line), reach
  envelopes, passage fit, strength-capability offers.
- [body-attribute-affordances.spec.garment-interaction.md](body-attribute-affordances.spec.garment-interaction.md)
  — wet cling/translucency, wind response, drape; carries the
  derived-coverage layering question and a presentation-ownership caveat.
- [body-attribute-affordances.spec.thermal.md](body-attribute-affordances.spec.thermal.md)
  — visible breath, touch temperature, radiated warmth; the attribute-light
  stress test of the phenomenon registry.
