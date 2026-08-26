# Romantic contact affordances — observations, effects, and sensory routing

Status: **implementation stages 1–8 built — 1–6 on 2026-08-22, the deposits
owner (stage 7) merged to `main` 2026-08-25, conserved transfer (stage 8) built
2026-08-26 and fixture-only. The pressure-mark commit leg waits on its
default-off switch (`CHAT_CONTACT_EFFECTS`); the deposits owner is deliberately
ungated and therefore activates on the next deploy, with no live exchange having
exercised it yet; the transfer transaction needs no switch because no chat-lane
producer reaches it at all. Stages 9–10 remain.**
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

| Responsibility                             | State                                                      |
| ------------------------------------------ | ---------------------------------------------------------- |
| Hand occupation in visual state            | Live, derived from committed contact                       |
| Contact-motion bands in visual state       | Live                                                       |
| Generic visual observation bridge          | Live for supported visual facts                            |
| Full source-locus -> target-locus relation | Built 2026-08-22 (`body_language.contact_relation`)        |
| Channel-tagged phenomenon contract         | Built 2026-08-22; no producer emits phenomena yet          |
| Body-surface wetness owner                 | Live                                                       |
| Body-surface residues/deposits             | Built 2026-08-25, ungated; no live exchange has run it     |
| Body-surface surface products              | Owner designated 2026-08-22; not built                     |
| Temporary contact marks                    | Built 2026-08-22 inside the body-surface owner             |
| Pressure-mark first proof                  | Built 2026-08-22 behind default-off `CHAT_CONTACT_EFFECTS` |
| Conserved transfer second proof            | Built 2026-08-26; fixture-only, no lane can propose one    |
| Scratch/skin damage                        | No owner yet                                               |
| Tactile/olfactory/gustatory presentation   | Future sibling sensory owners; not live                    |

---

## 2. Ownership map

Contact effects deliberately do **not** create a second state system.

| Effect/current fact          | Authoritative owner                       | Contact role                                  |
| ---------------------------- | ----------------------------------------- | --------------------------------------------- |
| Active contact               | contact lifecycle                         | commit/read directly                          |
| Body-surface wetness         | body-surface state                        | consume; may propose a change where supported |
| Body residue/deposit         | body-surface state — built 2026-08-25     | propose; body-surface validates/commits       |
| Surface products on skin     | body-surface state — owner ruled, unbuilt | propose only; cannot commit yet               |
| Pressure/contact mark        | body-surface state — built 2026-08-22     | propose; body-surface commits (flag-gated)    |
| Conserved surface transfer   | body-surface + wardrobe, one transaction  | propose; the transaction settles both sides   |
| Scratch/skin damage          | **missing owner**                         | proposal only; cannot commit                  |
| Garment wetness/condition    | wardrobe/garment condition                | consume/propose mutation                      |
| Garment deposit              | wardrobe/garment state                    | propose; wardrobe commits                     |
| Garment displacement/closure | wardrobe operation                        | propose; wardrobe validates/commits           |
| Physiology/swelling/flush    | future physiology/body-state owner        | consume only after owner exists               |
| Permission                   | permission ledger                         | consume elsewhere; never effect state         |
| Tactile/scent/taste notice   | future modality-specific sensory owners   | contact never writes                          |
| Visual mention/memory        | visual state                              | contact never writes                          |

“Owner ruled, unbuilt” means the owning domain is settled but the mutation/read
contract does not yet exist. Contact must behave as though that effect is
unavailable until the owner is implemented. Surface products are the one
remaining case; residue/deposits left it on 2026-08-25 (§7) and conserved
transfer on 2026-08-26 (§9).

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

The implemented union in `contracts/affordances/contact/effects.ts` has **two**
members, and a family joins it only when its complete proposal -> owner-
transaction path ships: `BodyMarkProposal` (§8) since 2026-08-22, and
`SurfaceTransferProposal` (§9) since 2026-08-26. `ScratchProposal` and a
standalone `GarmentOperationProposal` stay absent rather than stubbed — the
first has no owner at all, and the second waits on the contact -> wardrobe
operation seam. A transfer's intermediate garment leg is **not** an instance of
that second family; see §9.

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
  `reduceBodySurfaceDeposits` is the extraction lane's only shrink,
  `bodySurfaceDepositAt` is the lazy freshness read, and per-entry quarantine,
  the 12-entry bound, and the absent-until-first-commit key rule all follow the
  marks module. Conserved transfer added a second, deliberately separate write
  pair beside these two on 2026-08-26; the reason it is separate rather than a
  mode on these is recorded in §9.
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
  `chat_surface.deposit_capacity` rather than reporting a silent no-op. On a
  removal the substance is OPTIONAL, and absent is not the same answer as
  `unknown`: absent is the wildcard that takes whatever is there, while
  `unknown` is the substance an unrecognised name degrades into. Collapsing the
  two would make wiping the glitter off muddy hands remove the mud with it.
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

