# Affordance spec draft — domain architecture

Status: draft (companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md);
promote with the plan)

## Purpose

Define the reusable calculation boundary between canonical attributes and
individual visual phenomena.

The implementation should neither pass raw enum values into every phenomenon
nor collapse a body area into one opaque score. It should compile each domain
through named, typed layers:

```text
resolved canonical attributes
              ↓
structural profile
              ↓  + authoritative presentation/body state
effective mechanics
              ↓  + current forces, contact, pose, environment, events
domain frame
              ↓
narrow phenomenon functions
              ↓
actual visual observations + constraint reads
              ↓
perception, relevance, novelty, and cue cap
              ↓
structured narrator cues
```

This is the central implementation ruling for the plan family.

## Why the intermediate layers exist

Passing raw values such as `hair.length = "shoulder_length"` and
`hair.density = "dense"` to every hair phenomenon would duplicate calibration
and let different files disagree about what “dense shoulder-length hair”
means.

Combining them once into `hair.xyz` would be no better. Wind response, wet
clumping, skin adhesion, and droplet shedding care about different physical
combinations.

Instead, compile raw vocabulary into several explicit, reusable terms:

- `dryBulkLoad`;
- `freeMovingFraction`;
- `exposedFreeArea`;
- `clumpStrength`;
- `retainedWater`;
- `mobilityCapacity`.

Each term must have one stable meaning. A phenomenon then computes only the
interaction-specific response, such as:

```text
windResponse = force × mobilityCapacity × exposedFreeArea
```

`windResponse` stays inside the wind phenomenon because it has no meaning
without current wind or motion. `mobilityCapacity` belongs in shared mechanics
because several phenomena can use it and it remains meaningful before a force
is applied.

## Layer contracts

### 1. Structural profile

A structural profile contains stable material and geometry facts compiled from
resolved canonical attributes. It does not contain current wetness, coverage,
binding, support, contact, wind, or motion.

```ts
interface DomainProfileResult<TProfile> {
  profile?: TProfile;
  evidence: readonly AffordanceEvidence[];
  diagnostics: readonly AffordanceDiagnostic[];
}
```

Rules:

- one attribute definition owns each exclusive profile path;
- shared paths use one declared reducer;
- enum labels are mapped through explicit tables, never parsed heuristically;
- unknown or quarantined values omit only the unsupported contribution;
- all mappings retain attribute/value provenance for diagnostics;
- absent required structure may suppress the domain without failing the cut.

### 2. Effective mechanics

Effective mechanics combine the structural profile with current state that
changes how the domain behaves but does not itself prove an observation.

Examples:

- hair structure + wetness + binding + coverage → effective load and free
  mobility;
- soft-tissue profile + support + physiology modifier → current supported
  mobility and compression response;
- garment construction + saturation → effective opacity and flutter load.

```ts
interface DomainMechanicsResult<TMechanics> {
  mechanics: TMechanics;
  evidence: readonly AffordanceEvidence[];
  diagnostics: readonly AffordanceDiagnostic[];
}
```

Effective mechanics describe present capacity or material condition:
`mobilityCapacity = high` means hair will respond strongly if a force exists.
It does not mean the hair is moving.

Create a named effective-mechanics field only when at least one is true:

- two or more phenomena consume it;
- it has an independently meaningful definition;
- it is useful in diagnostics or authoring preview;
- it encodes a domain invariant that must be calculated consistently.

If none applies, keep the calculation inside the phenomenon. Do not build a
pseudo-scientific object full of unused coefficients.

### 3. Domain frame

A frame assembles one subject/domain view for one committed cut. It carries the
profile and mechanics plus actual context:

```ts
interface DomainFrame<TProfile, TMechanics> {
  subjectId: CharacterId;
  storyTime: StoryTimestamp;
  profile: TProfile;
  mechanics: TMechanics;
  evidence: readonly AffordanceEvidence[];
}
```

Each concrete domain extends this with only the live inputs its phenomena may
need: presentation, asserted contacts, pose, current forces, environment, and
causal events.

