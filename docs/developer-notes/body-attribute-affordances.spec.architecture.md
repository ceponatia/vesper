# Affordance spec draft — domain architecture

Status: **implemented** — companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted 2026-07-28; built as `src/contracts/affordances/core/` plus the chat
adapter and the read-only developer preview, and live in production since
2026-08-02 as the constraint-first guidance layer's read). The
§"Deferred scene-image consumer" contract below is the one part not built.

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
- projects eligible body truth into recognizable-feature candidates with
  observer-specific visibility, uniqueness, and importance
  ([recognition spec](body-attribute-affordances.spec.recognizable-features.md));
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
phenomena, fixtures, and registration are reviewed together. The proposed
tree and module-boundary rulings live in the
[code-organization companion](body-attribute-affordances.spec.code-organization.md).

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

## Deferred scene-image consumer (Slice 8 ruling, 2026-07-29)

**Decision: named follow-up; no general image consumer ships in this plan.**
The current live substrate can supply wet-hair and garment-surface facts, but
garment fit, contact, posture, support, impulse, and relative geometry are
missing one or more authoritative inputs. Recognition also lacks a production
body-exposure owner. A consumer added now would therefore establish a broad
permanent seam around a narrow and unrepresentative corpus.

The narrator trial is supporting caution, not evidence that image use must
fail: its cue arm increased specificity consistently but did not reduce
contradictions. Image composition needs its own paired evaluation because
paintable specificity may help a renderer even when it does not help prose.
That evaluation is parked as
[Body-affordance scene-image consumer](deferred.plan.md#body-affordance-scene-image-consumer).
Its stated precondition — the shared scene/body-relations owner — was met
2026-07-31, so promotion is now a scheduling decision; the reads that made it
worth waiting for still have to be wired into this layer before a broad
consumer sees them. An owner may instead schedule an earlier
wet-hair/wet-garment-only trial, which needs no new wiring.

When promoted, the consumer contract is:

- consume the structured, perception-safe result captured for the committed
  scene; never resolve against later mutable state for a delayed render or
  retake;
- select a small allowlist of paintable semantic realizers such as a wet-clump
  band or a relative eye-line relation; never expose internal scores,
  coefficients, evidence records, diagnostics, suppressed possibilities, or
  generic narrator prose;
- preserve the same cause, coverage, and perception gates as the shared read;
  unavailable input remains silence and cannot become a convenient visual
  default;
- do not apply narrator novelty, mention cooldowns, or repeat suppression—the
  image is a snapshot of the current scene—but retain a strict image-detail cap
  so observations cannot crowd out protected identity, POV, pose, wardrobe,
  or setting instructions;
- reuse the shared body/garment model and captured effective coverage; do not
  create image-only mechanics, state, inference, or a second coverage answer;
- keep recognition `visualRealizerId` optional until an allowlisted consumer
  proves that a feature needs a distinct realization beyond the existing
  canonical appearance summary.

The promotion trial uses the same committed scene, reference image, model
settings, and base render prompt in control and candidate arms, with several
rerolls per case. The first corpus covers only inputs that are authoritative in
production; fixture-only contact, fit, impulse, or geometry cannot enter it.
Review records:

1. whether the intended physical detail is visibly more correct;
2. identity, pose, wardrobe, coverage, and setting preservation;
3. invented contact or phantom-body-part regressions;
4. prompt-budget truncation and displaced protected content; and
5. consistency across rerolls.

Promotion requires a clear repeated visual gain and no new authoritative-state
or hidden-detail violations. A win ships only the tested allowlist. A non-win
records rejection for that corpus and leaves the consumer absent; it does not
authorize an image-specific body model.

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

## Resolved (owner rulings, 2026-07-28)

- **Registry**: the shipped design is approved — each domain stays strongly
  typed internally and is wrapped behind the small common
  `registerAffordanceDomain` interface so differently shaped domains share
  one list (`src/contracts/affordances/core/types.ts` /
  `core/registry.ts`). A bare explicit tuple of concrete definition types
  would become cumbersome as domains accumulate.
- **Adapter boundary**: all shared calculations stay in
  `src/contracts/affordances`. Each lane's adapter lives beside that lane's
  server code — the chat adapter under `src/server/engine` (shipped:
  `chat-affordances.ts`), the successor adapter under its simulation-engine
  area when built. Lanes adapt truth into the same contracts; calculations
  never care where truth came from.
- **Developer preview**: build a read-only preview, but not before the
  garment domain proves the architecture works twice. It shows the staged
  calculation — source inputs → structural profile → mechanics →
  observations or suppression reason → perception filtering → selected
  cue — computes on demand, and stores nothing.

## Scene/body-relations owner (ruled 2026-07-28, built 2026-07-31)

**Built, elsewhere.** The owner ruled below landed as
`src/contracts/affordances/scene/` on 2026-07-31 inside the
[romantic-contact](romantic-contact-affordances.plan.md) build (slice 3A;
contract in `romantic-contact-affordances.spec.scene.md`), wired into
`ChatScenario.scene`, and enabled in production on 2026-08-02. It delivers
posture, facing, support surfaces and their height rungs, pairwise proximity,
and the active-contact projection; **committed motion and impulse events are
the one part of the ruling it does not supply**, so impulse-dependent phenomena
stay silent.

Nothing in the affordance domains reads it yet: `chat-affordances.ts` still
omits `contacts` from every payload, so the core suppresses
`hair.strands_adhere_to_skin` and `garment.wet_cling` exactly as before. That
wiring is the open work, not the owner.

The original ruling, kept because it is the contract the wiring must satisfy: a
single small shared owner for scene/body relations, supplying

- each participant's coarse posture (standing, seated, kneeling, reclining,
  lying);
- facing/orientation and support surface;
- relative surface height (floor, chair, bed, raised platform);
- active contact links between body regions, garments, furniture, and other
  bodies;
- recent committed motion or impulse events;
- start/update/end times and provenance.

Character chat implements the first version (it remains the proving lane).
The state is scene-scoped, not one character's private attributes, because
contacts involve multiple participants; retakes restore it with the
scenario. Contact reuses the lifecycle designed in the romantic-contact
plan's contact core (explicit start/change/end); hair adhesion consumes a
simpler subset of the same normalized read. Boundary: a continuity
extractor may record already-established passive facts (hair lying across a
shoulder) but must not authorize a new voluntary or interpersonal contact —
those require the action/contact resolver. Unknown contact continues to
mean silence.

Every clause above held in the build except the impulse one. Romantic contact
consumed the owner immediately; hair adhesion, garment cling/drape, appendage
constraints, soft-tissue effects, and relative geometry are unblocked and
unwired.

## Reference-image acceptance (ruled 2026-07-28)

Confidence alone never makes a vision-model proposal canonical — human
acceptance is the final gate. Policy: below 0.70 discard or hide;
0.70–0.89 show as an unselected suggestion; 0.90+ may prefill the review
form. A value becomes canonical — and eligible to drive calculation — only
when the user accepts and saves it. Never overwrite an existing manual
value; never infer anatomy presence, absence, injury, or topology from an
image; retain provenance (model, image, confidence, acceptance).
Conflicting views lower confidence; corroborating views may raise it. This
matches the authoring philosophy: AI fills a draft, Save is the review
boundary.
