# Visual state and attention — technical spec

Status: companion to [visual-state.plan.md](visual-state.plan.md)

This spec defines the lane-neutral visual-state projection, source boundaries,
visibility and attention reads, consumer digests, memory integration, and
rollout seams.

Slices 0–2 are built (see [Implementation status](#implementation-status));
everything from slice 3 onward — every remaining adapter, flag, visibility read,
salience score and consumer digest below — is still a design rather than a
description of code. The modules it reuses are all live:

- `apps/web/src/contracts/appearance-features/` for truth-level appearance
  projection;
- `apps/web/src/contracts/affordances/recognition/` for observer-relative
  candidates, fixed-point salience, and visual memory — including the
  `ProjectedFeatureTruth` record the compatibility adapter must preserve;
- `apps/web/src/contracts/affordances/scene/` for proved posture, facing,
  proximity, support, and reach, with provenance on every fact;
- the garment graph for garment identity, parts, presentation, coverage, and
  condition;
- physical affordances for derived effects.

## Invariants
1. `VisualStateFeature` is derived, never the write target for another owner's
   fact.
2. Every feature has one source, stable key, deterministic fingerprint, typed
   kind, and evidence.
3. Unknown ownership, composition, or visibility fails closed.
4. Prose and provider prompts are consumer outputs, never source values.
5. Identity, presentation, current state, and body language stay separate.
6. Observer memory affects narration only; camera/image reads never write or
   spend mention state.
7. Salience may remove optional detail, never mandatory identity, morphology,
   wardrobe, subject count, or requested action.
8. Retakes and forks use restored committed state and restored memory.
9. Projection and ranking are pure and deterministic.
10. Reference-image extraction proposes edits and cannot directly overwrite
    canonical truth.

## Data flow
```text
authoritative owners
  → source adapters
  → VisualStateFeature[]
  → composition resolver
  → VisualStateSnapshot
  → observer/camera visibility
  → VisualAttentionCandidate[]
  → narrator digest / image digest / inspector
```
Visual memory reads keys and fingerprints before narrator selection, then
receives notice and optional mention updates only after a committed cut. Image
generation never enters that write path.

## Core vocabulary
```ts
export const visualStateLayers = [
  "identity", "presentation", "current", "body_language",
] as const;
export type VisualStateLayer = (typeof visualStateLayers)[number];

export const visualStateStabilities = [
  "inherent", "persistent", "presentation", "transient", "instantaneous",
] as const;
export type VisualStateStability =
  (typeof visualStateStabilities)[number];
```
`instantaneous` is for posture/action facts true only for one committed cut. It
never earns a long-term recognition floor.

## Loci and sources
```ts
export type VisualStateLocusRef =
  | { kind: "body"; locus: BodyLocusRef }
  | { kind: "garment_part"; garmentInstanceId: string; partId: string }
  | { kind: "item"; itemInstanceId: string }
  | { kind: "subject"; subjectId: string }
  | { kind: "relation"; relationId: string };

export type VisualStateSourceRef =
  | AppearanceSourceRef
  | { kind: "body_surface"; subjectId: string; locationId: string }
  | { kind: "body_condition"; conditionId: string }
  | { kind: "garment"; garmentInstanceId: string }
  | { kind: "garment_part"; garmentInstanceId: string; partId: string }
  | { kind: "presentation"; presentationId: string }
  | { kind: "item_locus"; itemInstanceId: string }
  | { kind: "scene_relation"; relationId: string }
  | { kind: "affordance"; observationKey: string };
```
Body paths, garment parts, and relations are registry-validated committed
identities. A free-text `other` source or locus is forbidden.

## Feature and kind contracts
```ts
export interface VisualStateFeature<TValue = unknown> {
  readonly version: 1;
  readonly key: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly layer: VisualStateLayer;
  readonly locus: VisualStateLocusRef;
  readonly sourceRef: VisualStateSourceRef;
  readonly value: TValue;
  readonly truthFingerprint: string;
  readonly semanticTags: readonly string[];
  readonly stability: VisualStateStability;
  readonly relationships: readonly VisualStateRelationship[];
  readonly priors: VisualStateAttentionPriors;
  readonly evidence: readonly AffordanceEvidence[];
  readonly changedAtMinutes?: number;
  readonly validUntilMinutes?: number;
}

export interface VisualStateKindDefinition<TValue> {
  readonly id: string;
  readonly layer: VisualStateLayer;
  readonly valueSchema: ZodType<TValue>;
  readonly allowedLoci: readonly VisualStateLocusKind[];
  readonly stability: VisualStateStability;
  readonly repeatFamily: string;
  readonly recognitionEligible: boolean;
  readonly narratorEligible: boolean;
  readonly imageEligible: boolean;
  readonly priors: VisualStateAttentionPriors;
  readonly realizerId: string;
}

export interface VisualStateAttentionPriors {
  readonly baseUniqueness: UnitInterval;
  readonly baseImportance: UnitInterval;
  readonly minimumDetailTier: AppearanceDetailTier;
  readonly mandatoryForIdentity?: boolean;
  readonly mandatoryForContinuity?: boolean;
}
```
A registered kind parses `value`; malformed or unknown values are suppressed.
`semanticTags` are validated vocabulary, not prose. The key identifies the
conceptual feature; the fingerprint identifies its current value.

Mandatory identity and continuity fields are image requirements, not salience
boosts. A common hair colour can be low-uniqueness and still mandatory.

Initial kinds adapt existing truth before adding new vocabulary: appearance
attributes and facts, anatomy, hair arrangement/wetness, garment locus and
condition, visible items, non-item presentation, supported scene relations,
and supported physical-affordance observations.

## Composition
```ts
export type VisualStateRelationship =
  | { kind: "modifies"; targetKey: string }
  | { kind: "replaces_visible_surface"; targetKey: string }
  | { kind: "covers"; targetKey: string; degree: UnitInterval }
  | { kind: "occludes"; targetKey: string; degree: UnitInterval }
  | { kind: "attached_to"; targetKey: string }
  | { kind: "derived_from"; targetKey: string };
```
Composition keeps retained features traceable instead of flattening layers into
one winner. Wetness modifies a hairstyle; a wig replaces natural hair as the
visible surface; a hat covers part of it; smudging modifies makeup; a coat
occludes a shirt; water beading derives from garment material and wetness.

Missing targets and cycles suppress the relationship with diagnostics. Covered
identity stays in the snapshot for image anchoring while observer selection
respects coverage.

## Snapshot
```ts
export interface VisualStateSnapshot {
  readonly version: 1;
  readonly scope: VisualStateScopeRef;
  readonly atMinutes: number;
  readonly cutId: string;
  readonly subjects: readonly string[];
  readonly features: readonly VisualStateFeature[];
  readonly suppressions: readonly VisualStateSuppression[];
}
```

Sort by subject, layer order, kind id, locus key, and feature key. Duplicate
keys keep the first source under a fixed adapter order and emit a diagnostic.

First-release adapter order is canonical appearance, anatomy, presentation,
wardrobe/item state, current conditions, scene relations, then derived
affordances. This only makes failure deterministic; properly designed kinds use
distinct keys and typed relationships.

## Presentation owner
Item-backed presentation stays in item and wardrobe state. A small owner is
needed only for deliberate choices that are not items.

```ts
export interface CharacterPresentationState {
  readonly version: 1;
  readonly entries: readonly PresentationEntry[];
}

export interface PresentationEntry<TValue = unknown> {
  readonly id: string;
  readonly subjectId: string;
  readonly kindId: string;
  readonly locus: VisualStateLocusRef;
  readonly value: TValue;
  readonly appliedAtMinutes: number;
  readonly sourceEventId?: string;
  readonly supersedesEntryId?: string;
}
```

Initial kinds may include hairstyle arrangement, makeup, grooming, nail finish,
and temporary cosmetic marks. Jewelry, glasses, hats, garments, prosthetic
covers, and carried objects remain item-backed.

Writes use typed operations such as apply, remove, rearrange, smudge, and
restore. Models never patch raw JSON or numeric intensity.

## Visibility
```ts
export type VisualViewpoint =
  | { kind: "observer"; observer: VisualObserverRef }
  | { kind: "camera"; cameraId: string }
  | { kind: "debug" };

export interface VisualAttentionContext {
  readonly viewpoint: VisualViewpoint;
  readonly perception: AffordancePerceptionView;
  readonly lighting: VisualLightingRead;
  readonly distance: VisualDistanceRead;
  readonly angle: VisualAngleRead;
  readonly motion: VisualMotionRead;
  readonly framing?: VisualFramingRead;
  readonly focusLoci?: ReadonlySet<string>;
  readonly actionLoci?: ReadonlySet<string>;
  readonly importanceBoosts?: Readonly<Record<string, number>>;
  readonly intimateAllowed?: boolean;
  readonly consumer: "narrator" | "image" | "inspector";
}
```

Each component read distinguishes `known`, `unknown`, and `invalid`; unknown and
invalid cannot become positive visibility.

The first release keeps the existing three detail tiers. Lighting, distance,
angle, motion, framing/pixel size, exposure, and occlusion determine the highest
available tier. Observer mode may add inspection focus and relationship-specific
importance.

## Attention and memory
```ts
export interface VisualAttentionCandidate {
  readonly feature: VisualStateFeature;
  readonly visibility: UnitInterval;
  readonly uniqueness: UnitInterval;
  readonly importance: UnitInterval;
  readonly detailTier: AppearanceDetailTier;
  readonly novelty: UnitInterval;
  readonly changeSignificance: UnitInterval;
  readonly actionRelevance: UnitInterval;
  readonly consumerRelevance: UnitInterval;
  readonly repetitionCooldown: UnitInterval;
  readonly priority: UnitInterval;
  readonly evidence: readonly AffordanceEvidence[];
}
```

The scoring shape extends the shipped recognition law:

```text
featureSalience =
  visibility × (0.55 × uniqueness + 0.45 × importance)

selectionPriority =
  featureSalience
  × max(novelty, changeSignificance, actionRelevance, consumerRelevance)
  × repetitionCooldown
```

Image consumers use a repetition cooldown of one; observer familiarity never
hides an otherwise useful optional image fact. Mandatory facts bypass optional
ranking.

The existing `VisualMemoryState` remains authoritative:

- notice may strengthen without mention;
- mention cooldown starts only after a committed cue;
- hidden or omitted features are not deleted;
- changed fingerprints become change candidates;
- only inherent and persistent features may earn a recognition floor;
- camera and inspector reads never write memory.

The current 96-row cap remains until trial evidence shows pressure.

## Consumer digests
```ts
export interface VisualNarratorDigest {
  readonly subjectId: string;
  readonly constraints: readonly VisualConstraint[];
  readonly selected: readonly VisualNarratorCue[];
  readonly suppressedCount: number;
}

export interface VisualImageDigest {
  readonly subjects: readonly VisualImageSubjectDigest[];
  readonly mandatoryFacts: readonly VisualImageFact[];
  readonly optionalFacts: readonly VisualImageFact[];
  readonly intendedMorphology: readonly VisualMorphologyFact[];
  readonly cameraFacts: readonly VisualImageFact[];
}
```

Narrator cues carry feature keys, fingerprints, semantic values, evidence, and
repeat keys, not finished literary sentences. The prompt adapter realizes
concise factual clauses.

Image facts become shared render-intent segments. Mandatory facts fit before
optional facts. Intended morphology and authored absences also feed the
negative-prompt conflict checker.

The inspector exposes the complete source-to-selection staircase without
changing state.

## Reference-image extraction
```ts
export interface VisualContractExtraction {
  readonly sourceImageId: string;
  readonly sourceHash: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
  readonly createdAt: string;
  readonly proposals: readonly VisualContractProposal[];
}

export interface VisualContractProposal {
  readonly targetOwner: "attribute" | "located_fact" | "presentation";
  readonly kindId: string;
  readonly value: unknown;
  readonly confidence: UnitInterval;
  readonly evidenceRegion?: ImageRegion;
}
```

The authoring UI shows a diff against canonical truth. Acceptance writes through
the target owner's normal command path. Re-running extraction creates a new
proposal set and preserves manual edits. Conflicting images remain review items;
confidence alone never grants overwrite.

## Persistence and capture
`VisualStateFeature[]` is normally recomputed, not persisted as truth.

Persist source-owner state, non-item presentation entries, observer memory,
lane cue state needed for repeat-safe mention accounting, render
provenance/trial manifests, and optional debug snapshots with retention.

Character chat builds from the committed pre-fan-out cut and the same rollback
anchors as state, scenario, wardrobe, perception, and memory. Successor chat
builds from one engine cut and branch version.

A render stores cut id, feature keys, fingerprints, source references, and final
digest so retry can distinguish “same composition” from “new current state.”

## Diagnostics and degraded behavior
Initial codes include kind/value/locus invalid, source unavailable, duplicate
key, missing relationship target, relationship cycle, unknown/invalid
visibility, insufficient detail tier, intimate gate, missing mandatory fact,
stale snapshot, and extraction conflict, all under `visual_state.*`.

Malformed optional features become suppression plus warning. Missing mandatory
identity or morphology makes an image profile ineligible rather than guessed.
Narration degrades to silence.

## Flags
- `CHAT_VISUAL_STATE_SHADOW` builds snapshots and diagnostics only.
- `CHAT_VISUAL_STATE_NARRATION` adds optional detail, default off.
- `IMAGE_VISUAL_STATE` enables reviewed render-intent integration.
- Reference extraction remains admin-only until review behavior is proven.

Shadow mode leaves prompts and writes byte-identical. The inspector may ignore
flags for read-only diagnostics but displays their values.

## Tests and promotion
Pure fixtures cover deterministic keys/fingerprints/order, every source adapter,
composition, visibility, observer isolation, notice-versus-mention, retakes,
camera reads without memory writes, mandatory identity surviving fitting,
unusual morphology surviving negative-conflict checks, missing-owner silence,
and extraction proposals never writing truth.

Required scenarios include natural hair versus wig, wet hairstyle, hat coverage,
smudged makeup, rolled sleeve, removed garment, wet-material effects, dim
distance, silhouette, occlusion, motion, missing digit, prosthetic, and
intentional extra appendages.

Integration fixtures prove chat rollback and successor branch isolation before
either consumer flag is enabled.

Narrator promotion uses a frozen paired trial over contradictions, repetition,
grounded specificity, naturalness, and hidden-detail leakage. Specificity alone
cannot pass.

Image promotion uses paired renders graded on identity, intended morphology,
wardrobe continuity, current-state fidelity, composition, and prompt overflow.
A showcase image cannot promote a profile.

Reference extraction promotes beyond admin only after proposal precision,
review effort, conflict behavior, and manual-edit preservation are measured.

## Implementation placement
The whole projection is application code by the workspace ownership rule
([docs/images/README.md](../images/README.md)): it translates Vesper's
characters, wardrobe, and scene state, so none of it moves into
`@vesper/image-core` (which knows nothing of characters) or
`@vesper/simulation-core` — and since those packages hold equal layer rank and
never import one another, this projection is exactly the application bridge
that reads simulated state on one side and emits render-intent facts on the
other.

Pure contracts belong under `apps/web/src/contracts/visual-state/` and may
import existing pure appearance, affordance, body, and item contracts, never
server code.

Lane adapters and source assembly belong under `apps/web/src/server/engine/` or
a focused `apps/web/src/server/visual-state/` barrel. Image realization belongs
at the shared render intent seam (`renderImageIntent` and the role-carrying
references of `@vesper/image-core`). Narrator realization belongs in the prompt
adapter.

The first implementation preserves `ProjectedFeatureTruth` as the frozen
recognition input and adapts it into `VisualStateFeature`. Later consolidation
may share internal helpers, but no rename or broad migration is required to
start.

## Implementation status

| Slice | State                              | Owns                         |
| ----- | ---------------------------------- | ---------------------------- |
| 0     | reviewed 2026-08-16                | Source + duplication audit   |
| 1     | reviewed 2026-08-16                | Contract + compat adapter    |
| 2     | built 2026-08-16 — awaiting review | Identity + presentation      |
| 3–10  | not started                        | Everything else in this spec |

Slice 0 produced [visual-state.audit.md](visual-state.audit.md). Slice 1
produced `apps/web/src/contracts/visual-state/`: vocabulary, locus, sources,
priors, relationships, kind definitions, the kind catalog, the registry,
diagnostics, the feature contract with its key/fingerprint helpers and boundary
parser, the snapshot builder with its deterministic order, and the
`ProjectedFeatureTruth` compatibility adapter. Nothing outside that folder
changed except one line adding it to the `contracts` barrel — no adapter, no
flag, no consumer, no schema.

Slices 0–1 were reviewed on 2026-08-16. Every invariant held and the compatibility
seam was confirmed preserved. The review raised four corrections, all of which
landed inside slice 2 rather than as a separate change: the feature validator did
not actually run its own wire schema, so an adapter could mint a record the
boundary parser would refuse; the canonical-JSON fingerprint decision was
unpinned, so the whole suite stayed green when the fingerprint was swapped for a
hash; the compatibility adapter's repeat-family test was tautological; and the
`garment_part` locus key could alias two different parts whose ids contain a
colon — unreachable in slice 1, reachable the moment a garment adapter exists.

Slice 2 added, in the same folder: the composition resolver and its snapshot
wiring, the non-item presentation owner with its typed operations and reducer,
adapters for species feature groups and for garment/item loci, eight new
registered kinds, a scope leaf, a suppression leaf, and four diagnostics. Still
nothing outside the folder: no adapter under `server/`, no flag, no consumer, no
schema, no persistence.

### What the audit changed about later slices

Three findings move work that this spec had assumed was simpler:

- **"Extra anatomy" is not anatomy state.** Wings, horns and tails are static
  species/heritage feature groups through `realizeBody`; `anatomyPartStateValues`
  has no `extra` member, so a character cannot gain or lose an appendage as an
  event. Slice 2 projects the species groups; slice 4's non-human fixtures read
  from there, not from anatomy.
- **Scene relations reach no narrator today.** Posture, facing, proximity and
  support already feed action validation and image camera staging, and nothing
  else. Slice 4's body-language layer is purely additive for narration.
- **Nine of thirteen current-state facts have no owner** (audit finding 14).
  Slices 3 and 4 will spend more code on explicit suppression than on
  projection, which is the intended behaviour and should not read as a gap.

### Decisions slice 1 settled

Five places where this spec left latitude or could not be implemented as
written. Each is recorded in the code that owns it.

**The source union nests appearance provenance instead of spreading it.**
§"Loci and sources" writes `VisualStateSourceRef` as `AppearanceSourceRef | { kind: "presentation"; presentationId } | …`,
which cannot be built: the appearance union already owns
`{ kind: "presentation"; itemId }` and `{ kind: "condition"; conditionKey }`, so
two arms would claim one discriminator with different shapes. Widening the
appearance union is not available — it is a frozen seam with two exhaustive
`switch`es in the recognition layer. Appearance provenance therefore rides one
`{ kind: "appearance"; ref: AppearanceSourceRef }` arm, and every new arm the
spec names keeps its own discriminator.

**A body locus produces an unprefixed key segment.** `visualStateLocusKey`
renders a body locus as exactly `bodyLocusKey(locus)` while every other locus
kind carries its kind as a prefix. That is what keeps an adapted feature key
byte-identical to `ProjectedFeatureTruth.key`, which indexes observer visual
memory rows in live conversations. The namespaces cannot collide because no
other locus kind renders bare.

**`visualStateFingerprint` is canonical JSON, not a hash.** One fingerprint form
exists across the seam, so a fingerprint compared against a stored one keeps
matching. FNV-1a is used where a hash is the right tool —
`visualStateFeaturesFingerprint`, an eight-hex-character digest over an ordered
feature list, which is what a render's provenance stores to tell "same
composition" from "the character's current state moved".

**Priors carry an optional per-feature `repeatFamily`.** The spec puts
`repeatFamily` on the kind definition only. Three adapter kinds cannot carry the
dozens of repeat families the appearance registry authors per feature kind, and
losing them would silently recalibrate the repetition cooldown slice 5 inherits,
so the field is also optional on `VisualStateAttentionPriors` and the adapter
carries the record's value through. Mandatory-for-identity and
mandatory-for-continuity go the other way: the appearance record has no such
notion, so they come from the kind and never from a guess.

**`realizerId` is optional.** No visual-realizer system exists, and the
equivalent field on the appearance kind registry is optional and unread for the
same reason. Requiring it would mean inventing ids for a system with no
consumers.

### Adapted-feature mapping, exactly

The compatibility adapter is judged on preservation. For each
`ProjectedFeatureTruth`:

- `key` and `truthFingerprint` are copied verbatim — never rebuilt.
- `kindId` comes from the source kind: `attribute` → `appearance.attribute`,
  `located_fact` → `appearance.located_fact`, `anatomy` → `appearance.anatomy`.
  `condition` and `presentation` have no visual-state kind and produce
  `visual_state.source.unavailable` plus silence, because adapting either
  through an appearance kind would file it under the identity layer.
- `layer` comes from the registered kind; `stability` carries over unchanged.
- `value` is the upstream fingerprint. The projection keeps a canonical
  fingerprint rather than the parsed source value, so there is no richer value
  to adapt and inventing one would be the second truth store the plan forbids.
- `priors` take quantities and `repeatFamily` from the record (through
  `toUnitInterval`) and mandatory flags from the kind.
- `relationships` is empty and the two change stamps are absent — composition is
  slice 2's work, and the truth-level projection carries no timestamps.

### Diagnostics declared so far

Only the codes slices 1 and 2 emit exist. From slice 1:
`visual_state.kind.unknown`, `visual_state.value.invalid`,
`visual_state.locus.invalid`, `visual_state.locus.not_allowed`,
`visual_state.feature.malformed`, `visual_state.tag.rejected`,
`visual_state.snapshot.duplicate_key`, `visual_state.source.unavailable`. From
slice 2: `visual_state.relationship.missing_target`,
`visual_state.relationship.cycle`, `visual_state.presentation.entry_unknown`,
`visual_state.presentation.operation_invalid`,
`visual_state.presentation.entry_malformed`,
`visual_state.species.feature_group_unplaced`.

Two FOREIGN codes also reach a caller's sink from this family, because the sink
is handed straight to a shared helper rather than wrapped:
`appearance.locus.unknown_location` from `validateBodyLocusRef` and
`parse.boundary_failed` from `parseOr`. That is deliberate — a reader wants the
upstream reason, not a re-labelled one — so a caller asserting on codes should
expect a namespaced pair rather than a single `visual_state.*` entry.

The visibility, detail-tier,
intimate-gate, missing-mandatory-fact, stale-snapshot and extraction-conflict
codes join with the slices that emit them; a declared but unreachable code reads
like coverage that does not exist.

### Decisions slice 2 settled

Nine places where this spec left latitude, could not be implemented as written,
or ran into a missing owner. Each is recorded in the code that owns it.

**"Signature presentation" resolved to the non-item presentation owner, and
nothing else.** Slice 2's scope line names it, and it has no owner anywhere in
the codebase: a search for `signature` finds a faerie's signature wing shape (a
species attribute rule), a signature scent (the `presentation.scent_baseline`
attribute), signature feature morphology in the avatar prompt (wings and tails
again), and the forge's advice about signature garments. Not one of them is a
structured "signature look". Two of the four are species feature groups, which
this slice projects as identity; the scent is non-visual and stays where it is;
the forge line is authoring advice. What remained — a deliberate, currently
maintained, non-item look — is exactly the owner §"Presentation owner" already
called for, so it was built as that rather than as a second concept beside it.
No separate `signature.*` kind exists, and inventing one would have produced
vocabulary with no writer and no reader.

**Kind ids.** `species.feature_group`; `wardrobe.garment` and `wardrobe.item`;
`presentation.hairstyle`, `presentation.makeup`, `presentation.grooming`,
`presentation.nail_finish`, `presentation.cosmetic_mark`. The split between the
two wardrobe kinds follows the plan's "jewelry, glasses, hats … remain
item-backed": a piece in a subtyped clothing category (jewelry, headwear,
eyewear) is `wardrobe.item` with an `item_locus` source, everything else is
`wardrobe.garment` with a `garment` source. That is what gives the spec's
`item_locus` source arm a real user, since accessories in Vesper are garment
instances like any other.

