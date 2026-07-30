# Affordance spec draft — recognizable features

Status: companion to
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md)
(promoted 2026-07-28)

## Purpose

Make characters visually recognizable as individuals without adding a
hand-authored `recognizable_features[]` field that duplicates facts already
owned by attributes, body structure, conditions, injuries, or presentation.

Examples:

- concentrated freckles across the shoulders;
- a crooked nose or front-tooth gap;
- a chipped horn or distinctive white forelock;
- a missing left ring finger acquired during play;
- a scar whose importance comes from the event that caused it.

The system derives recognition candidates from canonical body truth, then uses
[salience and observer visual memory](body-attribute-affordances.recognizable-features.memory.md)
to decide what has been noticed and when it is worth mentioning.

## Core ruling: recognizability is a projection

Do not store:

```ts
character.recognizableFeatures = [
  "freckles on shoulders",
  "crooked nose",
  "missing ring finger",
];
```

That array would duplicate truth, lose location/provenance/lifecycle, drift when
a feature changes, and expose details to observers who never perceived them.

Instead:

```text
canonical attributes
+ located appearance facts
+ realized anatomy/topology
+ persistent and transient body state
+ current wardrobe/presentation
                ↓
recognizable-feature projection
                ↓
observer perception
                ↓
visibility × uniqueness × importance
                ↓
visual memory + narrator mention policy
```

Source records describe the body. “Recognizable” is a contextual read, not
another truth store.

## Body-truth owners

### Canonical attributes

Use an attribute when a feature is single-valued, structurally ordinary, and
part of stable appearance vocabulary:

- `nose.alignment = "crooked"` or an expanded `nose.shape`;
- `teeth.spacing = "front_gap"`;
- `hair.hairline = "widows_peak"`;
- an orthogonal eye-color pattern axis for heterochromia.

Definitions already bind attributes to `bodyLocationId`. Optional recognition
metadata lives beside the definition; the character profile continues to store
only the ordinary `AttributeValue`.

### Located appearance facts

Use a located fact for repeatable, multi-instance, patterned, or open-ended
details that would cause enum explosion:

- freckle cluster on the shoulders;
- crescent birthmark below the left collarbone;
- three parallel scars on the right forearm;
- tattoo wrapping one thigh;
- silver scales along the spine.

```ts
interface LocatedAppearanceFact<TValue = unknown> {
  id: AppearanceFactId;
  subjectId: CharacterId;
  kindId: AppearanceFeatureKindId;
  locus: BodyLocusRef;
  value: TValue;
  source: AppearanceFactSource;
  sourceEventId?: EventId;
  validFrom: StoryTimestamp;
  validUntil?: StoryTimestamp;
  supersedesFactId?: AppearanceFactId;
}
```

The registered kind parses `value`; arbitrary JSON and executable prose are
forbidden. These rows store body truth, not “things worth mentioning.”

### Anatomy/topology state

Presence, absence, duplication, fusion, or replacement of a body part belongs
to realized anatomy:

- missing or extra digit;
- prosthetic limb;
- shortened horn after a break;
- torn ear;
- removed or regrown wing.

Topology affects action validation as well as appearance, so it needs an
authoritative evented state:

```ts
interface AnatomyPartState {
  subjectId: CharacterId;
  locus: BodyLocusRef;
  state: "present" | "absent" | "altered" | "prosthetic";
  alterationKindId?: AnatomyAlterationKindId;
  effectiveFrom: StoryTimestamp;
  sourceEventId: EventId;
}
```

Recognition may describe the consequence but never owns or mutates topology.

### Conditions, injuries, and persistent marks

Temporary or healing features stay with body-state owners: bruises, swelling,
rash, stitches, pressure lines, dirt, blood, paint, or soot.

If aftermath becomes permanent, a committed transition ends the temporary
condition and creates a persistent appearance fact or anatomy delta. The
recognition layer cannot decide that an injury “probably scarred.”

