# Romantic contact affordances — observations, effects, and sensory routing

Status: **architecture reconciled through the 2026-08-22 owner rulings; no
contact-effects slice is live yet.** This spec replaces the older
contact-specific perception/ranking design. Visual state owns visual perception,
attention, repetition, memory, and narrator/image selection. Contact owns pure
physical phenomenon resolution and effect proposals. Persistent aftermath is
owned by body/wardrobe/etc. state owners, and nonvisual presentation waits for
its future sensory owners.

**Plan:** [romantic-contact-affordances.plan.md](romantic-contact-affordances.plan.md)  
**Technical component:** `contact phenomenon/effect proposal contracts + channel routing`  
**Primary owner:** contact owns physical candidates/proposals; each destination state owner owns the committed result  
**Primary integration:** `committed contact + current owner reads -> pure phenomenon -> owner transaction -> later perception`  
**Model/dependency:** deterministic in-app logic; no model/provider is required for effect resolution or routing  
**Core dependency:** [shared contact core](romantic-contact-affordances.spec.contact-core.md)

---

## 1. Purpose and the three-layer boundary

Three concepts must remain separate:

1. **Physical observation candidate** — a structured consequence of already
   committed contact/current state, tagged with the sensory channel through
   which it could be perceived.
2. **Effect proposal** — a requested mutation such as a pressure mark,
   transferred residue, scratch, or garment operation.
3. **Presented cue** — a perception/attention owner has decided that a specific
   observer can perceive an already-true fact and that the fact is worth
   offering to a narrator/image/other consumer.

Contact owns 1 and may propose 2. The appropriate state owner validates and
commits 2. Visual state or a future modality-specific sensory owner decides 3.

A proposal is not truth. A physical observation candidate is not automatically
visible or worth mentioning. A presented cue may only describe truth that has
already committed.

Current delivery state:

| Responsibility | State |
| --- | --- |
| Contact-derived hand occupation in visual state | Live |
| Contact-motion bands in visual state | Live |
| Generic visual affordance-observation bridge | Live for supported visual facts |
| Full visual source-locus -> target-locus contact relation | Not built |
| Channel-tagged contact phenomenon contract | Specified; effect slice not live |
| Body-surface wetness owner | Live |
| Body-surface residues/deposits/products | Owner designated 2026-08-22; not built |
| Temporary contact marks | Owner designated 2026-08-22; not built |
| Pressure-mark first end-to-end proof | Chosen 2026-08-22; not built |
| Conserved transfer | Second proof; not built |
| Scratch/skin damage | No owner yet |
| Tactile/olfactory/gustatory presentation | Future sibling sensory owners; not live |

---

## 2. Ownership map

Contact effects deliberately do **not** create a second state system.

| Effect/current fact | Authoritative owner | Contact role |
| --- | --- | --- |
| Active contact | contact lifecycle | commit/read directly |
| Body-surface wetness | body-surface state | consume; may propose owner-committed change when supported |
| Body residue/product/deposit | body-surface state — owner ruled, expansion unbuilt | propose only; cannot commit yet |
| Dirt/blood/cosmetics on skin | body-surface state — owner ruled, expansion unbuilt | propose only; cannot commit yet |
| Pressure/contact mark | body-surface state — owner ruled, expansion unbuilt | propose only; cannot commit yet |
| Scratch/skin damage | **missing owner** | proposal only; cannot commit |
| Garment wetness/condition | wardrobe/garment condition | consume/propose mutation |
| Garment deposit | wardrobe/garment state | propose; wardrobe commits |
| Garment displacement/closure | wardrobe operation | propose; wardrobe validates/commits |
| Physiology/swelling/flush | future physiology/body-state owner | consume only after owner exists |
| Permission | permission ledger | consume elsewhere; never effect state |
| Visual mention/memory | visual state | contact never writes |
| Tactile/scent/taste notice/mention | future modality-specific sensory owners | contact never writes |

“Owner ruled, expansion unbuilt” means the owning domain is settled but the
mutation/read contract does not yet exist. Contact must still behave as though
that effect is unavailable until the owner is implemented.