**`presentation.grooming` is not the `presentation.grooming` attribute.** The
canonical attribute is the character's habitual standard ("she keeps herself
immaculate"); the presentation kind is one area's deliberate state right now
("the beard is trimmed"), typed as `{ area, state }`. Neither derives from the
other, and the shared name is a coincidence of two owners choosing the same
English word for adjacent facts.

**Composition annotates, in a sibling of the feature list.** The resolver emits
one `VisualStateCompositionEntry` per feature — accepted edges, `modifiedBy`,
`replacedBy`, `coverage`, `occlusion`, `attachedTo`, `derivedFrom`, and an
`effectiveVisibility` of `0` when something replaces the surface and
`1 − max(coverage, occlusion)` otherwise. It lives on the snapshot beside
`features`, not on each feature: folding "a coat is over this shirt" into the
shirt's record would make the shirt's fingerprint depend on what else the
character is wearing, and change detection would start firing on the wrong
thing. `effectiveVisibility` is composition only — lighting, distance, angle,
motion and framing multiply into it in slice 4.

**A broken edge is dropped at the edge, not at the feature.** A relationship
naming a key the snapshot does not hold, one that names its own feature, and one
that closes a cycle are each suppressed with a diagnostic while the feature and
its other edges survive. Cycles are broken by a single depth-first walk in
snapshot order, so which edge of a cycle is blamed is a property of the contract
rather than of an iteration order. Composition suppressions are appended to
`VisualStateSnapshot.suppressions` after the duplicate-key ones, keyed by the
source feature and detailed as `<relationship kind>:<target key>`.