The caller assembles frames from authoritative reads. Domain code performs no
persistence access and does not parse prompt text.

### 4. Phenomenon

A phenomenon consumes a narrow view of a domain frame and returns an actual
observation, a constraint, or explicit suppression.

```ts
interface AffordancePhenomenonDefinition<TFrame, TInput> {
  id: AffordancePhenomenonId;
  dependencies: readonly AffordanceDependency[];
  selectInput(frame: Readonly<TFrame>): Readonly<TInput>;
  resolve(input: Readonly<TInput>): AffordanceResolution;
}

interface RegisteredAffordancePhenomenon<TFrame> {
  id: AffordancePhenomenonId;
  dependencies: readonly AffordanceDependency[];
  resolveFrame(frame: Readonly<TFrame>): AffordanceResolution;
}
```

`defineAffordancePhenomenon(...)` type-checks the selector and resolver, then
wraps them as a `RegisteredAffordancePhenomenon<TFrame>` for the domain tuple.
Prefer `Pick<DomainFrame, ...>` input types so the resolver cannot acquire an
accidental dependency on unrelated state.

Phenomenon files own:

- force- or contact-specific calculations;
- thresholds and output bands;
- actual-versus-possible checks;
- suppression reasons;
- observation tags and affected regions.

They do not own:

- raw attribute vocabulary mapping;
- shared profile/mechanics calculations;
- final prose;
- observer perception;
- state mutation.

### 5. Perception and cue projection

Physical resolution is observer-independent. Perception filters observations
by coverage, opacity, light, distance, orientation, line of sight, contact, and
channel.

Cue projection then:

- adds descriptive metadata such as hair color without feeding it back into
  mechanics;
- ranks by current action relevance, change, salience, and novelty;
- applies `repeatKey` history and a strict one-or-two-cue cap;
- emits structured data, never stored prose.

Suppressed candidates and equations remain diagnostic only.

## Domain abstraction

Keep the generic abstraction light:

```ts
interface AffordanceDomainDefinition<
  TProfile,
  TMechanics,
  TFrame extends DomainFrame<TProfile, TMechanics>,
> {
  id: AffordanceDomainId;
  requiredAttributeIds: readonly AttributeId[];

  compileProfile(
    attributes: ResolvedAttributeSnapshot,
  ): DomainProfileResult<TProfile>;

  deriveMechanics(
    profile: TProfile,
    state: AffordanceStateSnapshot,
  ): DomainMechanicsResult<TMechanics>;

  buildFrame(
    profile: TProfile,
    mechanics: TMechanics,
    context: AffordanceResolutionContext,
  ): TFrame;

  phenomena: readonly RegisteredAffordancePhenomenon<TFrame>[];
}
```

The concrete definition helpers preserve each selector/resolver pair's input
typing even if the top-level registry stores heterogeneous domains. Do not
weaken the public surface to `any`.

A domain may intentionally omit a distinct mechanics type when no calculation
earns reuse. In that case use an empty branded record or a simpler specialized
definition rather than inventing fields.

## Attribute contribution definitions

Each executable attribute maps its own legal values into orthogonal profile
contributions:

```ts
interface AttributeAxisDefinition<
  TValue extends string,
  TContribution,
> {
  attributeId: AttributeId;
  version: number;
  ownedPaths: readonly PhysicalProfilePath[];
  values: Readonly<Partial<Record<TValue, TContribution>>>;
  provisional?: boolean;
}
```

Definition-time validation must prove:

- the attribute and mapped enum values exist;
- contributions are bounded and typed;
- exclusive paths have one owner;
- shared paths name one deterministic reducer;
- text attributes cannot drive runtime mechanics;
- provisional mappings are visible in diagnostics;
- versions never decrease.

Derived quantities are not profile contributions. For example,
`hair.length` may contribute `lengthScale` and nominal reach, while
`hair.density` contributes `bulkDensity`; `dryBulkLoad` is derived centrally in
hair mechanics.

## Regional collections

Reuse behavior across body areas by instantiating typed regional profiles, not
by creating separate physics implementations for every anatomical noun.