---

## 3. Channel-tagged physical observations

The shared `AffordanceObservation` contract is channel-neutral in its existing
domains, while the current visual-state adapter reasonably assumes that values
handed to it are visual candidates. Contact spans multiple senses, so contact
must preserve the channel **before** that adapter boundary.

Current contact-side routing contract:

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

Routing law:

```text
ContactPhenomenonObservation
        |
        +-- visual ----------> visual-state observation/feature adapter
        |
        +-- tactile ---------X  future tactile presentation owner
        |
        +-- olfactory -------X  future olfactory presentation owner
        |
        +-- gustatory -------X  future gustatory presentation owner
```

Only `channel: "visual"` may adapt into the current
`VISUAL_STATE_AFFORDANCE_OBSERVATION_KIND_ID` path. Tactile, olfactory, and
gustatory candidates remain pure/diagnostic results until their own presentation
owners exist. They must never be smuggled into visual state, the retired
contact-affordance cue block, or a new contact-local narrator block.

---

## 4. Sensory architecture ruling — modality-specific contracts

Owner ruling (2026-08-22): **do not widen `AffordanceObservation` with a sensory
channel merely because contact spans multiple senses.**

Vesper treats visual, auditory, tactile, olfactory, and gustatory perception as
distinct sensory subsystems under a shared presentation architecture. The
senses share broad laws, but their access/perception rules are different enough
to own separate observation contracts.

Therefore:

- authoritative domain state may emit a **channel-tagged routing envelope**;
- a common routing envelope may retain a channel discriminant;
- visual facts adapt into visual observation contracts;
- tactile facts adapt into tactile observation contracts;
- olfactory facts adapt into olfactory observation contracts;
- gustatory facts adapt into gustatory observation contracts;
- auditory is part of the wider sensory architecture even though the current
  contact phenomenon vocabulary above does not yet emit an auditory channel;
- modality-specific observation contracts are never collapsed into one generic
  cross-sensory observation type;
- any future change to the shared affordance contract must be designed across
  domains, not justified by contact alone.

Visual state stays explicitly visual. The future sensory packages are **siblings
beside it**, not a generalization that turns visual state into every sense.

Until those sibling owners exist, nonvisual contact phenomena may be computed in
pure fixtures/diagnostics but must not reach live narrator prompts.

---

## 5. Visual presentation remains visual-state work

The following older contact-spec concepts are retired and must not return:

- contact-owned visual perception scoring;
- `ContactMentionPriority` or another contact-specific ranking formula;
- separate contact visual cooldowns;
- separate `lastObservedAt`, `lastOfferedAt`, `lastRealizedAt` memory;
- `ContactPresentationCapture` with selected cue ids/repeat keys;
- a contact-specific visual narrator renderer.

Visual state already owns:

- per-subject visibility/exposure;
- occlusion and composition;
- visual attention ranking;
- observer notice/mention state;
- repeat families and cooldowns;
- selection budgets;
- narrator/image/inspector digests;
- retake-safe visual cue state;
- the single chat visual-state narrator adapter.

A contact visual observation therefore supplies only stable structured truth and
identity; visual state decides whether a particular observer can resolve it and
whether it should be offered to a consumer.

### Current contact -> visual-state bridge

The current code already consumes committed contact in two explicit ways:

1. body-language projection derives hand occupation from active contacts;
2. body-language projection emits committed contact-motion bands such as
   still/pressing/sliding.

The generic visual-state affordance-observation adapter can additionally consume
resolved **visual** `AffordanceObservation` values and carry their phenomenon
repeat key into visual-state selection.

These are useful continuity signals, but they do not encode the whole relation.

### Gap — first-class visual contact relation

Before rich positive contact narration is considered complete, add a visual-state
kind/adaptor sourced directly from `CommittedContactRead`, conceptually such as
`body_language.contact_relation` (final naming belongs to visual-state).

It must carry:

- contact id/relation identity;
- source participant id + source body locus;
- target participant id + target body/object locus;
- action kind only where useful for relation identity, never as permission
  disclosure;
