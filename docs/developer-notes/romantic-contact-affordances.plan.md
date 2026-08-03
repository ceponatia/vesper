# Romantic contact affordances

Status: active (promoted 2026-07-28; **slices 0–2 shipped 2026-07-30**,
**slice 3A — authority and persistence hardening — landed 2026-07-31**,
**slice 3A.1 — boundary corrections — landed 2026-07-31**, and the
**affectionate-contact technical MVP — flag off — shipped 2026-07-31** with
its item-1.1 persistence repairs and ending producers. **The internal trial
ran 2026-07-31 and PASSED (owner verdict 2026-08-01)** — continuation items
3–6 are un-gated in their existing sequence; the parked list stays parked.
**Enablement is LIVE (2026-08-02): both flags set to the literal `on` on the
Fly deploy** after the verdict's conditions merged (PRs #26/#27).
**Next: item 3, actor control through the live lane —
[spec revised 2026-08-02 after pre-implementation review](romantic-contact-affordances.spec.actor-control.md).
Pure/durability foundations and a measured shadow pass now precede any new
authority.**)

Slices 0–2: the truth-source audit is published, the lane-neutral contact
lifecycle is built as pure contracts, and the foot domain proof is in
`src/contracts/affordances/domains/foot/` (topology + three registry loci,
profile inheritance, condition distribution, footwear filtering, and the
pressure/texture/glide/articulation/nail phenomena — fixture-driven, not
production-wired; contact warmth and scent recorded deferred).

Two of the three ruled prerequisites are **done**: the slice-2
[hardening pass](finished/romantic-contact-affordances.followups.md) ✅ and the
**pre-slice-3 foot-facts + registration hardening** ✅ (2026-07-30 — persisted
foot baselines with a backfill, partial foot profiles, the optional-invalid
dependency law). The third, the
[adult declaration](finished/adult-eligibility.plan.md), shipped 2026-07-30 but
was **rolled back 2026-08-03** (owner ruling: scope creep, and species-scaled
ages make a flat human 18 the wrong adult test) — see the rollback note atop
its plan. **This plan's eligibility-dependent items need reanalysis**: the
positive adult-eligibility source that continuation items 5–6 and the romantic
gate assumed no longer exists, and what replaces it (if anything) is an owner
decision, not something this document can assume. The follow-ups list is
**complete and archived** —
[record](finished/romantic-contact-affordances.followups.md). Foot registry
defaults, the Neon backfill, and deployment are all complete, so the
production-registration gate now waits only on slice-3 wiring order.

Remaining: the slice-3 continuation order below, then slice 4. Intimate work
waits for the foot proof and authoritative adult-eligibility, consent,
exposure, and physiology. The plan follows
[body-attribute affordances](body-attribute-affordances.plan.md)
and the shared projection contract in
[constraint-first narrator physical guidance](narrator-physical-guidance.plan.md);
its active doc family stays together until ship.

## In one sentence

Give romantic chat a small, reliable understanding of physical contact so the
narrator can describe what is actually happening—pressure, texture, movement,
clothing, moisture, and visible or felt changes—without inventing access,
arousal, consent, or reactions.

## The experience we want

Today, a narrator often has to fill in the physical details of a scene from
general character descriptions. That can produce vivid writing, but it can
also produce contradictions: a covered body part is described as bare, dry
skin suddenly becomes slippery, a position becomes possible without anyone
moving, or the same detail is repeated every turn.

This work would give the narrator a few grounded observations for the current
moment. For example:

- If a bare foot with lotion on its sole slides along a thigh, the system may
  report broad contact, an easy glide across the arch, and a little drag at a
  rougher heel.
- If the same foot is still inside a sock, the system may report fabric-filtered
  texture and block direct skin contact.
- If a hand moves over underwear, the system may report contact through fabric
  and a garment contour, but not direct contact with the anatomy underneath.
- If clothing has actually been moved and intimate contact has been allowed,
  the system may combine the current contact with body shape, live physiology,
  and surface condition.

These are structured observations and resolved contact facts, not prose.
Consistency constraints and action outcomes reach the narrator through the
[constraint-first guidance plan](narrator-physical-guidance.plan.md); positive
details are separately change-gated and never forced into every applicable
reply.

## Why start with foot play

Foot contact is a useful first test because it exercises most of the shared
problems without requiring the full intimate-physiology system:

- different surfaces such as heel, arch, ball, toes, nails, and top of foot;
- bare skin, socks, hosiery, shoes, and open footwear;
- support and balance;
- reach and small position changes;
- pressure, texture, sliding, warmth, moisture, products, and residue;
- touch, sight, smell, and close-range attention;
- sustained contact that should not be redescribed every turn.

Once those shared rules work, intimate regions become a strong second test.
They add stricter access, consent, exposure, anatomy, live physiology, and
privacy requirements. Proving the common contact rules on feet first keeps
those concerns easier to separate.

## What exists today—and what does not

The first implementation cannot treat narrator prose as physical truth. At
promotion:

| Area | Current position |
| --- | --- |
| Legacy romantic chat | It has structured clothing and coverage, retake snapshots, a minor fence, and a turn-level sensory allowance. It does not have authoritative fine pose, distance, support, body-surface contact, per-sense exposure, or a consent ledger. Its intimate-scene signal and touch-welcomeness reaction are not consent grants. |
| Successor chat | It has world location, event cuts, observations, and a fail-closed consent ledger. It still lacks the regional pose, articulation, support, and active body-surface contact required here. Its structured clothing adapter is also unfinished. |
| Body surfaces | Stable anatomy and appearance attributes exist. Shared regional moisture, products, body residue, pressure marks, and contact temperature do not yet have complete owners. |
| Physiology | The general physiology plan is still deferred. Erection, swelling, lubrication, vascular change, sweat, and temperature cannot be inferred merely because the scene is intimate. |
| Adult eligibility | Known numeric minors are fenced from intimate prompt surfaces. Unknown, nonnumeric, and fantasy-scaled ages do not yet provide an explicit adult-eligibility proof for every participant. |