The current chat `ActiveCondition` overlays attributes, while successor
`BodyCondition` is meter/condition focused. Before this family ships, add a
lane-neutral located body-state read rather than forcing lasting marks into
either existing shape.

### Wardrobe and presentation

Signature glasses, ribbon, jewelry, makeup, hairstyle, prosthetic cover, or
favorite coat may aid recognition while currently worn. Their owning item or
presentation state remains authoritative; removing the item removes current
visibility without rewriting the body.

## Fine body locus without coverage-tree explosion

The body tree is intentionally coarse for coverage (`hands` → `fingers`).
Recognition and acquired topology need finer addressability without making ten
digits into garment slots:

```ts
interface BodyLocusRef {
  bodyLocationId: BodyLocationId;
  side?: "left" | "right" | "center";
  detail?: {
    schemaId: BodyDetailSchemaId;
    path: readonly BodyDetailSegmentId[];
  };
}
```

Examples:

```ts
{ bodyLocationId: "shoulders" }

{ bodyLocationId: "nose", side: "center" }

{
  bodyLocationId: "fingers",
  side: "left",
  detail: { schemaId: "humanoid_hand_v1", path: ["ring_finger"] },
}
```

Rules:

- the coarse location is always legal and remains the coverage fallback;
- detail paths are registry-validated, never free text;
- fine detail does not automatically become a coverage node;
- unsupported detail fails closed for topology writes; an appearance-only read
  may fall back to the parent with a diagnostic only when the value remains
  semantically true at that coarser locus;
- topology may require finer detail schemas than appearance-only facts.

## Feature-kind registry

Located fact kinds declare validation and recognition priors:

```ts
interface AppearanceFeatureKindDefinition<TValue> {
  id: AppearanceFeatureKindId;
  valueSchema: Schema<TValue>;
  allowedBodyLocations: readonly BodyLocationId[];
  persistence: "stable" | "persistent" | "transient";
  visualRealizerId: VisualRealizerId;
  recognition: {
    baseUniqueness: UnitInterval;
    baseImportance: UnitInterval;
    minimumDetailTier: 1 | 2 | 3;
    repeatFamily: string;
  };
}
```

The registry stores calibration, not which features a character has. Attribute,
anatomy, condition, and presentation definitions expose equivalent priors
through their own registries.

## Derived body-area view

Editors and diagnostics may present a nested view:

```ts
{
  shoulders: {
    surface: {
      freckles: [{ density: "dense", pattern: "clustered" }],
    },
  },
  nose: {
    geometry: {
      alignment: "crooked",
    },
  },
  fingers: {
    left: {
      ring_finger: {
        presence: "absent",
      },
    },
  },
}
```

This view is assembled from attributes, located facts, and anatomy state. It is
never persisted wholesale; source edits and replay rebuild it.

## Recognition candidate

Every eligible source projects into one contract:

```ts
interface RecognizableFeatureCandidate {
  key: RecognizableFeatureKey;
  subjectId: CharacterId;
  locus: BodyLocusRef;
  sourceRef: AppearanceSourceRef;
  truthFingerprint: string;
  semanticTags: readonly string[];
  stability: "inherent" | "persistent" | "transient" | "presentation";
  visibility: UnitInterval;
  uniqueness: UnitInterval;
  importance: UnitInterval;
  evidence: readonly AffordanceEvidence[];
  repeatKey: string;
}
```

`key` is stable for the conceptual feature, such as
`subject/left-ring-finger/presence`. `truthFingerprint` changes with its value,
such as `present` → `absent`, allowing observer memory to detect change without
losing feature identity.

Candidates contain structured values and semantic tags, never final prose.

## Salience and visual memory

The three required salience dimensions remain separate:

- **visibility** — current observer/cut exposure, coverage, light, distance,
  angle, contrast, detail tier, and attention;