- visually relevant material-between information only where wardrobe/visibility
  owners support it;
- lifecycle provenance and change timestamp.

It must **not** carry:

- hidden permission state;
- inferred emotion;
- pleasure;
- tactile texture;
- rejected/uncommitted alternatives.

Visibility stays observer-specific. Contact may be physically active even when
an observer cannot see one or both surfaces.

---

## 6. Effect proposal contract

Conceptual union:

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
- exact locus or garment part;
- semantic magnitude/band;
- source material/condition evidence;
- contact/path/pressure/motion evidence;
- story time;
- no narrator text.

A proposal does not mutate anything merely because contact calculated it. The
receiving owner validates current state and either commits its own transaction or
refuses/degrades according to that owner's law.

---

## 7. Body-surface state — owner ruling 2026-08-22

The earlier design treated regional body moisture and aftermath ownership too
loosely. That is no longer accurate.

`BodySurfaceState` already owns whole-body wetness by body location. Visual state
projects non-dry wetness with deterministic story-clock drying and precipitation
hold behavior. Known dry and unavailable remain distinct.

Owner ruling: expand that **same body-surface domain** into the authoritative
owner for current material and temporary condition on skin/hair:

- wetness — already implemented;
- surface products;
- residue/deposits, including dirt/blood/cosmetics where represented;
- temporary pressure/contact marks.

The internal implementation may split by modules such as wetness,
deposits/residue, and marks, but these remain one body-surface state domain. Do
not create separate contact-local stores or one subsystem per aftermath family.

Contact may consume authoritative body-surface reads and propose mutations to
that owner. Visual state remains a read/projection consumer.

Current rules until the expansion exists:

- contact may consume body wetness where the lane supplies it;
- contact must not create a second moisture store;
- residue/product composition may not be inferred from wetness;
- missing residue/product/mark support remains unavailable;
- known dry is not the same thing as unavailable.

Scratch/skin damage is **not** included in this ruling and still has no owner.

---

## 8. First effect proof — temporary pressure mark

Owner ruling (2026-08-22): the **temporary pressure mark is the first
end-to-end persistent contact-effect proof.**

Reason: it is the smallest owner transaction that still exercises the complete
architecture without requiring physiology:

```text
committed contact
      |
      v
BodyMarkProposal
      |
      v
expanded BodySurfaceState owner transaction
      |
      v
committed temporary mark at one body locus
      |
      +--> retry proves no duplicate mutation
      +--> retake proves restoration/removal
      +--> later read proves post-commit observability
```

The first mark owner needs at least:

- body locus;
- mark kind;
- semantic magnitude/band;
- cause/event reference;
- creation story time;
- owner-defined expiry/decay semantics;
- idempotency identity;
- retake/prune behavior.

Contact may calculate that a pressure mark is possible; it may not persist the
mark, own a hidden expiry timer, or expose it before the body-surface owner
commits it.

Visual state already records `contact_marks` as an unsupported current-state
family. That remains correct until the body-surface mark owner is live.

Pressure mark and scratch are not synonyms. The first proof covers a temporary
contact mark; scratch/skin damage remains blocked on a future owner.

---

## 9. Second effect proof — conserved surface transfer

Owner ruling (2026-08-22): **conserved transfer follows the pressure mark.** It
is a stronger second proof precisely because it spans more ownership and
transactional behavior.

A valid transfer proposal requires:

- committed contact path;
- a real transferable source material;
- compatible source/target or intermediate material layer;
- enough pressure, motion, and permeability for the proposed band;
- exact source amount/band and target locus;
- no assumption that contact itself created the transferable substance.

The owner transaction must atomically apply source removal and target/intermediate
deposition under one idempotency key.

Required laws:

- retry cannot transfer twice;
- retake removes both sides or neither;
- conservation holds within the chosen semantic/fixed-point representation;
- an intermediate garment receives material when path/permeability says it does
  rather than teleporting it to skin;
- the resulting observation appears only after commit.

This two-sided conservation requirement is why transfer is not the first proof.