Slice 0 turned every missing source into one of three recorded outcomes: build
the minimal owner in this plan, depend on a named prerequisite, or omit the
affected observation. “The narrator said it last turn” was never a fourth
option. The verified record — including what the table above got wrong once the
code was actually read — is the
[truth-source audit](romantic-contact-affordances.audit.md), published
2026-07-30.

## What the system would work out

For a current or proposed contact, it should answer six plain questions.

### 1. Can this contact happen now?

It checks who is acting, what part of their body they are using, the target
area, current position, distance, support, clothing, and the relevant
interaction permission.

A tiny ordinary adjustment may be included when it is clearly part of the
action, such as turning a free ankle slightly or leaning closer. The system
must never silently remove clothing, expose a covered area, move someone to
new furniture, force a joint, override resistance, or invent a willing
reaction.

### 2. What is actually touching?

It identifies both body surfaces and every material between them. A hand on a
sock, a foot against a skirt, and bare skin on bare skin are different
contacts, even if they involve the same general body areas.

It also knows whether a contact has just started, changed, continued, or ended.
An ended contact cannot keep producing pressure, texture, or glide merely
because it appeared in an earlier turn.

### 3. What does the current contact feel or look like?

It combines the actual pressure, contact area, motion, surface texture,
softness, clothing, moisture, temperature, and current body condition. It may
describe a broad press, a narrow trace, a fabric-muted texture, a smooth glide,
or visible compression only when the required cause is present.

### 4. Did the contact change anything?

A possibility is not treated as an event. A scratch, pressure mark, displaced
garment, transferred lotion, or new residue becomes true only after the system
that owns that state records the change. Contact affordances may say that a
change is possible and help an action resolver calculate it, but they do not
quietly rewrite body or clothing state.

Transfers must be atomic and conservative: material removed from one surface
and placed on another is one committed change, and retries or retakes cannot
duplicate it.

### 5. Who can notice it?

Sight, touch, smell, and taste have different requirements. A movement hidden
inside a shoe may be physically real but not visible. Texture needs actual
touch. Scent needs a current source and enough proximity. Taste needs direct
qualifying contact. Intimate details remain behind the product's intimate,
exposure, and point-of-view gates.

### 6. Is it worth mentioning now?

The physical result may remain true for many turns while its narration value
falls. A new contact, changed pressure, new motion, newly exposed surface,
transferred material, or strong relevance to the current action may make it
worth mentioning again. An unchanged held contact should usually stay silent.

## Candidate foot observations

The first trial should cover:

| Observation | What it contributes |
| --- | --- |
| Contact pressure and area | Distinguishes a light toe trace, narrow heel contact, and a broad sole press. |
| Regional texture | Allows an arch, ball, heel, toe pad, nail, and top of foot to feel different without authoring each as a separate character description. |
| Glide and drag | Combines current sliding motion with the known substance, fabric, skin texture, and pressure. Water, sweat, lotion, and oil do not share one “more moisture means less friction” rule. |
| Foot and toe position | Describes a position that already exists, including footwear restrictions, without turning touch into an invented emotional toe curl. |
| Nail contact | Distinguishes a nail trace or edge from soft toe contact; a scratch still requires a recorded event. |
| Footwear filtering | Blocks bare-skin claims and reports what flexible fabric or rigid footwear can actually transmit. |
| Pressure marks | Surfaces real sock, strap, or shoe marks after removal; does not create them merely because footwear was worn. |
| Surface transfer | Tracks lotion, water, dirt, or other residue only after a real transfer is recorded. |
| Contact warmth | Reports relative warmth or coolness during touch from current body and environment state. |
| Close scent | Uses current exposure, sweat, products, cleanliness, distance, and airflow rather than a permanent foot label. |

## Candidate intimate-region observations

The second trial should support adult, consent-gated scenes across the anatomy a
character actually has. It should cover external genitals, breasts and nipples,
the perineum, and anal contact where those regions are relevant.

| Observation | What it contributes |
| --- | --- |
| Effective access and exposure | Distinguishes covered, visible through sheer fabric, touch through fabric, directly exposed, and internally accessible where appropriate. |
| Contact location, pressure, and area | Grounds which surfaces are touching and whether the contact is light, narrow, broad, still, or moving. |
| Clothing contour and compression | Describes shape or movement transmitted through a garment without claiming direct anatomical access. |
| Current surface moisture | Uses authoritative lubrication, sweat, water, or products; never treats an intimate scene as automatically wet. |
| Friction and glide | Combines motion, pressure, material layers, and current moisture into a grounded contact response. |
| Soft-tissue response | Describes compression, displacement, rebound, or support when current contact and anatomy justify it. |
| Live arousal-related shape | Uses recorded physiology such as erection, swelling, nipple erection, or vascular change; never guesses arousal from genre or contact alone. |
| Fluid or product transfer | Reports transfer only after a contact event records it on the receiving body or garment surface. |
| Visible aftermath | Surfaces real dampness, impressions, displacement, residue, or flushing after the state owner records it. |
| Action alignment | Checks that the named action, body parts, path, clothing, and current pose agree before offering sensory detail. |

The feature list is intentionally wider than the first implementation slice.
It gives us a test catalog without committing to simulate every case at once.

## Rules that protect agency and continuity

- This system describes physical consequences. It does not decide desire,
  consent, attraction, pleasure, climax, withdrawal, or any other character
  choice or emotional response.
- Any interpersonal body contact must respect actor control and target agency.
  A player describing an NPC's voluntary movement does not make that movement
  committed truth. This applies to every contact, including ordinary ones.
