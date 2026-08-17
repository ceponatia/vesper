# Visual state and attention — technical spec

Status: companion to [visual-state.plan.md](visual-state.plan.md)

This spec defines the lane-neutral visual-state projection, source boundaries,
visibility and attention reads, consumer digests, memory integration, and
rollout seams.

Slices 0–6, 8 and 9 are built (see
[Implementation status](#implementation-status)); the remaining slices — the
narrator proving release (7) and the final consolidation (10) — are still a
design rather than a description of code. The modules the spec reuses are all
live:

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
invalid cannot become positive visibility. A single unusable component fails the
whole feature list closed.

The first release keeps the existing three detail tiers. Lighting, distance,
angle, motion, framing/pixel size, exposure, and occlusion determine the highest
available tier. Observer mode may add inspection focus and relationship-specific
importance.

### Declared reads

A `known` read carries an optional `declared: true`. It resolves like any other
known read — a declared default is a real assertion — and it is fingerprinted,
evidenced, diagnosed (`visual_state.visibility.declared_default`, info) and
surfaced in the inspector payload separately, so a graded trial can always
separate a grounded read from stated policy. `visualComponentDeclared` is the
only way to mint one; an unmarked default remains forbidden.

`viewing.ts` resolves a narrator viewpoint's four components:

| Component | Source                                                    |
| --------- | --------------------------------------------------------- |
| distance  | scene proximity for the pair; declared `close` if unstated |
| angle     | scene facing, subject → observer; declared `toward`        |
| lighting  | always declared `bright` — no owner exists                 |
| motion    | always declared `still` — no owner exists                  |

`SceneProximityBand` IS `VisualDistanceBand` and `SceneFacing` IS
`VisualAngleBand`, so both are lookups rather than mappings. The scene answers
only to its own participant ids, so the lane assembly inverts
`subjectsByParticipant` before asking. `silhouette` stays camera-only: it
describes a viewpoint's relationship to a light source, not an ambient fact.

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
  readonly repeatKey: string;
  readonly noveltySource: "memory" | "cue" | "none";
  readonly cueStatus?: VisualCueVisibilityStatus;
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

### The narrator cue state

`VisualCueState` (`visual-state/cue-state.ts`) answers repetition and first
visibility for the families observer memory refuses — every kind that is
`recognitionEligible: false`, or whose stability the floor law will not hold.
The two records are **disjoint**: `isMemoryEligible` decides which answers for a
feature, so one cue can never spend both.

```ts
export interface VisualCueState {
  readonly sequence: number;
  readonly cues: Readonly<Record<string, VisualCueRecord>>;
}

export interface VisualCueRecord {
  readonly repeatKey: string;
  readonly visibleFingerprint: string;
  readonly firstVisibleAtMinutes: number;
  readonly lastVisibleAtMinutes: number;
  readonly lastVisibleSequence: number;
  readonly lastMentionedAtMinutes?: number;
  readonly mentionCount: number;
}
```

Keyed by repeat key, not feature key: both questions are questions about the
family, and `visualAttentionRepeatKey` already renders the locus into the key.
`visibleFingerprint` is `visualCueFamilyFingerprint` over every visible member,
sorted by feature key — so it tracks the family's truth, not emission order.

`visualCueVisibilityStatus` compares the record against `state.sequence`:

| Status          | Meaning                                          | Cue reason      |
| --------------- | ------------------------------------------------ | --------------- |
| `first_visible` | no record — never in view for this observer       | `newly_visible` |
| `changed`       | the family fingerprint moved                      | `change`        |
| `revealed`      | in view now, not in view at the immediately prior cut | `newly_visible` |
| `steady`        | continuous, unchanged view                        | none            |

**Cuts, not minutes.** "Newly visible" is a question about cuts; chat turns
advance the story clock by wildly varying amounts, so any minute threshold would
call a continuously visible sleeve newly revealed after a long gap and miss a
coat that came off and back on inside an hour. `sequence` counts recorded cuts.

`visualNarratorCueReasons` is `recognitionCueReasons` plus `newly_visible`, and
it is a separate vocabulary: the recognition lane cannot produce that reason, and
a shared vocabulary carrying a member one of its producers can never emit lies to
its consumers. `visualNarratorCueReasonIsRecognition` narrows back at the
mention-ledger boundary. An owner's change stamp outranks the cue state in
`visualNarratorCueReason`, so a fresh change is not reported as a first sighting
on the cut where no family has a record yet.

Transitions mirror notice-versus-mention exactly. `observeVisualCues` records
what was in view and advances the counter once per selection, said or not;
`applyVisualCueMentions` (via `commitVisualNarratorCueMentions`) starts the
cooldown only for cues that entered the cut. Both come back as plain data. A
failed-closed selection records nothing and does not advance the counter.

The 96-row cap and its coldest-first, key-ordered eviction mirror the memory
cap, with `lastVisibleSequence` as the age policy.

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

The chat lane's cue state lives in `chat_visual_cues` — its own table, not a
column on `chat_visual_memory`. The design reason is that the two records are
disjoint and must stay so; the mechanical reason is the generation shuffle,
which decides what to keep by comparing the stored `applied_message_id` with the
incoming one, so two upserts against one row inside one exchange would leave the
second seeing a guard the first had already stamped. Key, columns, and retake
law are otherwise `chat_visual_memory`'s, and `visualMemoryGenerationFor` is
imported rather than restated so the two stores cannot disagree about what a
retake is. The counter is why this matters more here: a retake that advanced it
twice would make every tracked family read as newly revealed on the next cut.

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
- **Visual-state narration is a PER-CHAT column, not an env flag**
  (`character_chats.visual_state_narration`, default false; owner ruling
  2026-08-17). On, the narrator receives the two blocks and the conversation's
  cue state is committed with each exchange. It is operational configuration:
  it does not ride `ChatScenario`, so a retake never moves it, and it has its
  own owner-scoped route rather than a field on the chat-state PATCH.
- `IMAGE_VISUAL_STATE` enables reviewed render-intent integration.
- Reference extraction remains admin-only until review behavior is proven.

Shadow mode leaves prompts and writes byte-identical. The cue state is READ on
both arms — ranking against stored repetition is a read, so the shadow measures
real repeat and newly-revealed counts — and WRITTEN only when the chat's switch
is on. That is why the narration arm runs the build on the turn's own path
rather than deferring it: a deferred build cannot be captured with the cut it
describes, and a cue advance for an exchange that never landed is exactly the
impurity the two-generation store exists to prevent.

The inspector may ignore flags for read-only diagnostics but displays their
values.

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
| 2     | reviewed 2026-08-16                | Identity + presentation      |
| 3     | built 2026-08-16 — awaiting review | Current state                |
| 4     | built 2026-08-16 — awaiting review | Body language + visibility   |
| 5     | built 2026-08-16 — awaiting review | Attention + memory           |
| 6     | built 2026-08-16 — awaiting review | Shadow + inspector           |
| 7     | complete — 2026-08-17              | Narrator proving release     |
| 8     | built 2026-08-16 — awaiting review | Image digest + seam          |
| 9     | built 2026-08-16 — awaiting review | Reference extraction         |
| 10    | not started                        | Narrator consolidation       |

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

Slice 3 added, in the same folder: adapters for body-surface wetness, garment
current state (condition channels, per-part overrides, structural presentation,
deposits, damage, derived wet-material effects), active conditions, and
supported affordance observations; the standing unsupported-fact suppression
table for the ownerless physiology/contamination/contact/fit facts; eight new
registered kinds; and both slice-2 debts — `derived_from` gained its material
reads, and the wardrobe adapter's cover/occlusion sets now come from
`garmentEffectiveCoverage`, with an optional captured effective-opacity input
scaling `covers` degrees. Adapter suppressions ride a new optional
`VisualStateContribution.suppressions`, appended ahead of duplicate-key and
composition entries. Still nothing outside the folder: no server adapter, no
flag, no consumer, no schema, no persistence.

Slice 4 added, in the same folder: the body-language adapter over `SceneState`
and its housed contact lifecycle (posture, support, facing, hand occupation,
committed motion — five new kinds, all `body_language` layer, instantaneous,
recognition-ineligible, none mandatory); and the visibility read —
`VisualViewpoint`, per-component known/unknown/invalid reads for lighting,
distance, angle, motion and framing with calibration tables,
`resolveVisualStateVisibility` multiplying into composition's
`effectiveVisibility`, detail tiers, and suppression-based gating. The source
union gained a `{ kind: "contact", contactId }` arm. Non-human (wings) and
altered-anatomy (missing finger) fixtures exercise silhouette and detail-tier
behavior. Same footprint as every slice so far: nothing outside the folder.

Slice 5 is the one deviation from that footprint: its modules live in
`apps/web/src/contracts/affordances/recognition/` (`visual-attention.ts`,
`visual-selection.ts`), not the visual-state folder, because slices 1 and 4
recorded the import direction — recognition consumes the projection, and the
reverse import is the cycle they dodged. Nothing under
`contracts/visual-state/` changed. `visual-memory.ts` gained the sanctioned
eligible-sources widening: `RecognitionNotice.candidate` now accepts a
`RecognitionNoticeSource` (the seven fields the row math reads), which
`RecognizableFeatureCandidate` satisfies structurally with zero callers
changed. The attention context extends slice 4's visibility context; narrator
and image selections are separate functions, and the image selection is
structurally memoryless — no memory parameter exists to misuse.

Slice 6 added the first server code of the plan:
`apps/web/src/server/visual-state/` (assembly of one snapshot over a committed
cut with adapters in canonical order, consumer selections, measurements,
fenced shadow, inspector preview payload), the character-chat and successor
shadow hooks (flag `CHAT_VISUAL_STATE_SHADOW`, default off; fenced, private
diagnostics collector, read-only memory load, nothing returned to the turn),
and the both-lane read-only inspector route and panel. Measurements — feature
counts by layer, suppressions by code, missing-owner and duplicate-key counts,
and disagreement with the legacy attribute and garment summaries — surface as
one structured log line per shadowed turn and in the inspector payload; no
table was added.

Slice 8 (built out of order, ahead of slices 6–7) added
`apps/web/src/contracts/images/visual-digest.ts`: the `VisualImageDigest`
realization over a snapshot, camera context and `VisualImageSelection`;
typed camera facts and the scene-camera mapping; the segment-kind seam onto
`@vesper/image-core`'s prompt-segment vocabulary; and the compact
`VisualImageProvenance` record. It ships dark — no route, flag or server
consumer — and the image-lane consolidation plan owns cutting routes over.

Slice 9 added the reference-image extraction workflow: the pure proposal
boundary, slot identity, diffing, reconciliation, review transitions and
apply planning in `contracts/visual-state/extraction.ts`; the
`server/reference-extraction/` barrel (register / list / decide / apply);
two admin-only routes; and migration `0111` with the
`visual_reference_extractions` and `visual_reference_proposals` tables. Only
the API surface exists — the review UI is future work — and the whole
surface is dark and admin-gated.

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

Only the codes the shipped slices actually emit exist. From slice 1:
`visual_state.kind.unknown`, `visual_state.value.invalid`,
`visual_state.locus.invalid`, `visual_state.locus.not_allowed`,
`visual_state.feature.malformed`, `visual_state.tag.rejected`,
`visual_state.snapshot.duplicate_key`, `visual_state.source.unavailable`. From
slice 2: `visual_state.relationship.missing_target`,
`visual_state.relationship.cycle`, `visual_state.presentation.entry_unknown`,
`visual_state.presentation.operation_invalid`,
`visual_state.presentation.entry_malformed`,
`visual_state.species.feature_group_unplaced`. From slice 3:
`visual_state.source.invalid` for a quarantined or malformed source entry —
plus a deliberate reuse: the standing unsupported-fact table emits
`visual_state.source.unavailable` at **info** severity, because a permanent
designed absence is context rather than a degradation alarm (the code is still
asserted by tests). From slice 4:
`visual_state.body_language.unavailable`, `visual_state.visibility.unknown`,
`visual_state.visibility.invalid`, `visual_state.visibility.hidden`,
`visual_state.visibility.channel_unavailable`,
`visual_state.visibility.out_of_frame`,
`visual_state.detail_tier.insufficient`, and `visual_state.intimate.gated`.
From slice 5: `visual_state.attention.boost_invalid` (candidate builder),
`visual_state.selection.context_mismatch` and
`visual_state.selection.budget_invalid` (both selections),
`visual_state.selection.scope_mismatch` and
`visual_state.selection.key_unbrandable` (narrator selection) — plus a reuse:
the image mandatory lane emits `visual_state.intimate.gated` with a
`mandatory:<group>` detail, and `visual_state.kind.unknown` guards both the
builder and that lane. From slice 8 (all emitted only by `visual-digest.ts`):
`visual_state.digest.mandatory_missing` (a priors-mandatory fact the mandatory
lane lost to degradation — the digest is still returned, and per-subject
`missingMandatory` keys carry the profile-eligibility signal; consent-gated
and image-ineligible absences are excused as designed),
`visual_state.digest.snapshot_stale` (`forCutId` differs from the snapshot's
cut; the whole digest fails closed), and
`visual_state.digest.selection_mismatch` (a selection naming foreign subjects
or keys; fails closed) — the missing-mandatory and stale codes slice 5 left to
this slice's profile-eligibility decision, now declared with live emitters.
From slice 6: `visual_state.shadow.failed` (a fenced shadow assembly threw;
the turn is unaffected). From slice 9:
`visual_state.extraction.proposal_invalid` (boundary and apply-plan
revalidation), `visual_state.extraction.conflict` (the reserved conflict
code, with reasons `reviewed_value_differs` and `canonical_moved`), and
`visual_state.extraction.owner_unavailable` (an accepted proposal whose
target lane has no persisted canonical owner).

Two FOREIGN codes also reach a caller's sink from this family, because the sink
is handed straight to a shared helper rather than wrapped:
`appearance.locus.unknown_location` from `validateBodyLocusRef` and
`parse.boundary_failed` from `parseOr`. That is deliberate — a reader wants the
upstream reason, not a re-labelled one — so a caller asserting on codes should
expect a namespaced pair rather than a single `visual_state.*` entry.

Every reserved code family now has a live emitter; a declared but unreachable
code reads like coverage that does not exist.

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

### Decisions slice 3 settled

Each is recorded in the code that owns it.

**Active conditions project at the subject locus.** The condition owner stores
no body location (audit finding 11), so a located condition cannot be located;
guessing a body locus would be invention. Value is the canonical `conditionKey`
plus severity, expiry-gated at the cut minute, duplicate labels collapsed to
the earliest instance.

**Derived wet-material effects gate on bands the material can actually reach.**
Wetness increases are absorbency-scaled, so a low-absorbency shell can never
reach the `wet` band — a `wet` gate for beading would be dead vocabulary.
Beading therefore gates on any non-dry band, while clinging and translucency
need `wet` or above. The `unknown` material profile passes no gate and degrades
to silence with no special-casing.

**Garment features carry no validity window.** Garment drying is exponential
(per-material half-life), so the band-crossing time needs a logarithm — floats
in a fixed-point-deterministic path. Body-surface windows exist because that
law is linear and exact: `ceil(60·(level−floor+1)/rate)` matches
`linearDriftStep`'s floor division with no floats. Precipitation suspends
drying and drops the window.

**Projected bands are plain, never hysteretic.** Hysteresis needs the band a
consumer last reported — mention state — and reading it would make the same
committed truth project differently per consumer. Hysteresis stays in
consumers.

**Change stamps are per-fact where the owner has them.** Surface
`updatedAtMinutes` and deposit/damage `atMinutes` are used directly; otherwise
the instance's coarse `lastChange` is spent only when its change kind writes
the channel family being projected (`condition` → gradients, `damage` → also
`wear`, `presentation` → structural). Band drift from lazy drying never
restamps.

**No observation→cause composition edges.** Asserting why an affordance
observation happened would need per-phenomenon knowledge this projection does
not own. Observations project as `instantaneous` features carrying the
observation's `repeatKey` as their `repeatFamily` — what slice 5's cooldown
inherits — with no stamps and no window.

**`replaces_visible_surface` alone remains unowned.** `derived_from` now has
its owner (a garment's wet-material effects derive from the garment's own
wetness feature). Nothing anywhere distinguishes a hairpiece from a hat, so
surface replacement stays a recorded missing owner exercised only by
hand-built fixtures.

**The compatibility adapter is unchanged.** Condition-sourced
`ProjectedFeatureTruth` still suppresses — upstream never produces it — and
live conditions come through the new adapter on the current layer instead.

**Bands and vocabulary are pinned, not restated.** Body-surface bands walk the
garment wetness ladder (one vocabulary, held by a drift-guard test), and
garment condition channels reuse the digest's bands minus neutrals — a
non-neutral-only projection, with tuck always projecting per the digest's
"no neutral" ruling. Deposits sit at the item locus with parts and freshness
in the value and the escaped deposit id in the aspect; damage sits at its
part. Snapshot suppression order is adapter → duplicate-key → composition.

### Decisions slice 4 settled

Each is recorded in the code that owns it.

**Slice 4 owns the visibility half of the context only.** The spec's full
attention context (focus loci, action loci, importance boosts, consumer) is
slice 5's; `VisualVisibilityContext` is what slice 4 built, and slice 5
extends it rather than reshaping it.

**`VisualViewpoint.observer` is a plain observer id.** No `VisualObserverRef`
union exists anywhere, and inventing one for a single string field would be
vocabulary without a second reader.

**Distance and angle reuse the scene owner's vocabularies.** Distance bands
are scene proximity bands and angles are scene facings — a second wording of
either would drift from the one system that proves them.

**An unknown or invalid component fails the whole read closed.** One
diagnostic plus per-feature suppressions, nothing claimed visible under it.
This is the strict reading of "unknown cannot become positive visibility",
and it is the intended shadow behavior while lighting and motion have no
production owner (audit finding 14). The open question on relaxing it per
component sits in the plan.

**Gaze projects as explicitly unavailable.** The scene owner proves facing —
where the body points — and nothing anywhere records where the eyes point.

**Hand occupation derives only from committed contacts.** Sourced from active
contacts in the `hands` registry subtree (the audit's sanctioned derivation),
one feature per subject and side, with a minimal `{ side }` value so a
re-asserted touch does not churn the fingerprint; action kinds ride tags and
evidence. The `sourceRef` is the first contact by contact id with every
contributor in evidence, and the change stamp is omitted when more than one
contact contributes. Support relations that load the arms are NOT re-derived
into hand occupation — the support feature already carries its load zones,
and deriving a hand from a zone states more than the owner does.

**Owner-side ids ride verbatim.** Values and relation loci carry the scene and
contact owners' own row identities; the subject map only selects and renames
subjects (facing needs only the facing side mapped).

**Body-language kinds are instantaneous and never mandatory.** All five are
recognition-ineligible (`defineVisualStateKind` enforces the pairing with
instantaneous stability), and the mandatory set stays identity, morphology,
wardrobe, subject count and action.

**Adapter suppressions are returned beside features.** The body-language and
visibility adapters return `{ features, suppressions }` on the
`buildRecognitionCandidates` precedent; slice 3 landed
`VisualStateContribution.suppressions` in the same merge window, and the
caller files the returned suppressions into its contribution when it
assembles a snapshot — slice 6's wiring, not this adapter's.

**Exposure and framing gate body loci only.** Framing bands map to the
scene's five body zones (`full_figure` and `wide` contain everything; tighter
frames fail unresolvable zones closed). A garment's frame answer needs the
captured effective-coverage read, so non-body loci are not frame-gated — a
documented simplification. Gate order mirrors recognition: locus → intimate
(hard, first) → sight channel (observer only; camera and debug viewpoints
have no senses) → exposure → composition → framing → fixed-point factor
product → tier.

**The hinted exposure factor is restated, not imported.** Recognition's 3000
factor is copied locally because importing it would create the
`visual-state` → `affordances/recognition` cycle slice 1 already dodged; the
place the two meet in slice 5 is a compile error if they diverge.

### Decisions slice 5 settled

Each is recorded in the code that owns it.

**Both meeting points are compile errors on divergence, as promised.** The
scope unions meet in identity-conversion functions whose `return` statements
compile only while `VisualStateScopeRef` ≡ `VisualMemoryScopeRef` — and the
conversion is load-bearing: narrator selection converts the snapshot scope and
fails closed (`scope_mismatch`, memory untouched) if it names a different
continuity than the binding. The hinted factors meet in a constant typed as
the intersection of the two literal types, which goes `never` if either side
moves. Both guards were verified by deliberate divergence during the build.

**No law is restated.** Salience, novelty, freshness and repetition cooldown
are the shipped recognition functions called directly; the four-way selection
priority delegates to `recognitionMentionPriority` by folding the fourth
reason via max-associativity. Change significance is banded from the
`changedAtMinutes` stamps slices 2–3 added (≤ 1 hour → 9 000, ≤ 1 day →
5 000, else 0), max'd with the shipped 9 500 on a memory contradiction.

**Narrator consumer relevance is all-zero.** The four-way max degenerates to
the shipped three-reason law for narration — the failed ambient-cue trial made
structural. Image rows carry per-layer relevance (identity 3 000,
presentation 6 000, current 7 000, body language 6 500); inspector is 10 000.
All are calibration defaults awaiting trial evidence.

**Novelty and cooldown are narrator-only.** Non-narrator builds ignore a
passed memory entirely (tested byte-equal with and without), and the image
selection is structurally memoryless. Recognition-ineligible and
instantaneous features have novelty 0, so their only cue reasons are stamp
change or action relevance — slice 7's "change-gated, action-relevant, or
newly revealed" rule falls out of the arithmetic rather than being enforced.

**The recognition floor maps exactly.** Four stabilities cross;
`instantaneous` maps to `null` and never enters the memory law, even for a
hand-built record whose stability disagrees with its kind.

**Repeat keys are byte-compatible.** The `recognition.<family>.<locusKey>`
format is reused, byte-identical to shipped keys for body loci; a per-feature
`repeatFamily` override wins over the kind — the slice-1 priors addition
consumed as promised.

**Narrator constraints are visible mandatory facts only.** A hidden mandatory
fact never enters the narrator digest: the leakage rule beats contradiction
prevention, and unseen constraints stay with narrator guidance.

**The intimate consent gate is the one thing mandatory never outranks.** The
image mandatory lane bypasses the visibility read (hidden identity anchors
survive), so it applies the consent gate itself, and gated facts are excluded
with `visual_state.intimate.gated` + `mandatory:<group>` detail.

**Focus lowers the notice threshold but never raises the detail tier.**
Inspection cannot see in the dark — stricter than the conditionless chat
lane, deliberately.

**Consumer-ineligibility filtering is silent.** Designed absence is context;
today every registered kind is narrator- and image-eligible, so the filter has
no reachable negative case.

**The image consumer shape at this layer is `VisualImageSelection`** —
mandatory features plus scored optional candidates — deliberately not the
spec's `VisualImageDigest`: slice 8 owns digest realization and keeps its
names. Candidates carry a `repeatKey` beside the spec's fields. Narrator
selection returns notices, changes, post-notice memory and mention commits as
plain data on the mention-policy precedent, so retakes stay pure;
`commitVisualNarratorMentions` is the caller's post-cut step.

**Failure is silent and diagnosed, never partial.** Scope mismatch, context
mismatch and an unbrandable key (> 256 chars cannot index memory) each fail
closed with one diagnostic plus per-feature suppressions, memory untouched.

### Decisions slice 8 settled

Each is recorded in the code that owns it.

**The digest lives in `contracts/images/`, not `contracts/visual-state/`.**
Recognition consumes the projection (the slice-1/4/5 import direction), the
digest consumes recognition's `VisualImageSelection`, and it speaks
`@vesper/image-core`'s segment vocabulary — so it sits downstream of both,
beside the scene-camera vocabulary at the image seam. `contracts/state/scene-gen.ts`
is the precedent for a contracts file importing `@vesper/image-core`.

**Camera reads are typed facts, never pseudo-features.** A camera read has no
owner, key or fingerprint, and fabricating them would invent provenance.
`visualImageCameraFacts` carries known reads only;
`visualCameraReadsOfSceneCamera` maps the committed scene camera's registry
vocabulary onto known distance/angle/framing reads via exhaustive switches.
Lighting and motion stay caller inputs — no production owner exists, and an
unknown read fails the optional lane closed (the plan's parked open
question).

**Segment kinds map by layer and source, with two rulings.** Anatomy and
species groups → `morphology`; the apparent-age attribute → `age`
(registry-drift-guarded); other identity → `identity`; worn/carried wardrobe →
`wardrobe`; a garment left at a scene locus → `setting`; non-item presentation
and all current-layer facts → `current_state` (the segment registry has no
`presentation` member, and adding one is image-render-quality's registry —
the slice-2 "wig" precedent); body language → `pose`. There is deliberately
no `exposure` mapping: exposure is a coverage read, not a projected feature,
and the consolidation adapter keeps consuming the canonical coverage readout.

**Consent-gated is not missing.** The mandatory lane bypasses visibility
(hidden identity anchors keep an `identity_required` basis), and
`visual_state.digest.mandatory_missing` explicitly excuses consent-gated and
image-ineligible absences as designed rather than degraded.

**Provenance identifies, never duplicates.** `VisualImageProvenance` stores
scope key, cut, the three fingerprints (snapshot / selection / camera), and
per-subject selected `{key, truthFingerprint, required, segmentKind}` under
`meta.visualState`, beside package-owned `meta.render`. The selection
fingerprint reuses `visualStateFeaturesFingerprint`, so "same composition,
retry" versus "current state moved" is one equality check — the slice-1
promise kept. Read-back parses non-strict and degrades to absent provenance,
never a fabricated one.

**Staleness is cut identity only.** A pure digest has no honest "now" beyond
the snapshot's own minute, so per-feature validity windows are not
re-judged; `forCutId` mismatch fails the whole digest closed.

**Shared "required" definition.** The selection's private mandatory test was
exported (`isMandatoryVisualStateFact`) so the digest and the selection cannot
drift on what "required" means.

### Decisions slice 6 settled

Each is recorded in the code that owns it.

**A lane-absent owner is a suppression of the snapshot itself.** Each owner a
lane cannot supply is recorded as one info-severity
`visual_state.source.unavailable` suppression at the subject locus with a
`lane:<owner>` detail — the slice-3 unsupported-table precedent — so
missing-owner frequency is a property of the snapshot, not of whoever
happens to count.

**Shadow visibility components are all-unknown, deliberately.** No production
owner emits lighting, distance, angle, motion or framing for a chat turn, and
deriving partial reads from the scene owner would blur exactly the
measurement the plan's open question waits on. Everything fails closed at
lighting first; the inspector's attention staircase instead uses a debug
viewpoint under ideal conditions (bright, close, toward, still).

**The legacy comparison is a documented replica.** `measure.ts` restates
character chat's five-step attribute guard chain as `legacyNarratorAttributeIds`
for disagreement measurement only; slice 10 consolidates the original away,
at which point the replica dies with it.

**`server/visual-state` is pure over passed-in state.** It imports only
`@/contracts`, so `server/engine → server/visual-state` stays one-way and the
successor glue loads its own profile rather than importing `sim-exchange`.

**The shadow can never touch a turn.** Flag-gated (default off — the spec
left the default open and off is the conservative reading), fenced
(`visual_state.shadow.failed` on any assembly error, turn unaffected),
diagnostics on a private collector, and its only database touch is a
read-only visual-memory load; the preview's memory read sits behind a nonce
guard that always hits the current generation. Byte-identical production
behavior is asserted structurally and by test (default-off, deep-frozen
inputs, same cut → byte-equal outputs, restored cut reproduces them); a
flag-on/off full-pipeline prompt-byte comparison would need Postgres and
belongs to `test:int` if ever wanted.

**The successor lane shadows a profile-truth subset.** Attributes and species
realization project; engine-body conditions are shape-mismatched with
`ActiveCondition` and are recorded as lane-unavailable rather than adapted;
only the co-present turn is hooked; narrator selection runs against empty
memory under a branch-scoped binding, because nothing persists `world_branch`
visual memory yet.

**Subject handles.** Body language projects for all mapped participants;
appearance and wardrobe project for the primary character, player-worn
garments under the lane's existing `player` handle, and loose scene garments
under a literal `scene` subject id.

**Garment category and subtype are omitted at assembly.** They live on
library rows the cut does not carry, so the wardrobe adapter's documented
concealment-conservative default applies; layer IS plumbed from resolved worn
rows.

**Slices 7 and 8 own their flags.** `IMAGE_VISUAL_STATE` is deliberately
unregistered — registering an unread flag would be dead vocabulary. Slice 7
shipped as a per-chat column instead of a flag (2026-08-17).

### Corrections from the slices 3–9 review (2026-08-16)

A review over the whole merged range found ten defects; all were fixed in one
pass, and four of them change contracts recorded above.

**Exposure and consent are per subject.** `VisualVisibilityContext` gained
`perceptionBySubject` and `intimateAllowedBySubject`. A snapshot spans subjects
— body language projects for every mapped participant — and the single
`perception` view was answering for all of them, so one character's clothing
decided what another was showing, and one subject's consent gated another's
intimate loci. Supplying either map makes that read STRICT: an unlisted subject
resolves nothing rather than borrowing. Omitting them keeps the single-subject
behavior. `perception` remains the viewpoint's channel view, because channels
belong to whoever is looking.

**The consent gate follows a garment's own edges.** A non-body locus inherits
the intimate group of whatever its accepted `covers`/`occludes` edges reach, so
an intimate-region garment's arrangement can no longer reach a consumer while
the skin beneath it is withheld.

**An observation's key carries its intensity band.** Two intensities of one
phenomenon at one source and target used to render a single key, so the
snapshot dropped the second as a duplicate and which band survived depended on
read order.

**`towardSubjectId` is a subject id.** The facing adapter now maps the toward
end through the same participant→subject map as the facing side; an
unmapped participant is still carried verbatim, which no subject matches.

**The unsupported-fact table dropped `contact:occupied_hands`.** Slice 3 tabled
it as ownerless and slice 4 then shipped `body_language.hand_occupation`, so a
single snapshot reported the fact unavailable and stated it at the same time.
The table's own rule is that a row dies when its owner ships; a test now pins
that this row is gone.

Also fixed, without changing a recorded contract: the narrator digest's
`suppressedCount` counts cue-ELIGIBLE candidates rather than every scored one;
image-ineligible mandatory facts record a suppression instead of vanishing; the
character-chat shadow is deferred off the turn's critical path, as the
successor lane already did; the extraction accept re-reads the profile under a
row lock inside its write transaction, so a concurrent character edit is no
longer clobbered; the legacy-vs-projection comparison de-duplicates both sides
before differencing; and the per-subject digests group once instead of
re-filtering per subject.

### Decisions slice 9 settled

Each is recorded in the code that owns it.

**The proposal wire shape carries a locus.** The spec's `VisualContractProposal`
gains a required, un-coarsened body locus for `located_fact` and
`presentation` targets (forbidden for `attribute`). `ImageRegion` existed
nowhere, so `VisualExtractionImageRegion` defines it: a normalized fixed-point
rect (0…10000), evidence-only. Confidence is a branded unit interval and
grants nothing.

**Extractor output is untrusted at two gates.** Per-item boundary parse,
then revalidation by the target owner's own vocabulary — the attribute
registry (including its sensory and non-character refusals), the appearance
kind registry with `allowsBodyLocation`, and the presentation owner's kind
set. Sixty-four proposals per run, overflow reported; per-run slot dedupe
(first wins); output sorted by slot key.

**Slot identity reuses the owners' own keys.** `attribute/<id>`,
`located_fact/<bodyLocusKey>/<kind>`,
`presentation/<bodyLocusKey>/<aspect>` — the presentation aspect reuses
`presentationAspect`, so grooming and cosmetic-mark discriminators match the
owner's slot law exactly.

**A ruling is carried by machine fingerprint, never by confidence.** A re-run
compares the new machine fingerprint against the newest decided ruling per
slot: identical → the ruling (edits included) carries, `applied` carrying as
`accepted`; different → a new `pending` row with
`conflict_with_proposal_id` and `visual_state.extraction.conflict`
(`reviewed_value_differs`), the ruling untouched. `superseded` is reachable
only from `pending`, and only by a new run over the same character and image.

**An accept must echo the fresh canonical digest.** The server recomputes the
order-insensitive digest of current canonical values at decide time; a
mismatch answers 409 `canonical_moved` with the fresh diff and writes
nothing. Edited values re-run the full boundary and must keep their slot.

**Apply goes through the owner's own write path, or not at all.** Attribute
accepts land on the character profile via the PATCH route's law (replace by
id, `manual` source, `sourceId: reference_extraction:<proposalId>`, then
`materializeBodyDefaults`). Located facts and canonical presentation have no
persisted per-character lane, so their accepts persist as accepted-unapplied
with `visual_state.extraction.owner_unavailable` — the plan carries the open
question. Applied rows are immutable: disagreeing with an applied fact means
editing the canonical owner, so extraction can never become a second edit
surface for canonical truth.

**Storage follows the identity-pack precedents.** Two additive tables
(migration `0111`): per-proposal rows on the concurrent-ruling pattern;
`source_hash` is SHA-256 over the stored webp bytes; the source image must be
the character's ready avatar or portrait variant, owner-scoped; image FK
SET NULL and reviewer FK no-action for the audit trail. Admin-only routes
(`withOwnerAdmin`), no flag — the surface is dark until a review UI exists.

### Decisions the slice-7 unblock settled (2026-08-17)

Two prerequisites the shipped slices exposed, both closed by owner ruling and
built in one change. Each is recorded in the code that owns it.

**Viewing conditions are half-owned, half-declared, never silently defaulted.**
Distance and angle come from the scene owner when it states them; lighting and
motion have no owner anywhere and are supplied as marked declared defaults
(`bright`, `still`). The owner's ruling (2026-08-17) was a base-value
placeholder rather than a new simulation owner. `declared: true` on the known
arm of `VisualComponentRead` is what keeps this a stated policy: it rides the
camera fingerprint, every visible read's evidence, one info diagnostic, and the
inspector's own panel. Replacing the lighting placeholder with a real owner is a
one-line change plus its caller, and the marker is what makes that swap visible
when it happens.

**This reverses the slice-6 all-unknown decision recorded above.** That decision
was correct for measuring missing-owner frequency, and the measurement it was
waiting for came back unambiguous: with all four unknown, the production
narrator selection has zero candidates under every ordinary condition, so there
is nothing left to measure.

**Two narrator-side records, disjoint by construction.** `isMemoryEligible` is
the single predicate deciding whether observer memory or the cue state answers
for a feature — novelty, cooldown, and the mention ledger all follow it, so one
cue can never spend both and the cue cap is spent entirely on the gap it exists
to fill.

**The cue state records visibility for every resolvable family, not just cued
ones.** Recording what was in view is what makes the next cut's newly-revealed
answer correct, exactly as a notice is for memory. Both come back as plain data
and the caller commits them once the cut lands.

**The shadow image lane takes the same conditions.** A shadow camera has no
committed camera of its own, and leaving it unknown would hold slice 6's image
measurement at a permanent zero — measuring the placeholder rather than the
projection. A real render supplies its own reads through
`visualCameraReadsOfSceneCamera` when the consolidation plan cuts routes over.

**`VISUAL_ATTENTION_FIRST_VISIBLE_NOVELTY` is a runtime assertion, not a type
identity.** Meeting points 1 and 2 are compile-time, but both novelty constants
are `UnitInterval`, whose brand erases the literal — an intersection type would
compile whatever the values were. A module-load equality check is the honest
form.

**The successor lane is not wired.** It hands over no scene and has no cue
store, so its shadow runs on all-declared conditions with an empty cue state.
Successor parity stays slice 10's.
