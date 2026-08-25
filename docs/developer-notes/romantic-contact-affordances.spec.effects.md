# Romantic contact affordances — observations, effects, and sensory routing

Status: **implementation stages 1–6 built 2026-08-22 — the effect-commit leg
waits on its default-off switch (`CHAT_CONTACT_EFFECTS`); stages 7–9 remain.**
This spec replaces the older contact-specific perception/ranking design. Visual state owns visual perception,
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
| Full visual source-locus -> target-locus contact relation | Built 2026-08-22 (`body_language.contact_relation`) |
| Channel-tagged contact phenomenon contract | Built 2026-08-22; no producer emits phenomena yet |
| Body-surface wetness owner | Live |
| Body-surface residues/deposits/products | Owner designated 2026-08-22; not built |
| Temporary contact marks | Built 2026-08-22 inside the body-surface owner |
| Pressure-mark first end-to-end proof | Built 2026-08-22 behind default-off `CHAT_CONTACT_EFFECTS` |
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
| Pressure/contact mark | body-surface state — marks module built 2026-08-22 | propose; body-surface validates/commits (flag-gated) |
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

Current contact-side routing contract (built 2026-08-22 in
`contracts/affordances/contact/phenomena.ts`):

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
  locus: ContactBodySurfaceRef;
  targetLocus?: ContactSurfaceRef;
  intensityBand: "subtle" | "clear" | "strong";
  semanticTags: readonly string[];
  repeatFamily: string;
  evidence: readonly AffordanceEvidence[];
}
```

The loci deliberately use the contact core's own surface refs rather than a bare
body-locus token: a two-body phenomenon needs the subject identity, the refs
resolve to the same registry ids, and it keeps contact inside its documented
import surface. This contract is structured data, never prose. There is no zod
boundary schema yet because no producer emits phenomena and nothing persists
them; the schema is added when proposals gain persistence.

The router is `routeContactPhenomena(observations, sink?)`: visual candidates
come back as adapted `AffordanceObservation` values grouped by subject, and
every nonvisual candidate becomes a payload-free suppression with
`CONTACT_CHANNEL_UNROUTED` (`info`, designed withholding); an unknown channel
fails closed into the withheld set with `CONTACT_CHANNEL_INVALID` (`error`). A
type-level tripwire keeps the channel-tagged contract from ever becoming
assignable to `AffordanceObservation` unnoticed.

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

### First-class visual contact relation — built 2026-08-22

The gap is closed: `body_language.contact_relation`
(`VISUAL_STATE_BODY_LANGUAGE_CONTACT_RELATION_KIND_ID`, registered in
`contracts/visual-state/kinds.ts`) is projected from `CommittedContactRead` by
`projectContactRelations` in `contracts/visual-state/body-language.ts`, beside —
not touching — hand occupation and motion. Build decisions the slice settled:

- The value carries the action kind, source subject + locus, target (body arm or
  object arm), and `materialBetween` as `{directSkinContact, layerIds}` — the
  committed transmission's visually relevant half, always owner-backed. It
  deliberately excludes pressure, motion, policy, actor control, and target
  agencies, and the contact's resolution evidence trail is not merged into the
  feature because that trail names the permission reads.
- The contact id rides the relation locus plus a `contact` sourceRef (the motion
  pattern); lifecycle provenance rides evidence as the two event refs.
- The feature files under **both** mapped body participants (actor first):
  perception resolves per subject, and only the primary character has an
  exposure owner in this lane, so actor-only filing would hide every
  player-initiated touch from the only selection that runs.
- `narratorEligible: true` behind the existing per-chat visual-state narration
  switch; `imageEligible: false` because the cast-1 scene digest consumes image
  selection live and ungated, so admitting the kind there is a later deliberate
  enable; `recognitionEligible: false`.
- The narrator clause renders as a verbless noun phrase, and only "your"/the
  possessive may name a participant — an un-nameable participant yields silence,
  never an id in prose.

The original requirements, which the build satisfies, were that it carry:

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
- surface products — remaining;
- residue/deposits, including dirt/blood/cosmetics — **built 2026-08-25** as a
  deposits module inside `contracts/state/body-surface.ts` (see below);
- temporary pressure/contact marks — **built 2026-08-22** as a marks module
  inside `contracts/state/body-surface.ts` (see §8 for the shape).

The internal implementation may split by modules such as wetness,
deposits/residue, and marks, but these remain one body-surface state domain. Do
not create separate contact-local stores or one subsystem per aftermath family.
The built marks module follows this: it lives beside wetness under the one
`BodySurfaceState`, keyed by idempotency identity, with the same fixed-point,
read-never-mutates, and per-entry quarantine laws — and the `marks` key is
absent until the first commit and dropped when the last mark prunes, so a
flag-off row persists byte-identical to before the module existed.

Contact may consume authoritative body-surface reads and propose mutations to
that owner. Visual state remains a read/projection consumer.

Current rules, with residue now owned and surface products still not:

- contact may consume body wetness and body deposits where the lane supplies
  them;
- contact must not create a second moisture or residue store;
- product composition may not be inferred from wetness or from a deposit;
- missing surface-product support remains unavailable;
- known dry is not the same thing as unavailable, and neither is known clean.

Scratch/skin damage is **not** included in this ruling and still has no owner.

### Built shape — deposits, 2026-08-25

Ungated, and that is a ruling rather than an omission: material on skin is
ordinary authoritative body state exactly as wetness is, and putting it behind
the contact-effects switch would make "she still has mud on her hands"
unrememberable for the continuity system that has nothing to do with contact.
Only the contact-derived transfer producer belongs behind that flag.

- **Shared vocabulary** — `contracts/materials/surface-deposits.ts`, imported by
  both surface owners: substance kinds (`mud`, `blood`, `dust`, `food`, `paint`,
  `cosmetic`, `unknown`), the amount bands, the freshness bands, and the
  45-story-minute freshness half-life. The garment store's `garmentDeposit*`
  names are now aliases of these, so mud on a sleeve and mud on the forearm
  beneath it cannot be different nouns. `unknown` is a real member, not a parse
  failure — something is on the surface and nobody committed what.
- **Owner state** — deposits module in `contracts/state/body-surface.ts`:
  `bodySurfaceDepositSchema` (location, kind, fixed-point amount, creation
  minute, free-text cause), keyed by the deterministic
  `dep:<kind>:<location>:<minute>` identity so a replayed exchange lands on the
  key it already wrote. `commitBodySurfaceDeposit` raises rather than stacks,
  `reduceBodySurfaceDeposits` is the only shrink, `bodySurfaceDepositAt` is the
  lazy freshness read, and per-entry quarantine, the 12-entry bound, and the
  absent-until-first-commit key rule all follow the marks module.
- **The one law that is not the marks module's** — material does not leave on
  its own. Wetness dries and marks fade because a surface is returning to its
  resting state; a deposit is a substance, and a surface that quietly cleaned
  itself would be an unowned sink, which is exactly what §9's conservation
  requirement must be able to rely on not existing. Only an explicit removal
  shrinks a deposit. Freshness moves with the clock and is phrasing only.
- **Producer** — the continuity extraction leg's `surfaceDeposits` field
  (`contracts/turns/chat-surface-ops.ts`), an add/remove direction plus a
  three-step degree over the everyday body locations. The intimate sub-tree is
  excluded by construction: it is gated per character, and recording material
  there would need that gate honoured on every read first. An unrecognised
  substance degrades to `unknown` and still commits; an unowned location drops
  with `chat_surface.location_unknown`; a full record refuses with
  `chat_surface.deposit_capacity` rather than reporting a silent no-op.
- **Persistence** — the deposits fold runs at settle in `finalizeChatState`,
  between the wetness fold and the contact-effects transaction, so all three
  modules land in one state value under one rollback anchor and a retake
  restores them together.
- **Visual read** — `body_surface.deposit`, the heaviest deposit per location as
  one banded current-layer feature carrying substance, amount, and freshness. It
  is the one feature family with no `validUntilMinutes`, for the law above. The
  narrator clause reuses the garment-deposit wording verbatim. `imageEligible:
  false` and `recognitionEligible: false`, the same deliberate-enable caution as
  the contact relation and the pressure mark; `narratorEligible: true` is the
  point of the slice. The `contamination` suppression rows `dirt_on_skin` and
  `blood_on_skin` are retired accordingly. `cosmetics_wear` **stays** — a
  cosmetic deposit is makeup material present on a surface, while that row is
  makeup coming off, which is the degradation of a deliberate presentation and
  still has no owner.

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

### Built shape — 2026-08-22

The proof is built end to end, gated by `chatContactEffectsEnabled()`
(`CHAT_CONTACT_EFFECTS === "on"` **and** the contact-actions flag; default off,
and with contact actions off nothing runs regardless):

- **Proposal contract** — `contracts/affordances/contact/effects.ts`:
  `ContactEffectProposal` is a deliberately single-member union over
  `BodyMarkProposal` (it grows when another owner path actually ships; no
  speculative stubs). The pure producer is
  `contactMarkProposals(contact: CommittedContactRead)`.
- **Qualifying evidence** — committed pressure `moderate -> "clear"` or
  `firm -> "strong"`, **and** `transmission.directSkinContact === true`, body
  target only. Unstated pressure proposes nothing (unknown is not trace);
  through-material proposes nothing, because filtering coarse transmission
  values into a material-pressure model would be the pretend physics the
  contact core forbids; trace/light never mark.
- **Idempotency key** — `"body_mark"` + contactId + `lastUpdatedByEventRef`
  under the contact core's own separators. A retake replays to the same key
  (structural no-op); a later contact update committing qualifying pressure is
  a new physical event with a new key.
- **Owner state** — marks module in `contracts/state/body-surface.ts`:
  `bodySurfaceMarkKinds = ["pressure"]` (closed; a stored `"scratch"`
  quarantines), bands subtle/clear/strong at write magnitudes
  2 500/5 000/10 000, `commitBodySurfaceMark`, lazy-fade read
  `bodySurfaceMarkAt`, `pruneFadedBodySurfaceMarks`, per-entry quarantine,
  bounds (16 marks, key <= 512 chars).
- **Decay law** — flat 20 000 fixed-point units per story hour toward gone,
  anchored at `createdAtMinutes` and never restamped: strong fades fully in 30
  story minutes, clear in 15. Committed pressure tops out at `firm` — a
  transient non-injuring imprint — and the flat rate mirrors the wetness
  precedent because no authoritative skin-material axis exists to scale by.
  Read bands: strong >= 8 000, clear >= 4 000, subtle >= 1.
- **Transaction** — `applyBodyMarkProposals` in
  `contracts/turns/chat-contact-effects.ts` (in `turns/` so import direction
  stays contact -> state, never state -> contact), refusing with
  `contact_effects.kind_unsupported` / `locus_unknown` / `key_invalid` /
  `capacity` / `owner_unavailable`; at most `CHAT_CONTACT_EFFECT_MAX = 4`
  proposals per turn.
- **Pipeline** — proposals derive only from an acknowledged durable contact
  commit inside the existing contact leg (a rolled-back append derives
  nothing), are filtered to the primary character's body (any other target
  refuses with `owner_unavailable` — ensemble/player surface owners do not
  exist), and commit at settle inside `finalizeChatState`, so the mark rides
  the state row's one rollback anchor and is observable from the **next** cut
  only. Retake restoration is inherited from the pre-exchange snapshot — no new
  prune machinery.
- **Visual read** — committed marks project through the existing
  body-surface current-state adapter as `body_surface.contact_mark`
  (strongest unfaded mark per location, one banded feature; quarantined slots
  become suppressions). The former `contact_marks` unsupported-family row is
  retired. The read side is unconditional — the flag gates writes — so with the
  flag off no marks exist and snapshots are unchanged. `imageEligible: false`
  and `recognitionEligible: false`, same deliberate-enable caution as the
  contact relation.

Pressure mark and scratch are not synonyms. The first proof covers a temporary
contact mark; scratch/skin damage remains blocked on a future owner, is not a
member of the mark-kind vocabulary, and a stored scratch entry quarantines
rather than reads.

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
   contact-motion projection unchanged. Built 2026-08-22 — the diff on both
   paths is purely additive.
2. **Add the first-class visual contact relation** from `CommittedContactRead`
   before claiming rich positive visual contact narration. Built 2026-08-22
   (§5).
3. **Define the small channel-tagged phenomenon seam** in pure contact code.
   Built 2026-08-22 (§3); no producer emits phenomena yet.
4. **Route only visual candidates into visual state** and add a leak test proving
   nonvisual channels cannot reach that adapter. Built 2026-08-22 (§3, §16).
5. **Expand `BodySurfaceState` for temporary marks** and build the pressure-mark
   owner transaction. Built 2026-08-22 (§8).
6. **Prove pressure mark end to end**: commit, duplicate retry, retake, later
   read, and visual projection where applicable. Built 2026-08-22 — proven by
   the §16 suites; the commit leg waits on its default-off switch.
7. **Add residue/deposit support**, so a body can carry material at all. Built
   2026-08-25 (§7) — vocabulary, owner, extraction producer, settle fold and
   visual projection, ungated.
8. **Add conserved transfer** as the second proof, including atomic
   source/destination conservation. Remaining, and **fixture-only when it
   lands**, under §9's own escape clause. Owner ruling (2026-08-25): no live
   pairing has two implemented owners today, and three separate things would
   each have to change first —
   - the player and ensemble members have no body-surface owner, so every
     committed contact in the chat lane runs from an unowned surface to an owned
     one, and conservation needs both sides;
   - the chat lane's contact layers carry a coverage-region identity rather than
     a garment one and report zero moisture transmission, so contact cannot
     address the wardrobe owner or justify moving material through a layer —
     and `absorbency` is not the missing number, because it says how much water
     a fibre takes up from a wetting source, not what passes through it;
   - skin and garments persist to two different rows with no enclosing
     transaction, so a cross-owner transfer cannot satisfy the atomicity law
     until the settle path changes.

   Garment-to-garment transfer would sidestep all three, because both sides live
   in one JSONB value — and it is explicitly not the proof, per §9's own warning
   against using a partial owner path to claim the general problem is solved.
9. **Build modality-specific sensory sibling owners** before promoting tactile,
   olfactory, or gustatory cues to live narration. Remaining.
10. **Register only domain phenomena whose complete source -> commitment ->
    perception path exists.** Unsupported foot/intimate phenomena remain
    fixture-only. Remaining.

The pressure-mark visual read is deliberately a **later-cut read of committed
body-surface state**, not a phenomenon producer: §16's first proof requires the
observation to read committed mark state only, and stage 10 forbids registering
a phenomenon before its complete path exists. The routing seam therefore still has
no producer, and the pressure-mark path does not use it.

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

### Body-surface deposits

- material does not shrink on the story clock — only an explicit removal does;
- a removal naming a substance leaves the other substances at that location;
- a corrupt slot quarantines rather than dropping, so absent still means clean;
- one module emptying out does not discard a sibling module's record;
- an unrecognised substance commits as `unknown` rather than losing the fact;
- a location outside the owned everyday set is refused with its stable code;
- a full record reports the refusal rather than a silent no-op;
- the projected feature carries no expiry window.

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