- **Permission is scoped, not universal** (owner ruling, 2026-07-30). Only
  **romantic and intimate** contact requires the applicable permission scope
  and — for those kinds — positive adult eligibility for every participant.
  Ordinary incidental and affectionate social touch is **permission-neutral**:
  it is the everyday contact the lane already narrates, and requiring a grant
  the lane cannot produce would gate ordinary behaviour behind machinery that
  does not exist. Foot play framed as romantic or fetish attention is
  `romantic` and needs the scope — it is never relabeled `affectionate` to let
  a trial commit.
- Adult intimate contact must pass the authoritative consent and policy check
  before a committed contact exists. Known minors are always ineligible.
  Intimate rollout remains blocked until every participant—including
  unknown/fantasy-age characters and the player persona—has an authoritative
  adult-eligibility ruling. Missing or uncertain permission fails safely.
- Possibility is not actuality. Reachable, sensitive, compressible, or capable
  of becoming wet does not mean touched, aroused, compressed, or wet.
- Clothing changes require real wardrobe actions. The contact layer cannot
  undress or reposition garments for narrative convenience.
- Live body changes come from physiology and body state. Stable character
  attributes describe baseline anatomy, not the current response.
- Unknown is not the same as dry, cool, clean, or unmarked. A missing current
  surface read suppresses the dependent observation.
- The narrator receives only what the current point of view can perceive and
  only a small number of relevant observations.
- Retakes must use the same captured physical moment and observation choices,
  so regenerating a reply does not silently change the scene.

## How this fits with the other body plans

This plan connects several existing systems rather than replacing them:

- [Body-attribute affordances](body-attribute-affordances.plan.md) turns stable
  appearance and live state into grounded observations. Romantic contact reuses
  its read-and-rank approach. Promoted together 2026-07-28 and sequenced first:
  the shared affordance core (structural profiles, phenomenon registry,
  evidence, perception + cue ranking) is built under that plan, and this plan
  consumes it.
- [Clothing state graph](clothing-state-graph.plan.md) owns what garments
  exist, how they are worn, and whether they are wet, shifted, opened, or
  removed. Legacy chat has the main substrate; successor adaptation and direct
  affordance integration are still outstanding.
- [Physiology](deferred/physiology.plan.md) owns live responses such as erection,
  swelling, lubrication, flushing, temperature, and sweat. Intimate physiology
  work in slices 5–6 cannot begin until that plan provides authoritative reads.
- [Skin surface](body-attribute-affordances.spec.skin-surface.md) owns the
  readable surface effects of moisture, products, marks, and residue.
- [Soft tissue](body-attribute-affordances.spec.soft-tissue.md) supplies the
  reusable body-shape and deformation ideas that contact can consume.
- [Recognizable features and visual memory](body-attribute-affordances.spec.recognizable-features.md)
  provide the precedent for noticing important details without repeating them.

The contact layer owns none of those source facts. It brings their current
answers together for one interaction.

## Delivery outline

The committed first roadmap scope is slices 0–4: a foot proof end to end in
legacy romantic chat, using shared contracts that can later accept successor
state. Successor parity is not claimed until its pose/contact and clothing
adapters exist. Slices 5–6 remain blocked behind the foot trial and their
explicit intimate prerequisites; slice 7 records the generalization and parity
decision.

### Slice 0 — confirm the truth sources · shipped 2026-07-30

Inventory what chat and successor chats already know about pose, reach,
clothing, body surfaces, physiology, consent, perception, and turn capture.
Publish the capability matrix. Resolve or explicitly defer gaps before
treating any field as authoritative. The slice must also settle adult
eligibility, actor control, and the permission rule used for the first foot
trial.

**As built.** The matrix is
[romantic-contact-affordances.audit.md](romantic-contact-affordances.audit.md),
with a file and line behind every claim. The short version: clothing state,
effective coverage, and the legacy retake boundary are trustworthy; body
surfaces, adult eligibility, successor consent, successor perception, and the
foot sub-region registry are usable but too narrow; and pose, reach, support,
material-between, tactile perception, legacy actor control, legacy permission,
and the contact lifecycle itself have **no owner in either lane**. Two
consequences the later slices inherit: contact warmth cannot join the foot
milestone (no temperature read exists anywhere), and the foot topology needs
three loci — arch, ball, and toenails — that the body registry does not have.

The three product questions this slice was told to settle turned out to have no
ruling anywhere in the repo. Each got a RECOMMENDED default implemented in
slice 1 and was flagged, unresolved, at the top of the audit: how adult
eligibility is proven when the existing fence fails open and the player persona
has no age at all; what proves actor control in a lane whose only mechanism is
prompt text pointing the other way; and which action kinds need a permission
owner when legacy chat has no consent grant of any kind. **All three were ruled
by the owner on 2026-07-30** — the rulings are recorded inline in the audit and
summarized under Open questions below.

### Slice 1 — shared contact foundation · shipped 2026-07-30

Add one lane-neutral contact lifecycle: attempt, reject or require a visible
transition, start, update, continue, and end. Preserve the two surfaces,
material between them, pressure, movement, time, actor-control decision,
permission decision, and evidence. Only an active committed contact reaches
physical observations.

**As built.** `src/contracts/affordances/contact/` — pure contracts, no lane
wiring, no storage, no schema change. An attempt resolves to exactly one of
four answers: it may be committed, it needs a visible transition first, it is
refused, or the world could not be read. Two of those are enforced by the type
system rather than by discipline — a refused attempt has no shape that the
commit function will accept, and an ended contact has no shape that a physical
observation will accept. Contact identity is derived from the two surfaces and
the event that started it, so a regenerated reply resolves the same physical
moment; re-asserting an unchanged contact writes nothing at all.