A garment-to-garment transfer would be a useful proof only where the existing
garment owner can complete both sides honestly; it is not a substitute, and a
partial owner path must never be used to claim the general body transfer problem
is solved.

### Built shape — 2026-08-26

Built end to end, and **fixture-only**, exactly as the 2026-08-25 owner ruling
at §15 stage 8 said it would be. No chat-lane producer resolves a source
material read or a path, so nothing in production proposes a transfer. Of the
three gaps stage 8 names, the build closes the third — the settle path now has
a conditional atomic boundary — and works around the first two, which is why the
proof stays fixture-only. What it proves is the transaction.

#### Contact is handed the two truths it does not own

All contact knows is that a touch was committed. It does not know what material
stands on the source surface — the body-surface owner holds that, and the import
direction runs the other way — and it does not know what a layer lets through,
which the wardrobe/material owner holds. So
`surfaceTransferProposals({contact, material, path})` in
`contracts/affordances/contact/transfer.ts` takes all three as arguments and
combines them into at most one `SurfaceTransferProposal`. A lane
that cannot answer supplies no read and no path, and therefore proposes nothing.
An **empty** layer list is the meaningful common case — skin on skin, everything
that leaves arrives — and it is not the same as an absent path, which is the
lane saying it cannot answer.

Qualifying evidence follows the pressure mark's own vocabulary: `moderate` and
`firm` committed pressure move a fraction of the standing material, `trace`,
`light`, and unstated pressure move nothing, and unstated is the load-bearing
case because an unknown pressure is not a light one. Relative motion raises the
fraction where it exists (`sliding`, `rolling`, `tapping`) but can never qualify
a transfer alone — a hand resting still on a muddy knee has moved nothing. The
`amount` on the proposal is an intent; the transaction re-reads the source in
its own cut and moves what is actually there.

#### Throughput is resolved path evidence, not a fabric constant

Owner ruling (2026-08-26): a transfer path carries its own per-layer,
per-substance `throughput`, and it is **not** `moistureTransmission`.

Reusing the contact material layer's existing moisture channel was the tempting
move and was rejected. Moisture transmission answers "does dampness reach the
other side"; how much of a substance crosses a layer is a different question
with a different answer per substance, and coupling them would mean that
retuning how cotton carries damp silently retunes how dust travels through it.
`absorbency` is not the number either — it says how much water a fibre takes up
from a wetting source, not what passes through it.

Throughput is the effective answer for *this* material crossing *this* layer
under *this* contact, not a property of a fabric. Its eventual owner is
wardrobe/material path resolution; for the fixture-only proof, fixtures stand in
for that owner.

#### Material is stepped through the path in real units

Owner ruling (2026-08-26): the transaction walks the sorted layers one at a
time, in the units actually being moved, and derives what each layer kept by
**subtraction** from what reached it:

```text
carried_0 = D                                   (what the source actually lost)
carried_(i+1) = floor(carried_i x throughput_i / ONE)
retained_i    = carried_i - carried_(i+1)
destination   = carried_final
```

so `D = sum(retained_i) + destination` holds by construction, with every integer
remainder staying on the layer that failed to pass it. Composing the
coefficients first and applying the amount once floors differently and can lose
a unit into nowhere — harmless for a sensory channel, fatal for material
accounting.

At **zero throughput the layer receives everything**. A blocking layer is not a
force field that keeps material on the original surface; it is the surface being
contacted. "Cannot pass through" and "cannot receive material" are different
claims, and keeping them apart is what makes §16's "blocked material cannot
teleport to skin" a full conservation statement rather than a vacuous one.

#### A transfer gets its own conserving pair on the body-surface owner

Owner ruling (2026-08-26): the existing deposit writers are untouched, and
`takeBodySurfaceDeposit` / `acceptBodySurfaceDeposit` are added beside them in
`contracts/state/body-surface.ts`.