If the destination body-residue owner is not yet implemented, keep transfer
fixture-only. A garment-to-garment transfer may eventually be a useful proof only
where the existing garment owner can complete both sides honestly; do not use a
partial owner path to pretend the general body transfer problem is solved.

---

## 10. Garment operations

Contact never directly edits garment state.

A contact-induced garment change is a typed wardrobe operation, for example:

- displace a named part;
- open or close a closure;
- roll/tuck/untuck only when an explicit action actually does so;
- deposit material;
- damage a named part where the wardrobe owner supports it.

The wardrobe owner validates current state and commits. Visual state then reads
the resulting garment truth through the existing adapter.

A touch cannot silently undress another participant, move a blocking layer, or
create intimate exposure as an “implicit adjustment.” Clothing manipulation and
nudity exposure remain separate action/permission work under the permission
spec.

---

## 11. Future nonvisual sensory owners

Tactile, olfactory, and gustatory contact cues need presentation owners shared
across domains, not contact-specific copies.

Those sibling owners should preserve the broad laws visual state already proves:

- observer identity;
- modality-specific access;
- notice versus mention separation where meaningful;
- novelty/change/relevance ranking;
- stable repeat families;
- bounded consumer budgets;
- retake/branch restoration;
- no narrator prose before perception/selection.

But each modality owns different physical access rules.

### Tactile

- observer must participate in the qualifying committed contact;
- material transmission is preserved;
- locus/path is preserved;
- temperature/texture requires real owner reads;
- visual exposure is irrelevant to tactile access unless some shared material
  state independently affects both.

### Olfactory

- a real current contributor/source must exist;
- distance, exposure, and permeability matter;
- airflow/environment is required where the phenomenon depends on it;
- missing source data can never produce “odorless” or “clean.”

### Gustatory

- requires explicit compatible direct oral contact with the qualifying
  surface/material;
- requires the applicable action/permission scope;
- requires real source contributors;
- proximity alone never creates taste.

These owners are not part of visual state's scope and must not be forced into
visual-state merely because that subsystem already has attention/memory code.

---

## 12. Effect/observation integration path

The required path is:

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
                  |
        +---------+-------------------+
        |                             |
        v                             v
  visual-state path          future sensory sibling path