Because so much is unowned, the resolver takes pose, reach, support, and
material-between as reads that are allowed to say "nobody can answer", and
answers `unresolved` when they do — which the narrator seam turns into silence
rather than an explanation. Full contract detail, the public surface, and every
deviation from the spec draft are recorded in
[the contact-core spec](romantic-contact-affordances.spec.contact-core.md#as-built--slice-1).
Storage is deliberately deferred: the versioned shape and its healing rule are
settled so they are not decided twice, but where committed contact lives is
still an open question below.

### Slice 2 — foot contact proof · shipped 2026-07-30

Add the foot surface map and ship pressure, regional texture, and footwear
filtering first. Add sliding only for known, substance-specific surface state.
Add contact warmth only if Slice 0 identifies an authoritative temperature
source; otherwise record it as deferred rather than guessing. Use authored
fixtures rather than open-ended narrator interpretation.

**As built.** `src/contracts/affordances/domains/foot/` — a sixteen-surface
interaction map over three new non-slot registry loci, structural profiles
compiled from the authored `feet.*` attributes, zero-preserving regional
condition distribution, wardrobe-part footwear filtering, and five phenomena
(pressure, texture, substance-specific glide, articulation, nail bands), all
gated on a committed contact from the slice-1 lifecycle and proven against the
spec's calibration fixture plus seven further worked cases (185 tests). The
domain is deliberately **not** registered in the production domain set —
registration is slice 3's wiring act. Contact warmth resolved **no** (no
temperature owner in either lane) and scent is deferred with it. Full detail,
the deviation table, and the deferred list:
[foot spec §"As built — slice 2"](romantic-contact-affordances.spec.foot.md#as-built--slice-2).

### Slice 3 — constraint-first romantic-chat evaluation

Feed attempted contact through the resolver before narration, then project the
committed, rejected, unresolved, or explicit-transition-required result through
the shared action-outcome seam in
[narrator-physical-guidance.plan.md](narrator-physical-guidance.plan.md).
Evaluate constraints and action outcomes behind `CHAT_PHYSICAL_CONSTRAINTS`
without requiring the narrator to mention an otherwise irrelevant body detail.
Run any positive contact-transition detail as a second, independent campaign on
top of the winning constraint configuration; do not combine both changes into
one A/B.

**The owner's revised verdict (2026-07-31).** After a deep external review,
slice 3 was judged **ready to begin as an opening hardening and design phase —
but not ready to proceed directly into production lane wiring unchanged.** The
slice therefore splits: a hardening pass first, then the wiring order.

#### Slice 3A — authority and persistence hardening · shipped 2026-07-31

The opening phase the revised verdict called for. It touches nothing in the
live lane; it makes the contracts strong enough to be wired.

1. **Actor/source and per-participant agency binding** — an attempted contact
   carries who is acting and where the assertion came from, and each
   participant's agency answer is bound to that participant rather than to the
   attempt as a whole.
2. **Lifecycle cross-validation** — clearing, orientation, capacity, and state
   are validated against each other, so an internally contradictory lifecycle
   transition is rejected rather than half-applied.
3. **Post-persistence outcome adapter, with no partial status** — the contact
   adapter emits only `committed`, `explicit_transition_required`, `rejected`,
   or `unresolved` (see the note under §"Continuation order" below).
4. **A minimal scene / body-relations owner**, with its spec —
   [scene spec](romantic-contact-affordances.spec.scene.md).
5. **Final foot side/unsided regressions** — the last residuals from the
   slice-2 hardening list.
6. **The four carried-forward corrections** from the review: the required
   access discriminator on the eligibility entity descriptor (replacing an
   optional `foreign?` flag whose omission resembled ownership), the
   non-owner blocker-routing regression, the clone-policy **disclosure on
   publish** (owner ruling — full-profile duplication stays, the author is
   told at the control; see docs/auth.md §"Publishing and cloning"), and this
   documentation pass.

#### Slice 3A.1 — boundary corrections · shipped 2026-07-31

The owner's review of the shipped 3A found the original findings closed but a
set of **newly exposed boundary problems**, fixed here before any lane wiring:

1. **Scene-state versions fail closed** — the scene snapshot no longer heals a
   malformed version into the current one (the same bug 3A fixed in contact
   state).
2. **Target-agency proof is persisted** — the consulted, participant-keyed
   agency decisions ride the committable resolution into the committed
   contact's start identity, and stored-state validation demands an `allowed`
   decision for every adjusted non-actor participant; duplicate decisions for
   one participant are a contradiction, not a first-match win.
3. **Acknowledgments are bound to the actual commit** — `committed` requires
   the acknowledgment to name this action's own contact id, commit kind, and
   event; wrong-id, wrong-kind, stale, and ended-contact acknowledgments all
   resolve `unresolved`.
4. **Stale writes cannot rewrite newer facts** — scene intents older than the
   targeted fact's provenance no-op (support-set provenance survives even an
   empty set), and stale contact ends no-op everywhere (capacity refuses the
   new start rather than writing a time-travelling end).
5. **Boundary contradictions drop instead of winning by array order** —
   duplicate scene keys and self-referential facts are dropped at restore, and
   a housed contact whose body participant did not survive restoration is
   dropped with it.
6. **Unavailable is not narrated as refusal** — only explicit denial stays
   `rejected`; missing/unresolved authority returns `unresolved` (silence +
   diagnostics), so the fiction never carries a refusal nobody made.
7. **Character publishing confirms** — publishing a character now asks first,
   with the fuller disclosure (private fields **and images** are duplicated;
   unpublishing does not recall existing copies), pinned by regression;
   unpublish and non-character kinds stay one-click.