**Adapters emit edges only against features they were handed.** The wardrobe and
presentation adapters take an optional `composeAgainst` list — the features
earlier adapters produced — and assert a relationship only when the target is in
it. An adapter that cannot see its target says nothing, so the resolver's
missing-target path guards replay and hand-built input rather than firing on
ordinary projection. The species adapter takes no such list: a feature group
asserts nothing about other features.

**A garment reaches only the locations clothing can sit on, and only while it is
worn.** Coverage is the blueprint's baseline set expanded down the body tree and
then filtered by `coverageRelevant`, the same rule `items/coverage.ts`,
`garment-coverage.ts` and `items/visibility.ts` all apply. Skipping the filter is
not cosmetic: expansion reaches locations no garment covers, so a plain shirt
claimed full coverage of wings and a tail — zeroing the composed visibility of
the features this slice marks mandatory for identity — and the same stray ids
inflated the occlusion denominator by about a third. Body-surface edges are
additionally gated on the `worn` locus; a hat in a hand and a jacket on a chair
cover nothing, whatever subject the caller files them under.

**Two change stamps are conditional, for one reason.** `changedAtMinutes` answers
"when did this value last move", so it is written only when the value did.
A presentation `restore` of an entry that was never disturbed and a `rearrange`
to the arrangement already in force leave it alone; a garment stamps only for the
change kinds this slice's value reflects (`mint` and `transfer`), never for the
`presentation`, `condition`, `damage` and `repair` kinds whose facts are slice
3's. Stamping either would advance the clock against an identical fingerprint and
make an unchanged feature read as a change candidate.