```ts
interface SoftTissueRegionProfile {
  locationId: BodyLocationId;
  restMassBand: UnitInterval;
  compliance: UnitInterval;
  damping: UnitInterval;
  freeMobility: UnitInterval;
}
```

A compiler may return a collection for the regions present on the realized
body:

```ts
type SoftTissueProfile = readonly SoftTissueRegionProfile[];
```

The same impulse and contact-compression phenomena then operate over each
region frame. Region-specific attributes still own their mappings, while the
shared mechanics remain consistent.

Use the same pattern for garment regions or multiple appendages only when their
mechanics genuinely align. Do not force wings, tails, and horns into one
numerical profile if a tagged union is clearer.

## Code organization

Co-locate each domain so its vocabulary mapping, reusable calculations,
phenomena, fixtures, and registration are reviewed together:

```text
src/contracts/affordances/
  core/
    types.ts
    fixed-point.ts
    evidence.ts
    perception.ts
    ranking.ts
    registry.ts
    index.ts

  domains/
    hair/
      attribute-maps/
        length.ts
        density.ts
        strand-thickness.ts
        texture.ts
        condition.ts
        index.ts
      profile.ts
      mechanics.ts
      frame.ts
      phenomena/
        wet-clumping.ts
        wind-motion.ts
        skin-adhesion.ts
        droplet-shedding.ts
        index.ts
      domain.ts
      fixtures.ts
      hair.test.ts

    skin-surface/
    garment/
    appendages/
    soft-tissue/
    relative-geometry/

  domains.ts
  derive-affordance-read.ts
  index.ts
```

Rulings:

- organize by domain, not by global `attributes/` and `phenomena/` trees;
- keep the generic core ignorant of hair, skin, garments, and anatomy names;
- use explicit registry imports, never filesystem discovery;
- keep all resolution code pure and lane-neutral;
- chat and successor callers adapt authoritative state into the same contracts
  rather than forking the physics.

## Recompute and capture

V1 recomputes the relevant domain frames for characters in the current
presentation cut. Dependency declarations exist for validation, debug
explanations, selective assembly, and possible future fingerprint memoization.
They do not create persisted dirty sets.

The selected perception-safe read is captured with the committed cut. Retakes
reuse that captured read rather than resolving against later state.

Persistent aftermath—pressure marks, displaced clothing, tangled hair—must be
authoritative body/presentation state or an event. The read layer owns no
hysteresis or hidden latches.

## Diagnostic shape

Debug output should explain the same staged calculation a developer sees in
code:

```text
hair.length=shoulder_length  → lengthScale=…
hair.density=dense           → bulkDensity=…
profile + wetness/binding    → effectiveLoad=…, freeMovingFraction=…
wind force                   → windResponse=…
threshold                    → suppressed: water_loaded
```

Diagnostics must distinguish:

- missing/unknown canonical input;
- quarantined provisional mapping;
- current constraint;
- missing actual force/contact/event;
- physically present but perception-hidden;
- valid but below narrative relevance/salience.

This makes silence explainable without leaking diagnostic detail into the
narrator prompt.

## Architecture acceptance tests

- phenomena never receive raw attribute enum values;
- identical resolved attributes produce identical structural profiles;
- profile compilation is independent of registration order;
- shared mechanics are calculated once per domain frame;
- potential/capacity never emits an actual observation without current cause;
- stronger binding/support/coverage cannot increase the effect it constrains;
- a domain can add a phenomenon without editing the generic core;
- a regional collection can add a body location without duplicating the shared
  phenomenon;
- all resolvers accept frozen inputs and perform no writes;
- missing or malformed inputs degrade to diagnostics plus conservative silence;
- chat and successor adapters produce the same read for the same normalized
  frame;
- cut capture and retake replay are byte-stable.

## Open questions

- Whether the heterogeneous domain registry needs a type-erased internal
  adapter or can remain an explicit tuple.
- Exact boundary between `src/contracts/affordances` and any lane-specific
  input adapters under `src/server`.
- Whether mechanics snapshots deserve a developer-only authoring preview after
  the hair fixture proves useful.