Rulings recorded with this pass: the generic contact core stays
**anatomy-neutral** (the no-`center`-foot law lives in the foot schema alone);
footwear must gain a **side** (one sock is currently unrepresentable) and
per-surface, per-side friction before channel-aware registration; trapped
mobility may stay unproduced for the affectionate proof **provided the proof
avoids restraint/pinning**, and becomes mandatory before any feature relying
on immobilized limbs.

#### Continuation order (owner-ruled 2026-07-31: the MVP + its trial lead; everything else waits)

1. **The affectionate-contact technical MVP — flag off — ✅ shipped
   2026-07-31.** ("Technical MVP" is the owner's accurate name for what
   exists: the machinery works end-to-end and is proven by tests, but no
   product judgment has been made — that is the trial's job, and both flags
   stay off until it succeeds.) Built as the affectionate integration proof
   (behind
   `CHAT_CONTACT_ACTIONS`, default **off**). The legacy chat lane gained: the
   `chat_contact_events` durable ledger (idempotent per exchange, pruned on a
   retake) + the scene/contact projection riding the scenario's retake anchor
   (`character_chats.scene`, migration 0093); a deterministic pre-narration
   leg — conservative movement and affectionate-touch detectors over the
   player's own narration (romantic verbs/targets, restraint, negation, and
   hedges all veto whole sentences; pronouns resolve only when unambiguous);
   resolve → commit → **persist-before-prompt** with the acknowledgment built
   from the awaited ledger write; and the action-outcome wording in the
   physical-guidance seam (reaches the prompt only when
   `CHAT_PHYSICAL_CONSTRAINTS` is also on). All four proof obligations are
   pinned by integration tests: durable events, retake restoration without
   duplicates, retry/idempotency, and flag-off byte-identity — plus silence
   rules (unreachable and romantic-framed lines commit nothing) and
   corrupt-blob degradation. Actor control is READ off the scene's control
   fact rather than asserted, which delivers part of item 2's mechanism
   early. No restraint/pinning anywhere.

   **Item 1.1 — persistence repairs and adapter gaps (owner review; shipped
   2026-07-31).** The ledger append and the scene projection now land in ONE
   transaction, verified against the stored rows — a conflicting record under
   the exchange's keys aborts the whole write and the outcome stays
   `unresolved`; the retake prune runs unconditionally (never flag-gated);
   the approach detector refuses possessive destinations ("her desk",
   "Wren's chair"); a dressed body whose wardrobe published no coverage
   capture reads `unavailable` — silence, never bare skin; and the lane
   gained its ending producers — player release (`withdrawn`), any
   story-clock skip (`separated`; owner ruling 2026-07-31), and scene-place
   change (`scene_changed`) — all persisted as durable end events under the
   same exchange. 24 integration tests pin the on→off retake,
   both-halves-mid-stream atomicity, conflicting-retry abort, the three
   ending paths, and the material honesty split.

   **Item 1.2 — pre-enablement repairs (owner-scoped follow-up; landed
   2026-07-31).** The trial's three bounded gaps, fixed at their sources
   before any enablement:

   - **The coverage settle race is closed at its source.** The contact leg now
     derives every present roster member's effective coverage from the CURRENT
     exchange's resolved wardrobe before contact resolution — reusing the
     affordance read's own capture verbatim when one was taken, deriving
     through the same pure garment stages when not — so a rapid follow-up
     touch no longer no-ops with `contact.material_unavailable`, and a stale
     persisted capture can never override the current cut. Settlement persists
     the exact objects the leg consumed (threaded, never recomputed). The
     three honest material outcomes are unchanged: a modelled capture answers
     (empty = genuinely bare), a dressed-but-unmodellable body stays
     `unavailable`, an authoritatively bare wardrobe answers empty coverage.
     Ensemble members get the identical treatment (their wardrobes resolve
     once, cached, and the prompt build reuses the same resolve).
   - **S3's reach gap got an honest presentation constraint.** A concrete
     affectionate act that resolves `unresolved` specifically because the
     scene cannot establish reach (`geometry_unavailable`) now produces one
     typed reach-premise line in the physical-guidance block — "the current
     scene does not establish that the player's hand can reach X's Y; do not
     depict that touch as landing, and do not invent movement to make it
     land." Presentation only, owned by `CHAT_PHYSICAL_CONSTRAINTS` (flag off
     ⇒ byte-identical prompts); the attempt stays `unresolved` — no row, no
     proximity, the existing diagnostics — and every OTHER failure keeps its
     own typed wording (out-of-reach stays a refusal, material stays
     material).
   - **The minimal NPC-authored contact-ending producer** — the first bounded
     deliverable of item 3 (actor control through the live lane). After the
     assistant reply settles, conservative whole-sentence detection over the
     reply's narration (negation/hedge/question/dialogue/romantic vetoes;
     pronouns resolve only for a sole NPC; ensembles need an unambiguous
     name) may END existing contacts involving that NPC — `withdrawn` for a
     surface withdrawal, `separated` for a stated whole-body departure — and
     nothing else: no starts, no movement, no proximity claims. The ends are
     durable rows under a reply-side event ref
     (`contact-reply:<assistant message id>`, disjoint from the player leg's
     refs) guarded by the assistant row: retakes prune them, deletes cascade
     them, replays land nowhere, and a conflicting record fails closed with
     the projection unchanged. The ordering invariant is documented in the
     settle: the producer runs after `finalizeChatState` and the garment
     reconcile, so the settled scenario can never overwrite the NPC-ended
     scene. Detail: `src/server/engine/chat-contact-reply.ts`.

   Pinned by the unit suites (`chat-contact-adapter.test.ts`,
   `chat-contact-reply.test.ts`, the guidance render suite) and two
   integration suites (`chat-contact.int.test.ts` — race, stale capture,
   unmodelled honesty, retake identity, reach-premise prompt bytes;
   `chat-contact-reply.int.test.ts` — the ten durable-ending obligations).

   **The developer view came with it.** A feature this quiet needs somewhere to
   answer "why did nothing happen", and silence has many causes that look
   identical from the prompt: either flag off, a hedge or a negation in the
   line, an ambiguous target, romantic framing, or a reach the scene could not
   resolve. So both dev previews re-derive the leg **read-only** — they run the
   detection and word the outcome, and deliberately skip the two things a live
   turn does that a preview may not: writing the durable row and moving the
   bodies. The prompt preview obeys the flags, because it is showing the exact
   bytes a turn would send; the guidance inspector reports them and runs the leg
   either way, so what turning a flag on would do is visible before turning it
   on. The one thing the preview assumes rather than observes is that the
   durable write it did not perform would have succeeded — without that, every
   contact would preview as silence, which is the blind spot it exists to close.