**One presentation slot per (subject, locus, aspect), where the aspect carries a
discriminator.** `presentation.grooming` distinguishes four areas and
`presentation.cosmetic_mark` six marks inside the value, and the body registry
has no `brows` location — so brow grooming and facial-hair grooming both sit at
`face`. With the slot keyed on kind alone, applying the second silently deleted
the first, and a state holding both projected two features under one key for the
snapshot to drop. Those two kinds therefore project under
`presentation.grooming:brows` and supersede on the same identity; the three kinds
with nothing to discriminate keep the bare aspect. The separator needs no
escaping because every discriminator is a closed-enum member. The alternative —
adding `brows` to the body registry — was rejected on the same grounds as the
`wig` subtype: it is another owner's vocabulary.

**`supersedesEntryId` is provenance only.** `apply` deletes the entry it
supersedes, so the referent is normally already gone; the field answers "what was
here before" for an inspector and nothing walks it. The boundary parser
deliberately admits a dangling id, a self-reference, or a loop rather than
validating a graph no reader traverses.

**Recognition eligibility is not a recognition floor.** All five presentation
kinds are `recognitionEligible` while the two wardrobe kinds are not — a
hairstyle is something an observer registers, today's shirt is continuity rather
than identity. Neither can earn a long-term recognition floor regardless: all
seven are `presentation` stability, and slice 5 gates the floor on stability
(inherent and persistent only), exactly as the shipped memory law already does.