`commitBodySurfaceDeposit` raises to the maximum because "there is mud on her
hands" establishes *at least* that much material, and saying it twice is not a
report that some of it left. `reduceBodySurfaceDeposits` sweeps everything under
the removal floor off every substance at a location because "she washes her
hands" is an explicit sink. Both are the right meaning for the sentence they
compile, and neither is a conserved move. Stretching them until the conservation
tests passed would have quietly changed what the fiction's own sentences mean.

The pair is deliberately different from them:

- `takeBodySurfaceDeposit` reports exactly how much left and **does not inherit
  the removal floor**. Taking 1,000 off a 1,400 deposit leaves 400 standing,
  because 400 units are still on her hand and the shared band reader calls
  anything from 1 upward `slight`. The floor is washing's cleanup policy, where
  the vanished trace goes to a modelled sink. A transfer that swept it would
  destroy the difference between what left and what arrived — the unowned sink
  §7 says must not exist.
- `acceptBodySurfaceDeposit` **adds**, and refuses rather than clamping,
  evicting, or discarding an overflow (`invalid_amount`, `saturated`,
  `quarantined`, `capacity`). A destination that silently absorbs less than the
  source lost is that same unowned sink.

Both are keyed by the exact deposit record rather than by location, because a
transfer moves one named substance and the reduce's take-from-everything
behaviour would destroy the blood while moving the mud.

#### All-or-nothing at commit time

Owner ruling (2026-08-26): partial **physical** transfer is legitimate — the
planner may decide a smaller amount moves. Partial **transaction** success is
not. Once the equation is fixed by the debit, every leg lands exactly or none
does, otherwise "retake removes both sides or neither" has nothing exact to
undo.

`applySurfaceTransferProposal` in `contracts/turns/chat-contact-transfer.ts`
makes that structural rather than checked afterwards. Planning may degrade —
before anything moves it can find an unresolvable layer, a stale source, or an
unknown locus and refuse — but once material has left the source, every owner is
folded on a local copy and a refusal simply never returns them. There is no
partial success and no "committed but degraded" state. Every credit is also
verified by reading its owner **back**: the delta the owner actually applied must
equal the exact number this transaction planned, which makes the law independent
of any owner's internal merge, clamp, eviction, or capacity policy.

Order is the law's order: the receipt check first, then preflight, then the
debit that defines the equation, then every credit verified, then the receipt
write. Refusals are drops with stable `surface_transfer.*` codes —
`locus_unknown`, `key_invalid`, `layer_unresolved`, `source_stale`,
`layer_refused`, `destination_refused`, `receipt_refused` — and never
exceptions. At most `CHAT_SURFACE_TRANSFER_MAX = 2` settlements per exchange,
threaded in order so a second transfer off the same surface sees what the first
one left.

#### The intermediate leg is not a separate garment proposal

Owner ruling (2026-08-26): an intermediate layer's credit is one leg of a single
indivisible conserved event, mapped by the transaction onto a wardrobe-owned
operation. Two proposals for one conserved event would make atomicity impossible
to state.

Contact still never imports or edits the layer store. The leg becomes a typed
`accept_transfer` garment operation the layer's own owner validates and commits
(§10), and the transaction addresses it through a lane-supplied resolver that
turns the opaque path handle into an owner address — so contact never learns
what a layer is made of or how its owner names a part of it.

`accept_transfer` is deliberately not a mode on `deposit`. `deposit` compiles a
sentence: it max-merges, and at capacity it evicts the oldest record. Both are
correct for a sentence and both destroy material here. The conserved credit adds,
refuses on saturation (`garment_op.transfer_saturated`), refuses at capacity
rather than evicting a record this transfer never touched
(`garment_op.transfer_capacity`), and refuses a non-positive or over-unit amount
(`garment_op.transfer_invalid_amount`). Its substance does not degrade to
`unknown` the way `deposit`'s does: on the ordinary path an unnameable substance
is honest, but here the substance is already owner-backed on the source side, so
a kind that fails to parse means what left is not what would arrive. It shares
`deposit`'s record identity space so one substance in one place in one minute
stays one fact, and it soils the garment on the merged total, because a garment
carrying transferred mud that still reads pristine launders the transfer at the
only layer anyone sees.

Idempotency is explicitly **not** this reducer's job — a conserving add is by
construction not idempotent, and the transaction dedupes before anything reaches
it.