- **uniqueness** — registry rarity, instance pattern/placement, species prior,
  and optionally cast-relative distinctiveness;
- **importance** — authored identity weight, source-event significance,
  relationship relevance, player attention, and self-concept.

The initial scoring proposal is:

```text
featureSalience =
  visibility × (0.55 × uniqueness + 0.45 × importance)

mentionPriority =
  featureSalience
  × max(novelty, changeSignificance, actionRelevance)
  × repetitionCooldown
```

Zero visibility is a hard visual gate. Importance lets a common shared-event
scar outrank a rare irrelevant detail. Mention priority never changes body
truth.

Observer memory tracks separate `lastNoticedAt` and `lastMentionedAt` values.
Repeated visibility can strengthen recognition while reducing narration
novelty. Full contracts, update laws, RAG boundaries, missing-finger flow, and
tests live in the
[visual-memory detail](body-attribute-affordances.recognizable-features.memory.md).

## Feature catalog

Candidate families include facial asymmetry, heterochromia, tooth gaps, hair
streaks, freckle fields, moles, birthmarks, scars, tattoos, calluses, missing or
extra digits, prosthetics, healed fracture angles, supernatural horn/wing/tail
damage, signature presentation, and recognizable movement.

The broad examples, ownership rulings, constellations, and recommended first
fixtures live in the
[candidate catalog](body-attribute-affordances.recognizable-features.catalog.md).

## Code organization

