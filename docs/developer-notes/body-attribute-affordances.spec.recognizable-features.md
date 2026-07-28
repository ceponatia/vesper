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

## Open questions

- Whether located facts extend the existing provenance spine or use a dedicated
  evented store in each lane.
- Which fine-detail schemas ship first beyond the coarse body tree.
- Whether uniqueness is definition-only in v1 or also cast-relative.
- Who may raise importance: owner, source event, observer attention,
  self-concept, or a bounded combination.
- How intimate-region features inherit exposure, consent, and focus gates.
- Whether recognizable motion belongs here or in a later multisensory identity
  memory.
- Visual-memory notice threshold, decay, mention-history, and semantic-memory
  boundaries
  ([detail](body-attribute-affordances.recognizable-features.memory.md#open-questions)).