Building this leg surfaced a divergence between the two surface owners that
predates it: at capacity the garment deposit owner **evicts** the oldest record,
while the body-surface deposit owner declines the new one and its producer
reports `chat_surface.deposit_capacity`. They share the substance vocabulary, so
mud on a sleeve and mud on the forearm beneath it behave differently when the
record is full, and the eviction path has no test in either direction. The two
conserved credits refuse outright, which makes the divergence three-way.
Recorded as an open question in the
[plan](romantic-contact-affordances.plan.md) §23.

#### The idempotency receipt lives in the debited surface's own state

Owner ruling (2026-08-26): the receipt is a `transfers` key on
`BodySurfaceState`, on the `marks`/`deposits` precedent.

An adding credit cannot tell a retry from a second helping by looking at its own
amount, so the transaction needs a durable record of the causal identity — and
that record must roll back with the **debit**, or a half-applied transfer leaves
a receipt claiming it happened. The body-surface state is the one durable store
already riding exactly the anchor the debit rides: written in the same value,
restored by the same `pre_exchange_state`, dropped by the same retake. A separate
table would have to be taught that boundary; a key here inherits it. There is no
migration — it is a new optional key, absent until the first commit.

The module keeps 8 receipts over a 720-story-minute horizon, pruned on the write
path only so two readers of the same state cannot disagree about whether a
transfer may run. A quarantined receipt answers "already committed", which is the
conservative direction: re-running a transfer that may already have committed is
the failure §9 forbids, while skipping one that did not is a beat that quietly
does not happen. Recording refuses on a standing key and refuses at capacity
rather than evicting, since evicting a receipt would make the transfer it
recorded runnable a second time.

#### The atomic persistence seam is conditional

Owner ruling (2026-08-26): with no transfer in an exchange, persistence stays
byte-identical to today; with one, the finalized values go through a single
database transaction covering every authoritative row the transfer touched. The
ordinary hot path is not rewritten for a feature nothing can reach.

The reason a transfer needs the boundary at all is that the debit and the credit
land in different rows — the primary's surface in `character_chat_state`, the
garment store in `character_chats.garments`, and the receiving character's row
when material crosses bodies. A crash, a lost connection, or a deploy between two
independent writes would leave material deleted from one row and never credited
to the other, and no retry could detect it, because the transfer's receipt rides
the surface that *did* get written. That is the third of the three gaps §15
stage 8 names.

The reason the ordinary settle stays outside it is that it runs on every exchange
and has no cross-row invariant to protect when nothing moved between rows;
wrapping four independently-succeeding writes in a transaction would hold a
pooled connection open across the whole settle to buy nothing.

Mechanically: `DbWriter` now includes `execute`, because the settle path's state
upsert and scenario update are raw `sql` templates and a helper without `execute`
would have fallen back to the root client and opened a second connection while
the caller's transaction was still open — a write that cannot join the caller's
transaction cannot take part in an atomic settlement. `saveChatScenario`,
`savePreExchangeScenario`, `savePreExchangeSnapshot`, and `upsertChatState` each
take an optional writer defaulting to the root client, so every ordinary caller
is unchanged. `finalizeChatState` takes an optional already-settled transfer:
present, the writes move into `persistSurfaceTransferSettlement`'s one
transaction in the same order the ordinary settle uses; absent — which is every
live exchange — the four independent writes run exactly as they always have.
Fire-and-forget follow-ups such as the sketch and look enqueues stay outside the
transaction, since they are not part of the conserved equation and a detached job
must never hold one open or roll one back.

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
   visual projection, ungated. Merged to `main`; the deterministic half is
   covered by the §16 suites, and the model half — whether the continuity leg
   actually returns a `surfaceDeposits` list when a reply dirties somebody — is
   unobserved until a deployed exchange runs it.
8. **Add conserved transfer** as the second proof, including atomic
   source/destination conservation. Built 2026-08-26 (§9) and **fixture-only**,
   under §9's own escape clause. Owner ruling (2026-08-25): no live pairing has
   two implemented owners today, and three separate things would each have to
   change first —
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
     until the settle path changes. **Closed 2026-08-26** by the conditional
     atomic seam in §9.

   Garment-to-garment transfer would sidestep all three, because both sides live
   in one JSONB value — and it is explicitly not the proof, per §9's own warning
   against using a partial owner path to claim the general problem is solved.

   **What the build closed, and what it worked around.** The third gap is
   closed: skin and worn layers still live in two rows, but the settle path now
   puts a transfer-bearing exchange's writes inside one database transaction
   while leaving every other exchange on its four independent writes (§9). The
   first two are untouched — the player and ensemble members still have no
   body-surface owner, and the chat lane's contact layers still carry a
   coverage-region identity rather than an owner-addressable one — and they are
   why this stays fixture-only.

   The proof works around them rather than pretending they are closed. The
   source material read and the resolved path are **arguments** the producer is
   handed, and the layer address arrives through a lane-supplied resolver, so a
   lane that cannot answer supplies nothing and proposes nothing. What is proven
   regardless is the transaction itself — the conserving pair, the exact stepped
   equation, the read-back verification of every credit, the all-or-nothing
   discard, the receipt riding the debited surface, and the typed wardrobe
   operation for an intermediate leg. Those are owner-boundary and arithmetic
   properties, and none of them depends on which lane eventually supplies the
   two reads.
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
- a removal naming a substance leaves the other substances at that location,
  and an unrecognised name is still a NAME rather than a wildcard;