2. **The internal trial — the gate for everything below (owner-ruled
   2026-07-31).** Enablement is the flag architecture as built: set
   `CHAT_CONTACT_ACTIONS` + `CHAT_PHYSICAL_CONSTRAINTS` globally on the Fly
   deploy (the deployment is internal, so global-on IS the internal trial;
   contact events land in real conversations and turning the flags back off
   is the full rollback — rows remain, harmlessly). A small scripted set of
   affectionate-beat conversations is run flag-on vs flag-off with the
   dedicated QA account, scored against a written rubric for whether the
   narration is actually **more coherent and natural**, and delivered with
   transcripts; the owner's verdict on that report decides whether anything
   below un-gates. Until the trial succeeds, items 3–6 are queued-but-gated
   and the parked list at the end of this section stays parked.
   **Run 2026-07-31 — [trial report](romantic-contact-affordances.trial.md).
   Verdict: PASS (owner, 2026-08-01).** Headline: clear coherence wins
   wherever the machinery had authority (held touches persist and release
   cleanly; scene changes end contacts durably; material reaches prose —
   ledger-verified in production), no naturalness regressions anywhere, and
   three bounded gaps: the unresolved-attempt prose teleport (S3), the
   coverage settle race (which invalidated S2/S5 as contact-lifecycle
   proofs), and NPC-prose endings the projection could not see. All three are
   fixed by **item 1.2 above**; the affected cases (S2, S5, S3, plus an
   NPC-withdrawal case) were rerun on fresh disposable chats and the report
   amended with a full evidence appendix. The owner's PASS accepted the
   product-value gate and the three repairs, un-gated items 3–6 in their
   existing sequence, kept the parked list parked, and conditioned
   enablement on finishing the wardrobe restatement guard for partial
   paraphrases (both folds) plus one targeted live check — see the report's
   §Verdict and §Post-verdict verification.
   **Enablement completed 2026-08-02:** the guard's round-3
   evidence-assertion correction and its owner-scoping follow-up merged as
   PRs #26 and #27, merged main was deployed, and both flags were set to the
   literal `on` (verified in-machine). Standing watch item: the NPC-ending
   producer's first organic production occurrence (per the verdict).

3. **Actor control through the live lane** (un-gated by the 2026-08-01
   verdict, but gated by its own foundation + shadow review) — its first bounded
   deliverable, the deterministic NPC contact-ending producer, landed in item
   1.2 and remains the frozen ending floor.

   A 2026-08-02 pre-implementation review found that the first general-case
   draft was not safe to build: an ensemble decision did not identify its actor;
   a grounded quote did not have to prove the proposed action; movement and
   empty/degraded outcomes had no durable retry identity; action order could
   reverse the prose; and the proposed save guard, post-settle presence cut,
   source-side clothing read, and opening coverage did not exist.

   The revised
   [actor-control spec](romantic-contact-affordances.spec.actor-control.md)
   closes those holes before authority: one classifier call for the whole reply,
   stable roster/contact references, field-by-field evidence proof, written-order
   folding, final presence/wardrobe reads, a durable assistant-message decision
   envelope (including no-decision tombstones), and one guarded atomic save for
   envelope/contact rows/scene. The classifier first runs in shadow so accuracy,
   latency, timeout rate, and cost are measured. Authority then rolls out as
   movement → starts → updates. The frozen floor stays the only prose extractor;
   closed verifier vocabulary may confirm an exact proposed field but may never
   invent one.
   **Delivery steps 1–3 built 2026-08-02**: the pure foundation and its
   adversarial fixtures, the durable decision envelope (one row per assistant
   reply, no-decision tombstones included) with its guarded atomic save, and
   the shadow leg — one classifier call per qualifying reply, dry evaluation,
   every reply kind covered including openings — behind
   `CHAT_NPC_SCENE_DECISION_SHADOW`, default off. The shadow flag has not
   been enabled; the measurement window, its review, and the standing-cost
   ruling remain before any authority increment starts.
4. **The explicit `romantic_touch` permission owner — spec before
   implementation** (un-gated by the 2026-08-01 verdict). Its design decisions need owner
   rulings first; they are listed in Open questions below.
5. **Eligibility + blocker-link UI wiring** — **blocked since 2026-08-03**:
   the adapter and blocker links this item was to wire were removed with the
   [adult declaration rollback](finished/adult-eligibility.plan.md). Needs a
   re-planned eligibility source (an owner decision) before it can be
   re-scoped.
6. **The genuinely romantic proof** (still sequenced after 4 and 5) —
   previously gated on the adult declaration resolving every participant;
   **blocked since the 2026-08-03 rollback** on the same re-planned
   eligibility source as item 5.

**Parked (owner ruling 2026-07-31; reaffirmed by the 2026-08-01 PASS verdict
— the broader parked list remains parked)** — deliberate
reprioritization, not abandonment; each keeps its recorded design and
prerequisites and none may be built while parked:

