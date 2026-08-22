# Romantic contact affordances — observations, effects, and presentation routing

Status: **not built as a contact-effects slice; architecture reconciled
2026-08-18; owner rulings recorded 2026-08-22** (body-surface ownership,
first-proof order, sensory-subsystem boundaries). This spec replaces the earlier
contact-specific perception/ranking proposal. Visual-state now owns visual
visibility, attention, memory, repetition, and narrator/image selection. Contact
owns physical phenomenon resolution and effect proposals only.

Plan: [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)

Core: [romantic-contact-affordances.spec.contact-core.md](romantic-contact-affordances.spec.contact-core.md)

## The boundary

There are three different things and they must not collapse:

1. **Physical observation candidate** — a structured consequence of committed
   contact/current state, tagged with the sensory channel through which it can
   be perceived.
2. **Effect proposal** — a requested mutation such as transferred residue, a
   pressure mark, a scratch, or garment displacement.
3. **Presented cue** — a perception/attention owner decided that a specific
   observer can perceive an already-true fact and that it is worth offering to a
   consumer.

Contact owns 1 and may propose 2. The appropriate state owner commits 2. Visual
state or a future nonvisual sensory owner decides 3.

## Channel-tagged physical observations

The shared `AffordanceObservation` contract is intentionally channel-neutral in
its existing domains, but its current visual-state adapter assumes that the
observations handed to it are visually meaningful. Contact spans several senses,
so contact must preserve the channel before that adapter boundary.

```ts
type ContactPerceptionChannel =
  | "visual"
  | "tactile"
  | "olfactory"
  | "gustatory";

interface ContactPhenomenonObservation {
  phenomenonId: string;
  channel: ContactPerceptionChannel;
  subjectIds: readonly AffordanceSubjectId[];
  locus: BodyLocusRef;
  targetLocus?: BodyLocusRef;
  intensityBand: "subtle" | "clear" | "strong";
  semanticTags: readonly string[];
  repeatFamily: string;
  evidence: readonly AffordanceEvidence[];
}
```

This contract is structured data, never prose.

### Routing law

```text
ContactPhenomenonObservation
        |
        +-- visual ----------> visual-state observation/feature adapter
        |
        +-- tactile ---------X  future shared sensory owner
        |
        +-- olfactory -------X  future shared sensory owner
        |
        +-- gustatory -------X  future shared sensory owner
```

Only `channel: "visual"` may adapt into the current
`VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID` path.

Tactile, olfactory, and gustatory observations remain pure/diagnostic results
until a shared nonvisual sensory presentation owner exists. They must not be
smuggled into visual state, the old affordance cue block, or a new contact-local
narrator block.

### Owner ruling (2026-08-22) — modality-specific contracts, not one widened type

`AffordanceObservation` does not gain a sensory-channel discriminant merely to
support contact. Vesper treats visual, auditory, tactile, olfactory, and
gustatory perception as distinct sensory subsystems under a shared sensory
presentation architecture. Authoritative domain state may produce
channel-tagged phenomena for routing — `ContactPhenomenonObservation` above is
exactly that — and a common routing envelope may retain a channel discriminant,
but each modality adapts into its own observation contract whose perception
rules are owned by that subsystem. The individual observation contracts are
never collapsed into one generic cross-sensory type. Any change to the shared
affordance contract is designed cross-domain, never from contact alone.

## Visual presentation is visual-state work

The following old contact-spec concepts are **retired**:

- contact-owned visual perception scoring;
- `ContactMentionPriority` / contact-specific ranking formula;
- separate contact visual cooldowns;
- separate `lastObservedAt`, `lastOfferedAt`, `lastRealizedAt` contact memory;
- `ContactPresentationCapture` containing selected cue ids/repeat keys;
- a contact-specific visual narrator renderer.

Visual-state already owns:

- per-subject visibility/exposure;
- occlusion/composition;
- visual attention ranking;
- observer notice/mention state;
- repeat families/cooldowns;
- selection budgets;
- narrator/image digests;
- retake-safe cue state;
- the single chat visual-state narrator adapter.

A contact visual observation therefore supplies only enough structured truth and
stable identity for visual state to do its job.

## Existing contact -> visual-state bridge

Current visual-state code already consumes contact truth in two ways:

1. body-language projection derives hand occupation from active committed
   contacts;
2. body-language projection emits committed contact motion bands.

The generic visual-state affordance-observation adapter can also consume resolved
visual `AffordanceObservation` values, carrying the phenomenon repeat key into
visual-state selection.

### Gap: first-class contact relation

Hand occupation and `pressing/sliding/still` motion do not fully represent:

```text
source participant + source locus
        -> active contact
        -> target participant + target locus
```

Before rich positive visual contact narration is considered complete, add a
visual-state kind/adaptor such as `body_language.contact_relation` (final name is
a visual-state contract decision) sourced directly from `CommittedContactRead`.
It should carry:

- contact id/relation locus;
- source participant id + body locus;
- target participant id + body/object locus;
- action kind where useful for identity, never as permission disclosure;
- visually relevant material-between summary only when the wardrobe/visibility
  owners support it;