- a corrupt slot quarantines rather than dropping, so absent still means clean;
- one module emptying out does not discard a sibling module's record;
- an unrecognised substance commits as `unknown` rather than losing the fact;
- a location outside the owned everyday set is refused with its stable code;
- a full record reports the refusal rather than a silent no-op;
- the projected feature carries no expiry window.

### Conserved transfer second proof

Covered as of 2026-08-26 by three suites: the producer in
`affordances/contact/transfer.test.ts`, the transaction in
`turns/chat-contact-transfer.test.ts`, and the garment credit leg in
`items/garment-condition.test.ts`. The transaction suite asserts whole-world
totals rather than spot-checking the destination, because every defect that
matters here is a leak that a "the destination got some mud" assertion would
pass.

- proposal is not current truth — **covered**: the producer is pure over its
  three inputs, and every refusal returns the owners it was handed;
- source material must actually exist — **covered**: the transaction re-reads
  the source record inside its own cut and refuses a proposal whose record no
  longer holds what it read;
- source removal and destination/intermediate deposition are atomic —
  **covered**: a refused destination leg and a layer owner that credits the
  wrong amount each discard the whole settlement;
- transfer conserves source/target representation — **covered**: including the
  sub-floor remainder that must stay standing, the destination that adds rather
  than raising to the larger, and the integer remainder that must stay on the
  layer that failed to pass it;
- retry cannot transfer twice — **covered**: one causal identity settles once
  and the retry answers `no_change`;
- retake removes both sides or neither — **covered on both levels**: at the
  owner value, restoring the source surface takes the receipt back with the
  debit and the restored anchor replays to a fresh commit; through the database,
  the integration suite proves the receiving character's rollback anchor is
  written inside the same transaction as their credit, and that the anchor it
  stores predates the debit;
- failed transaction exposes no result — **covered**: every `surface_transfer.*`
  refusal is a drop with the input owners returned by reference;
- material blocked by a garment cannot teleport to skin — **covered**, and as a
  full conservation statement: a zero-throughput layer receives everything and
  the skin beneath it receives nothing;
- intermediate garment receives transfer when permeability/path says it should —
  **covered**: a partial crossing splits exactly, and two crossings in series
  conserve the same total as one.

The garment credit leg's own four laws — it adds rather than max-merging,
saturation refuses instead of clamping, a full record refuses instead of
evicting, and a zero leg refuses — are covered beside `deposit` in
`items/garment-condition.test.ts`.

The body-surface owner's own halves — the conserving pair's refusals and
take-everything behaviour, and the receipt module's duplicate, capacity, horizon
and absent-key rules — are covered in `state/body-surface.test.ts`, including
that a state which never transferred stays byte-identical to one from before the
module existed.

The conditional atomic persistence seam is covered where it has to be — against
a real database, in `server/engine/chat-state-fidelity.int.test.ts`. Two claims,
and the failure is INJECTED rather than simulated: the receiving character id
names nobody, so its upsert violates a foreign key *after* the primary row and
the scenario are already written inside the transaction. A seam that ran those
as independent statements would leave the debit standing, the credit missing,
and the transfer's receipt persisted on the debited surface — the one state no
retry can detect and no retake can undo. The success case proves the mirror:
debit, layer store and both rollback anchors land together.

That suite runs under `pnpm test:int`, which is a manual gate rather than an
automatic one, so the claim is checked when its surface moves rather than on
every push.

Deliberately **untested**: that a transfer-free exchange persists byte-identically
to before this work. The transfer-free path is unchanged code taking the same
branch it always took, and the existing suites passing is the proof — an
assertion that four unchanged statements still run would pin the arrangement of
the code rather than any behaviour.

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