The proposed module tree and dependency rules live in the
[shared code-organization spec](body-attribute-affordances.spec.code-organization.md#recognition-ownership).
Body truth remains outside affordances; recognition consumes normalized
projections, and lane adapters bridge authoritative state and observer memory.

## Anti-patterns

- No `recognizable_features[]` JSON blob.
- No free-text body-detail path.
- No biography/narrator-prose parsing every turn.
- No treating every non-default attribute as recognition-worthy.
- No global visual memory shared across observers.
- No memory update when a feature was present but unseen.
- No false disappearance from cue omission or occlusion.
- No rarity bypass of exposure, consent, or intimate-region gates.
- No using visual memory as canonical anatomy.

## Rollout

1. Add `BodyLocusRef`, feature-kind definitions, and fixture-only located facts.
2. Project existing attributes into candidates; add no persistence yet.
3. Add fixed-point salience and deterministic diagnostics.
4. Add player-observer visual memory for committed chat cuts.
5. Add one authored located family (freckle/birthmark cluster) and one acquired
   family (scar), including supersedence.
6. Add anatomy detail schemas and the missing-digit fixture only after topology
   ownership is settled.
7. Evaluate first notice, repetition, change detection, hidden-feature leakage,
   and long-absence recognition.
8. Project successor observations into the same visual-memory contract; keep
   semantic-memory documents optional and downstream.

## Acceptance tests

- no character profile contains a recognizability list;
- identical body truth produces identical candidate keys/fingerprints;
- shoulder freckles use the shoulder coverage fallback;
- a crooked nose attribute projects without a duplicate located fact;
- missing-finger truth comes only from authoritative anatomy state;
- zero visibility produces no cue regardless of uniqueness;
- first notice may produce a cue; ordinary repeated visibility normally does
  not;
- a changed fingerprint produces change, while occlusion never produces
  disappearance;
- observer memories never leak across viewpoints;
- malformed kinds/loci degrade to diagnostics and silence.

## Resolved (owner rulings, 2026-07-28)

- **Storage.** Ordinary single-valued features remain attributes; open-ended
  marks use typed located appearance facts; missing/extra/altered/prosthetic
  parts use evented anatomy state; bruises, wounds, dirt, and temporary marks
  use body condition/state; removable signature items remain
  wardrobe/presentation. **Prose RAG facts are never authoritative body truth**
  — located facts use a dedicated **lane-neutral typed contract**, persisted
  through each lane's normal continuity mechanism, with semantic-memory
  documents generated downstream.
- **Fine detail.** Ship a finite **humanoid-hand schema** first (left/right,
  named digits — this supports the missing-ring-finger goal). Face landmarks can
  follow. Shoulder freckles and ordinary scars need no fine paths.
- **Uniqueness.** v1 uses definition priors (`recognition.baseUniqueness`) plus
  instance modifiers for unusual placement or pattern. Cast-relative uniqueness
  is deferred: adding a cast member must not unexpectedly change everyone's
  salience.
- **Importance.** Store a stable base importance from authoring, feature kind,
  self-concept, and source event. Observer relationship and current attention
  apply **at projection time**, never by permanently rewriting the feature.
- **Intimate features.** Notice or mention requires exposure, an appropriate
  perception channel, consent, and current narrative focus. Rarity never
  overrides those gates.
- **Recognizable motion** (gait, habitual head tilt) is deferred to a later
  behavioral/multisensory identity layer — it requires temporal pattern
  evidence, unlike a static scar. The catalog's recognizable-movement family is
  therefore out of scope for this spec's first release.
- **Visual-memory notice threshold, decay, mention history, and
  semantic-memory boundaries** are resolved in the
  [visual-memory detail](body-attribute-affordances.recognizable-features.memory.md#resolved-owner-rulings-2026-07-28).

## Resolved (Slice 7 implementation, 2026-07-29)

Body truth shipped as `src/contracts/appearance-features/` — `locus.ts`
(`BodyLocusRef` + the finite `humanoid_hand_v1` detail schema),
`definitions.ts`/`kinds.ts`/`registry.ts` (the feature-kind registry, seeded
with `pigmentation.freckle_cluster`, `pigmentation.birthmark`,
`pigmentation.mole`, `mark.scar`), `facts.ts` (located facts with validity
windows and supersedence), `anatomy-state.ts` (`AnatomyPartState`),
`attribute-recognition.ts` (which attributes are recognition-worthy), and
`projection.ts` (`projectAppearanceTruth` → `ProjectedFeatureTruth`). The
observer-relative half is `src/contracts/affordances/recognition/`
(`candidates.ts`, `salience.ts`, `visual-memory.ts`, `mention-policy.ts`), and
the chat lane bridges them in `src/server/engine/chat-recognition-adapter.ts`
over `visual-memory-store.ts`. Nothing in appearance-features imports the
affordance layer; nothing in recognition imports a lane.

### What the code does that this spec's sketch did not say

- **`RecognizableFeatureCandidate` carries a `detailTier`.** The sketch lists
  visibility, uniqueness, and importance only, and files detail tier under
  visibility inputs. But `strongestDetailTier` is a *stored* memory field, so
  the tier an observer actually reached has to survive candidate building. It
  is observer-relative exactly like visibility (base tier 2 at conversational
  distance, 3 under deliberate inspection), so it rides the same record rather
  than being recomputed from the priors at commit time.
- **Attribute recognition metadata is a colocated catalog, not fields on
  `AttributeDefinition`.** The spec says "optional recognition metadata lives
  beside the definition"; the shipped catalog is keyed by `attributeId` in
  `attribute-recognition.ts`. Same effect, far smaller blast radius — the
  attribute registry is read by the forge, the editor, every prompt builder,
  and the image pipeline, and none of them should learn a recognition
  vocabulary to add an eye color. Moving it onto the definition is mechanical
  when a second consumer needs it. Each entry also carries a `bodyAreaPath`,
  which is what assembles the derived body-area view (`nose.geometry.shape`)
  without a second mapping table, and an `eligibleValues` list: only the
  distinctive members of a vocabulary project, so an ordinary straight nose is
  never a recognition candidate.
- **`nose.shape` gained a `crooked` value**, with `autoDefaultExcludes` so an
  unspecified character never silently acquires it. The spec's canonical
  example asked for `nose.alignment = "crooked"` *or* an expanded `nose.shape`;
  expanding the existing vocabulary avoided a second facial-geometry axis that
  every authoring surface would have to learn.
- **`visualRealizerId` is optional** on a feature-kind definition. The sketch
  requires it, but Slice 8 deliberately deferred the image consumer
  ([architecture ruling](body-attribute-affordances.spec.architecture.md#deferred-scene-image-consumer-slice-8-ruling-2026-07-29));
  a required field would therefore have been filled with placeholders. The
  honest shape remains "absent until a tested, allowlisted consumer needs a
  distinct realization beyond the canonical appearance summary".
- **The priors vocabulary lives in a `priors.ts` leaf**, re-exported verbatim
  by `projection.ts` so the frozen seam's names and import paths are unchanged.
  Purely a cycle fix (`pnpm lint:cycles`): the kind registry and the attribute
  catalog both need detail tiers and priors, while `projection.ts` consumes
  both registries. Priors also stay UNBRANDED integers here — appearance
  features sit upstream of the affordance core, and the recognition layer is
  the single door that converts them to `UnitInterval`.
- **Locus validation is split by what the read can afford to be wrong about.**
  Topology fails closed on an unsupported detail path, as ruled; an
  appearance-only read may coarsen to the parent location with a diagnostic
  when the value stays semantically true there — the spec's healing fallback,
  implemented as two call sites rather than one flag.
- **Fingerprint adoption is its own explicit path.** `applyRecognitionNotices`
  can never overwrite a remembered `truthFingerprint`; adopting a changed one
  is `applyRecognitionFingerprintChanges`. Two functions, because "the observer
  looked again" and "the observer now knows the feature changed" are different
  events and collapsing them is how a change would silently disappear before
  it could be narrated.
- **Candidate building is hard-gated before scoring**, not scored and then
  filtered: unknown exposure, hidden exposure, a missing sight channel, an
  insufficient detail tier, and an intimate location without explicit
  permission each drop the candidate outright with a diagnostic. Rarity cannot
  reach the arithmetic, let alone survive it.

### Honest silences

- **Recognition is production-inert today.** The chat perception view asserts
  exposure only for garment-covered locations plus hair; bare skin — nose,
  face, arms, fingers — reads `unknown`, and unknown is a hard gate. The
  prerequisite is a body-exposure owner, or an adapter overlay that asserts
  *visible* for uncovered, coverage-relevant locations. Deliberately an owner
  call rather than a papered-over default, the same call slice 6's garment fit
  gap raised.
- **No shipped attribute entry can fire even with exposure solved.**
  `nose.shape` priors (uniqueness 3_500, importance 3_000) mix to salience
  3_275 at full visibility — just under the 3_500 notice bar at tier 2;
  `face.freckles` (2_275) is further under; both teeth entries require tier 3,
  which this lane never reaches. `mark.scar` (4_725), birthmark
  (4_375), and anatomy (7_550) clear comfortably — but no chat surface authors
  located facts or anatomy state yet, so the pipeline passes none. The adapter
  accepts both as optional inputs precisely so the lane that gains an author
  threads them without reshaping the seam.
- **Conditions and presentation are not feature owners yet.** Both source
  kinds exist in `AppearanceSourceRef`; nothing projects them.
- **Successor-lane projection (rollout step 8), cast-relative uniqueness,
  semantic-memory document emission, and recognizable motion** stay deferred
  per the 2026-07-28 rulings.

### Tests

`recognition.test.ts` (52 cases across the package) plus
`recognition-acceptance.test.ts` and `recognition-acceptance-safety.test.ts` —
23 scenarios over the shared `src/test/recognition-acceptance.ts` harness,
proving this spec's acceptance list and the
[visual-memory detail](body-attribute-affordances.recognizable-features.memory.md)'s
end to end, with zero defects found. The chat adapter adds 16, and
`chat-visual-memory.int.test.ts` adds 7 integration cases that self-skip
without Postgres.