- lifecycle provenance and change timestamp.

It must not carry hidden permission state, inferred emotion, tactile texture,
pleasure, or rejected alternatives.

Visibility remains observer-specific. A contact may be physically active even
when an observer cannot see one or both surfaces.

## Effect proposals

```ts
type ContactEffectProposal =
  | SurfaceTransferProposal
  | BodyMarkProposal
  | ScratchProposal
  | GarmentOperationProposal;
```

Every proposal contains:

- stable idempotency key derived from the causal contact/action event;
- source and target owner identities;
- exact locus/garment part;
- semantic magnitude/band;
- source material/condition evidence;
- contact/path/pressure/motion evidence;
- story time;
- no narrator text.

A proposal is not truth.

## Ownership table

| Effect/current fact          | Owner                                     | Contact role                              |
| ---------------------------- | ----------------------------------------- | ----------------------------------------- |
| Active contact               | contact lifecycle                         | commit/read directly                      |
| Body-surface wetness         | body-surface state                        | consume; propose owner-committed transfer |
| Garment wetness/condition    | wardrobe/garment condition                | consume/propose garment mutation          |
| Garment deposit              | wardrobe/garment state                    | propose; wardrobe commits                 |
| Garment displacement/closure | wardrobe operation                        | propose; wardrobe validates/commits       |
| Body residue/product         | body-surface state (ruled — unbuilt)      | cannot commit yet                         |
| Dirt/blood/cosmetics on skin | body-surface state (ruled — unbuilt)      | cannot commit yet                         |
| Pressure/contact mark        | body-surface state (ruled — unbuilt)      | cannot commit yet                         |
| Scratch/skin damage          | **missing owner for this feature**        | cannot commit yet                         |
| Physiology/swelling/flush    | physiology/body-state owner (future)      | consume only after that owner exists      |
| Permission                   | permission ledger                         | consume; never effect state               |
| Visual mention/memory        | visual state                              | contact does not write                    |

“Ruled — unbuilt” rows follow the 2026-08-22 body-surface ownership ruling
below: the owner is designated, but the expansion does not exist in code yet,
so contact still cannot commit these effects.

## Body-surface wetness correction

The previous design treated regional moisture as broadly unowned. That is no
longer accurate.

`BodySurfaceState` already stores wetness by body location, and visual state now
projects non-dry whole-body wetness with deterministic story-clock drying and
precipitation hold behavior.

Therefore:

- contact phenomena may consume authoritative body wetness where the lane
  supplies it;
- contact must not create a second moisture store;
- product/residue composition is still missing and must not be inferred from
  wetness alone;
- known dry and unavailable remain different.

## Body-surface ownership ruling (2026-08-22)

`BodySurfaceState` expands into the authoritative owner for current material
and temporary condition on skin and hair: wetness (already owned), surface
products/residues/deposits, and temporary contact marks, all keyed by body
locus. Contact may propose mutations to that state; it never owns or persists
them. Visual state remains a read/projection consumer.

Structure: the eventual split is by module — wetness, deposits/residue, and
marks — inside the one body-surface state domain. Do not create a separate
subsystem per family, and do not put any of it in contact.

Scratch/skin damage is not covered by this ruling and still has no designated
owner.

## Conserved surface transfer

Owner ruling (2026-08-22): transfer is the **second** persistent effect proof,
not the first — the temporary pressure mark below goes first. A proper transfer
must subtract material from the source, add it to the destination (possibly to
an intermediate garment instead of skin), preserve the amount, commit both
sides atomically, survive retry without doubling, and reverse both sides
together on retake. That breadth makes it a strong second proof and too much
architecture for a first one.

A valid proposal requires:

- committed contact path;
- actual transferable source material;
- compatible source/target or intermediate material layer;
- enough pressure/motion/permeability for the proposed band;
- exact source amount/band and target locus;
- no assumption that contact itself created a transferable substance.

The owner transaction must atomically apply source removal and target/intermediate
deposition under one idempotency key.

Required laws:

- retry cannot transfer twice;
- retake removes both sides or neither;
- conservation holds within the semantic/fixed-point representation;
- an intermediate garment receives the material when permeability/path says it
  does, rather than teleporting it to skin;
- the resulting observation appears only after commit.

If a body residue owner is still absent, keep transfer fixture-only or choose a
garment-to-garment proof whose existing owner can complete the transaction.

## Temporary marks and scratches

Owner ruling (2026-08-22): the temporary pressure mark is the **first**
end-to-end effect commit proof — one state owner (the expanded
`BodySurfaceState`), one target locus, one causal event, one idempotency key,
one expiry/decay rule, and no physiology requirement. It still proves the full
commit -> retry -> retake -> subsequent-read chain, which is what the first
proof exists to exercise.

A pressure mark/scratch needs a body-state owner with:

- locus;
- kind;
- magnitude/band;
- cause/event ref;
- created story time;
- owner-defined expiry/decay semantics;
- retake/prune behavior.