**Three relationship kinds have no slice-2 owner.**
`replaces_visible_surface` needs something that distinguishes a hairpiece from a
hat, and the wardrobe vocabulary has no `wig` subtype — adding one to
`clothingSubtypesByCategory` would have been a change to another plan's registry
for this plan's convenience. `derived_from` needs the material and wetness reads
slice 3 brings. `attached_to` DOES have an owner and is emitted — jewelry and
eyewear attach to the body feature at their anchor location rather than covering
it, because a ring does not hide a finger and the eyewear registry says as much
about glasses — but only for an accessory whose definition carries AUTHORED
coverage. The jewelry category template is `coverage: []`, and a subtype's anchor
is an editor pre-fill rather than something the mint path stores, so a piece
instantiated straight from the template is projected with its identity and locus
and asserts no edge at all. Headwear is deliberately on the covering side: a hat
covers hair, which is the plan's own worked example. The resolver implements all
six kinds regardless; the two unowned ones are exercised by hand-built fixtures.

**The garment store carries no category and no layer, so both are adapter
inputs.** A `GarmentInstanceState` deliberately does not depend on the library
row it was minted from, and clothing category and layer live on the item
definition. `VisualStateGarmentInput` therefore takes `categoryId`, `subtypeId`
and `layer` as optional caller-supplied facts. Both degrade to silence rather
than a guess: no category means the piece is treated as ordinary clothing, and
no layer means no occlusion edge at all — an invented stacking order would tell
an image compiler that a visible garment is hidden, which is the one wardrobe
error a player cannot miss. The category is trimmed and lower-cased before any
membership test, matching `clothingCategoryById`: the stored field is free text
that only the forge normalizes, so a row reading `"Jewelry"` exists and used to
flip a nose ring from an attachment to a full-degree cover. Occlusion degree is
the share of the lower piece's `coverageRelevant`-filtered baseline coverage that
the upper one also reaches; the captured effective-coverage read replaces
baseline coverage in slice 3.

**Four smaller shapes deviate from the spec as written**, all for reasons the
code states:

- `VisualStateSourceRef` gains a `species_feature` arm. Feature groups come from
  `realizeBody`, not from an attribute, a located fact, or anatomy state, and
  filing them under an existing arm would name a provenance row that was never
  written.
- `PresentationEntry` gains an optional `changedAtMinutes`. The spec's shape
  carries only `appliedAtMinutes`, and bumping that on a smudge would claim the
  makeup was reapplied; slice 5's change significance needs to know when the
  value actually moved.
- `VisualStateScopeRef` is declared locally rather than aliased to
  `VisualMemoryScopeRef`. Recognition consumes this projection from slice 5
  onward, so an import from `visual-state` into `affordances/recognition` becomes
  a circular import at exactly the wrong moment. The two unions are structurally
  identical, and the place they meet in slice 5 is a compile error if they ever
  diverge.
- `visualStateLocusKey` percent-escapes every non-body id segment. Garment part
  and instance ids may legally contain the key's own separator, and without
  escaping `{g1, "cuff:left"}` and `{"g1:cuff", left}` render one key. Body loci
  stay bare and unescaped, because they are a closed registry vocabulary and the
  byte-identical adapted key is load-bearing.