- additional foot-region granularity (the sixteen-surface open question);
- marks and material transfer (slice 4 below — Status: **parked**);
- intimate physiology (the intimate track's physiology prerequisites);
- successor-lane parity;
- channel-aware foot narration / registration with positive texture/glide
  (the former continuation item 6 — still blocked on explicit visual/tactile
  perception channels, perceiver binding, structured path and cross-locus
  information, and per-surface per-side footwear friction incl. the ruled
  footwear side);
- further generalized contact abstractions beyond what the MVP needs.

**No partial contact status.** The contact adapter emits exactly four outcomes:
committed, explicit-transition-required, rejected, unresolved. `partially_committed`
stays in the **generic guidance vocabulary only**, reserved for future domains
that need per-locus commitment; romantic contact never produces it, and no
document should describe a romantic-contact partial result.

**Production registration.** The two preconditions the earlier gate named — the
slice-2 review corrections (non-clearable materialized fields, the `trimmed`
toenail default, the concurrent-edit-safe backfill) and the Neon backfill —
were **both met 2026-07-30**, and the foot registry defaults are deployed
([archived follow-ups](finished/romantic-contact-affordances.followups.md)).
Registration is therefore no longer gated on corrections or data migration; it
waits only on reaching its place in the wiring order above.

### Slice 4 — changes caused by contact · **parked** (owner ruling 2026-07-31, pending the trial)

Connect marks and material transfer through explicit events owned by body,
clothing, or action state. Commit source removal and target deposition
atomically, with idempotency and provenance. Prove that retries, retakes, and
branches neither duplicate material nor leave half an effect.

### Slice 5 — intimate access and contact

Reuse the proven contact foundation for adult intimate regions. Start with
effective exposure, material-between, contact pressure, clothing contour,
friction, and current surface moisture. This slice cannot start until adult
eligibility, consent scope, actor control, exposure, and point-of-view gates are
authoritative for the selected lane.

### Slice 6 — live physiology and aftermath

Add only the physiology-owned shape and surface changes that have authoritative
inputs. Connect visible or tactile aftermath without creating a second arousal
model. If the physiology plan has not shipped the required reads, this slice
remains blocked rather than implementing local substitutes.

### Slice 7 — decide what generalizes

After foot and intimate fixtures work, decide which helpers truly belong in a
general body-contact library and which should remain region-specific. Record
whether successor parity ships here or becomes a named follow-up. Keep all
active plan/spec files together until the plan closes, then archive the family
as one unit if desired.

## How we would judge the trial

Use a small, repeatable set of adult romantic-chat scenes rather than relying
only on free-form play. Each scene should be run with the feature off and on.
Review:

- physical contradictions;
- clothing and exposure contradictions;
- stale contacts that continue after they ended;
- unauthorized or player-puppeted NPC movement;
- minor or unresolved adult-eligibility leakage;
- invented arousal, consent, movement, or reactions;
- useful sensory specificity;
- repetition across sustained contact;
- whether a change becomes mentionable at the right time;
- consistency between original replies and retakes;
- conservation and idempotency of marks and transferred material;
- whether the narrator sounds natural rather than like a physics report.

The constraint trial succeeds when it reduces exchange-level contradictions
and false-premise adoption without worsening claim-normalized accuracy,
required action-result accuracy, repetition, or prose quality. A separate
transition trial must add correct, relevant changed-state detail without
regressing those measures.

## Not in scope

- a full-body physics, collision, gait, balance, cloth, or fluid simulator;
- the system choosing character behavior or sexual response;
- replacing the existing consent, relationship, wardrobe, pose, physiology, or
  perception owners;
- silently correcting impossible player actions in ways that change the scene;
- medical diagnosis or precise biomechanical measurements;
- storing generated narrator sentences as state;
- exposing intimate details in ordinary, non-intimate scenes.

## Open questions

**Five questions were ruled by the owner on 2026-07-30** (after the slice-2 QA
report) and have left this list; each ruling is recorded in its detail doc.
The first table now lists every remaining general question, including the
measured item-3 cost gate; the second lists the eight `romantic_touch`
permission-owner decisions from the 2026-07-31 review.

The five already ruled:

- adult eligibility — an explicit `adult | minor | unresolved` declaration,
  positive-adult required for romantic/intimate, fantasy and missing ages stay
  unresolved, the repo-wide fail-open age fallback untouched
  ([audit](romantic-contact-affordances.audit.md#owner-decisions-needed)).
  **Superseded 2026-08-03: the declaration was rolled back** (scope creep;
  species-scaled ages make a flat human 18 the wrong adult test), so the
  eligibility source for romantic/intimate contact is an open question again;
- actor control — player input commits only player-controlled movement; NPC
  movement originates NPC/narrator/simulation-side; narrator mode never
  bypasses target agency or consent (same audit section);
- foot-trial permission — incidental/affectionate touch stays
  permission-neutral; romantic/fetish-framed foot play is `romantic` and needs
  an explicit permission scope, never relabeled to make a trial commit (same
  audit section);
- contact persistence — durable event/action provenance plus a versioned
  active-contact projection captured in the chat's retake snapshot; never
  prompt-local
  ([shared-contact spec](romantic-contact-affordances.spec.contact-core.md#as-built--slice-1));
- regional condition ownership — body-surface state owns skin
  moisture/products/residue by subject, side, and surface; garment state owns
  wet footwear, feeding through material layers
  ([effects companion](romantic-contact-affordances.spec.effects.md)).

### Still open

Each row links to the detail doc that holds the evidence. "Blocking" names the
slice that cannot finish until the question is answered — a question with a
later blocking slice is not urgent, but it is not settled either.

| Question | Owner | Required decision | Blocking slice | Status |
| --- | --- | --- | --- | --- |
| **What replaces the rolled-back adult-eligibility declaration?** ([rollback note](finished/adult-eligibility.plan.md)) | Owner | The 2026-07-30 `adult \| minor \| unresolved` declaration + numeric-18 check were rolled back 2026-08-03 (species-scaled ages make a flat human 18 the wrong adult test). What positive eligibility proof, if any, gates romantic/intimate contact — and how it accounts for non-human ages | Slice 3, items 5–6 | **Reopened by the rollback** — needs owner ruling |
| **How detailed should foot regions be?** ([foot spec](romantic-contact-affordances.spec.foot.md)) | Product | Whether the shipped sixteen-surface map is the right granularity, or should shrink | Parked (owner ruling 2026-07-31) | **Parked** with the rest of the foot track until the MVP trial succeeds |
| **Which intimate changes are ready to consume?** ([intimate spec](romantic-contact-affordances.spec.intimate.md)) | Physiology plan | Which of erection, swelling, lubrication, flushing have authoritative reads | Slice 6 | Blocked on the deferred physiology plan |
| **What is the minimum intimate consent scope?** ([intimate spec](romantic-contact-affordances.spec.intimate.md)) | Owner | The floor for intimate contact, and whether the two lanes may claim parity | Slice 5 | Needs owner ruling |
| **Do marks ride the ruled body-surface store, and what are the transaction mechanics?** ([effects companion](romantic-contact-affordances.spec.effects.md)) | Engineering + owner | Whether pressure marks join the ruled store; the atomic/idempotent/branch-safe commit design | Slice 4 | Open |
| **How should scent and taste be phrased?** ([foot spec](romantic-contact-affordances.spec.foot.md); [intimate spec](romantic-contact-affordances.spec.intimate.md)) | Owner | Vocabulary that stays grounded without repetitive value judgments | Slice 5 (scent already deferred out of slice 2) | Open |
| **What must retakes capture beyond the contact projection?** ([contact-core spec](romantic-contact-affordances.spec.contact-core.md)) | Engineering | Whether effects, perception, selected cues, and repetition history need their own capture | Settled per slice as each ships | Open, incremental |
| **Is the NPC decision read's measured cost/latency acceptable?** ([actor-control spec](romantic-contact-affordances.spec.actor-control.md)) | Owner | One trigger-gated call per qualifying assistant reply, launched beside settlement but still inside the exchange lock; review shadow fire rate, p50/p95/p99 added latency, timeout rate, and cost per 100 replies | Item 3, movement authority | Foundation + shadow may proceed; owner ruling required before authority is enabled |
| **When do NPC posture/support changes join the permitted set?** ([actor-control spec](romantic-contact-affordances.spec.actor-control.md)) | Owner | "She sits beside you" needs support surfaces beyond `ground` (a seat vocabulary at minimum); deferred out of increments 1–3, owner may pull it forward as increment 4 with a named surface design | Item 3, post-increment 3 | Deferred by the spec; ruling only needed to pull it forward |

### `romantic_touch` permission-owner design

The continuation order puts the explicit `romantic_touch` permission owner
before the romantic proof, and **spec before implementation**: the questions
below are design decisions, not implementation details, and each one changes
what the stored grant means. Every row is **"needs owner ruling before the
`romantic_touch` owner is implemented — spec before implementation."**

| Question | Owner | Required decision | Blocking slice | Status |
| --- | --- | --- | --- | --- |
| **Directional or bilateral?** | Owner | Whether a grant runs one way (A may touch B) or establishes mutual permission | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **Persistent, scene-local, or action-local?** | Owner | The lifetime of a grant: does it survive the scene, the chat, or only the action it was given for | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **Exact scope semantics and implication rules** | Owner | Whether a scope implies narrower ones, or each is independent. **Exact-scope membership is the standing default** — a grant covers the named scope only — unless broader implication rules are explicitly ruled | Slice 3, step 3 | Needs owner ruling — spec before implementation; default stands until then |
| **Grant / deny / withdraw mechanics** | Owner | How each is expressed, whether deny is distinct from absence, and whether withdrawal is a separate act | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **NPC versus player authorship** | Owner | Who may author a grant for an NPC, and whether narrator mode may (the actor-control ruling says narrator mode never bypasses consent — this asks whether it may *create* one) | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **Retake and branch behavior** | Owner | Whether a grant is captured in the retake snapshot, and what a branch inherits | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **Provenance and effective time** | Owner | What a grant records about who gave it and when it takes effect | Slice 3, step 3 | Needs owner ruling — spec before implementation |
| **Effect of withdrawal on an active romantic contact** | Owner | Whether withdrawal ends a committed contact immediately, requires an explicit transition, or applies only to new attempts | Slice 3, step 3 | Floor already implemented (owner review, 2026-07-31): the contract ends a live contact whose permission lapses and blocks the next attempt. Open: whether the permission owner's spec keeps immediate end or adds an explicit transition beat |

## Technical companions

- [Truth-source audit](romantic-contact-affordances.audit.md) — the
  promotion-time lane evidence and the three owner rulings it produced
- [Technical index and ownership map](romantic-contact-affordances.spec.md)
- [Shared contact and action contracts](romantic-contact-affordances.spec.contact-core.md)
- [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md)
- [Scene and body-relations owner](romantic-contact-affordances.spec.scene.md) —
  the minimal scene owner added in slice 3A
- [NPC actor control through the live lane](romantic-contact-affordances.spec.actor-control.md) —
  item 3's stable actor/contact references, field-by-field evidence proof,
  chronology, post-settle cut, durable envelope/CAS, shadow gate, and three
  authority increments (revised 2026-08-02 after pre-implementation review)
- [Foot-contact domain](romantic-contact-affordances.spec.foot.md)
- [Intimate-region domain](romantic-contact-affordances.spec.intimate.md)
- [Follow-ups record](finished/romantic-contact-affordances.followups.md) —
  complete and archived 2026-07-31