Contact may calculate that a mark is possible; it may not keep a hidden timer or
expose the mark until that owner commits it.

Visual state already records `contact_marks` as an unsupported current-state
family, which is the correct behavior until this owner exists.

## Garment operations

Contact does not directly edit garment state.

A contact-induced garment change is a typed wardrobe operation, for example:

- displace a named part;
- open/close a closure;
- roll/tuck/untuck only when an explicit action actually does so;
- deposit material;
- damage a named part.

The wardrobe owner validates current state and commits. Visual state then reads
the new garment truth through its existing adapter.

A touch cannot silently undress somebody, move a blocking layer, or create
intimate exposure as an “implicit adjustment.”

## Nonvisual sensory presentation owner — required before live cues

Contact needs tactile/scent/taste eventually, but the presentation architecture
should be shared across domains.

Owner ruling (2026-08-22): this owner is sibling package(s) beside visual
state, not a generalization of visual state's attention/memory contracts —
scent, taste, tactile, and aural feedback share the same broad laws but operate
differently enough to own their own contracts. For testing, nonvisual
presentation may stay bundled beside the visual presentation code, explicitly
marked as temporary; the bundling is removed when the sibling owners are
created. Live narrator cues still wait for the real owner.

The future owner should preserve the same broad laws visual state now proves:

- observer identity;
- channel-specific access;
- notice versus mention separation where meaningful;
- novelty/change/relevance ranking;
- stable repeat families;
- bounded consumer budgets;
- retake/branch restoration;
- no prompt prose until after perception/selection.

Examples of channel-specific gates:

### Tactile

- observer must participate in the qualifying committed contact;
- material transmission preserved;
- locus/path preserved;
- temperature/texture requires actual source reads.

### Olfactory

- current contributor/source;
- distance/exposure/permeability;
- airflow/environment where required;
- no “odorless/clean” claim from missing data.

### Gustatory

- explicit direct oral contact with the qualifying surface/material;
- appropriate policy/action scope;
- real source contributors;
- no taste from proximity alone.

This owner is **not** part of visual state’s first-release scope and should not be
forced into it solely for contact.

## Effect/observation pipeline

```text
committed contact + current owner reads
        |
        v
pure contact phenomenon
        |
        +--> channel-tagged observation candidate
        |
        +--> effect proposal
                  |
                  v
           owner transaction
                  |
                  v
           committed current state
                  |
                  v
          later observation read
```

A phenomenon may emit both a current observation and an effect proposal, but the
proposal's result cannot be observed in the same cut unless the owning
transaction has actually committed and the consumer is reading the post-commit
cut.

## Retake/replay

There is no contact-owned presentation snapshot.

Replay determinism requires:

- same restored contact/body/wardrobe/environment cut -> same pure phenomena;
- same committed effect event -> same resulting owner state;
- duplicate event id -> no duplicate mutation;
- retake prune/restoration -> discarded effect disappears;
- visual state recomputes from restored truth and restores its own cue memory;
- future nonvisual sensory memory restores under its own owner.

## First implementation order

1. Keep current visual contact continuity (hand occupation + motion) as-is.
2. Add the visual-state contact-relation feature before adding rich positive
   visual contact prose.
3. Define a small channel-tagged contact phenomenon contract in pure code.
4. Route only `visual` observations into visual state; add a leak test proving
   nonvisual channels cannot reach that adapter.
5. Build the smallest required owner slice — temporary marks in the expanded
   `BodySurfaceState` — and prove the pressure mark end-to-end first; conserved
   transfer follows (owner ruling 2026-08-22).
6. Add the owner transaction with idempotency/retake tests.
7. Let visual state observe the committed result when visually applicable.
8. Build the shared nonvisual sensory sibling owner(s) before promoting
   tactile/olfactory/gustatory cues into live narration.
9. Register only domain phenomena whose complete source -> commitment ->
   perception path is supported.

## Required tests

### Channel leakage

- tactile texture cannot become a visual-state feature;
- scent cannot become a visual-state feature;
- gustatory fact cannot become a visual-state feature;
- visual contact observation can enter visual-state visibility/selection;
- hidden visual observation remains absent from narrator/image consumer output.

### Presentation ownership

- no contact-specific visual memory/cooldown state;
- no contact-specific visual ranking changes visual-state selection;
- retake restores visual cue state through the visual owner;
- contact truth remains active even when visual-state narration is disabled.

### Effects

- proposal is not current truth;
- transfer conserves source/target and is idempotent;
- failed/rolled-back transaction exposes no result;
- mark absent before owner commit and present after commit;
- expired/cleared mark disappears according to owner state, not contact memory;
- garment operation goes through wardrobe validation;
- a blocked layer cannot be implicitly moved by the effect path.

### Mechanics/source discipline

- no committed contact -> no contact-derived phenomenon;
- no relative motion -> no glide;
- no authoritative moisture/product -> no slippery claim;
- unavailable != dry/clean/odorless;
- physical observation never becomes emotion, pleasure, consent, or reaction.