```

A phenomenon may emit both a current observation and an effect proposal. The
**result of the proposal** cannot be observed in the same cut unless the owner
transaction has actually committed and the consumer reads the post-commit cut.

Contact never promotes a proposed aftermath directly into narration.

---

## 13. Retake, retry, and replay

There is no contact-owned presentation snapshot.

Replay determinism requires:

- same restored contact/body/wardrobe/environment cut -> same pure phenomena;
- same committed effect event -> same resulting owner state;
- duplicate event/idempotency identity -> no duplicate mutation;
- retake prune/restoration -> discarded effect disappears;
- visual state recomputes from restored truth and restores its own cue memory;
- future modality-specific notice/mention state restores under its own owner.

Effects therefore join the same single-cut restoration model as contact,
permission, wardrobe, body state, and visual presentation rather than creating a
parallel capture object.

---

## 14. Failure and degradation behavior

Effect work fails closed at every ownership boundary:

- no committed contact -> no contact-derived phenomenon;
- missing required source owner read -> unavailable, not a convenient default;
- proposal without an implemented destination owner -> no commit;
- failed owner transaction -> no observable result;
- duplicate idempotency key -> no duplicate effect;
- rolled-back/retaken effect -> no surviving observation;
- blocked material path -> no teleporting transfer to skin;
- missing residue/product source -> no slippery/dirty/scent/taste claim;
- missing temperature/texture owner -> no tactile temperature/texture claim;
- nonvisual observation -> cannot enter visual-state;
- physical observation -> never becomes emotion, pleasure, consent, desire, or
  expressive reaction.

Unknown remains distinct from dry, clean, odorless, smooth, cool, or any other
positive/negative physical state.

---

## 15. Implementation stages

This order aligns with Track C/D of the parent plan:

1. **Preserve the current visual bridge.** Keep hand occupation and committed
   contact-motion projection unchanged.
2. **Add the first-class visual contact relation** from `CommittedContactRead`
   before claiming rich positive visual contact narration.
3. **Define the small channel-tagged phenomenon seam** in pure contact code.
4. **Route only visual candidates into visual state** and add a leak test proving
   nonvisual channels cannot reach that adapter.
5. **Expand `BodySurfaceState` for temporary marks** and build the pressure-mark
   owner transaction.
6. **Prove pressure mark end to end**: commit, duplicate retry, retake, later
   read, and visual projection where applicable.
7. **Add residue/deposit support and conserved transfer** as the second proof,
   including atomic source/destination conservation.
8. **Build modality-specific sensory sibling owners** before promoting tactile,
   olfactory, or gustatory cues to live narration.
9. **Register only domain phenomena whose complete source -> commitment ->
   perception path exists.** Unsupported foot/intimate phenomena remain
   fixture-only.

Garment changes continue to delegate to wardrobe throughout rather than waiting
for or duplicating body-surface work.

---

## 16. Required tests

### Channel leakage

- tactile texture cannot become a visual-state feature;
- scent cannot become a visual-state feature;
- gustatory fact cannot become a visual-state feature;
- visual contact observation can enter visual-state visibility/selection;
- hidden visual observation remains absent from narrator/image/inspector output;
- adding future modality contracts does not widen the visual observation
  contract implicitly.

### Visual presentation ownership

- hand occupation continues to derive from active committed contact;
- contact-motion bands continue to derive from committed motion;
- the first-class relation carries source/target participant+locus identity;
- no contact-specific visual memory/cooldown store exists;
- no contact-specific ranking bypasses visual-state selection;
- retake restores visual cue state through the visual owner;
- physical contact truth remains active even when visual-state narration is
  disabled.

### Pressure-mark first proof

- no mark exists before owner commit;
- valid committed contact can produce a mark proposal;
- owner commits one mark at the exact target locus;
- retry with the same idempotency identity cannot duplicate it;
- retake removes/restores it with the story cut;
- expiry/decay follows body-surface owner state, not contact memory;
- later visual observation reads committed mark state only;
- scratch/skin damage remains unavailable rather than being smuggled in as a
  pressure mark.

### Conserved transfer second proof

- proposal is not current truth;
- source material must actually exist;
- source removal and destination/intermediate deposition are atomic;
- transfer conserves source/target representation;
- retry cannot transfer twice;
- retake removes both sides or neither;
- failed transaction exposes no result;
- material blocked by a garment cannot teleport to skin;
- intermediate garment receives transfer when permeability/path says it should.

### Garment operations

- contact never mutates garment state directly;
- garment operation passes wardrobe validation;
- blocked layer cannot be implicitly moved by an effect path;
- a contact effect cannot silently undress or create intimate exposure.

### Mechanics and source discipline

- no committed contact -> no contact-derived phenomenon;
- no relative motion -> no glide;
- no authoritative moisture/product -> no slippery claim;
- unavailable != dry/clean/odorless;
- physical observation never becomes emotion, pleasure, consent, or reaction;
- post-effect observation is absent until the owner transaction commits.

### Retake/replay

- same restored cut produces the same pure phenomena;
- duplicate event identity does not duplicate owner state;
- discarded effect disappears on retake;
- contact owns no presentation snapshot;
- future sensory memory, if any, restores through its own owner.

---

## 17. Non-goals and remaining open ownership

This spec does not itself build:

- a second visual-state system inside contact;
- a generic all-senses `AffordanceObservation`;
- live tactile, scent, or taste narrator cues before sibling sensory owners
  exist;
- contact-local residue/mark persistence;
- scratch/skin-damage ownership;
- physiology such as swelling/flush/temperature where no owner exists;
- permission scopes/action producers for intimate or clothing-changing actions;
- implicit wardrobe displacement;
- emotion/pleasure/reaction inference from mechanics.

The 2026-08-22 product questions on **body-surface ownership, pressure-mark-first
proof order, modality-specific sensory siblings, and the observation-contract
channel boundary are closed** by §§4, 7–9. The remaining work is implementation
and the still-genuine missing owners named above.