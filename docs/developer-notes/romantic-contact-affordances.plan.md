# Romantic contact affordances

Status: active.

**Next:** item 3, remove the rolled-back participant-declaration system
completely before continuing actor-control authority work.

Shipped foundation: slices 0–2 landed 2026-07-30; slices 3A and 3A.1 plus the
affectionate-contact technical MVP and its repairs landed 2026-07-31; the
internal trial passed 2026-08-01; and production enablement completed
2026-08-02 with `CHAT_CONTACT_ACTIONS` and `CHAT_PHYSICAL_CONSTRAINTS` set to
`on`. Actor-control delivery steps 1–3 also landed 2026-08-02, but the shadow
measurement and authority increments remain.

Detailed shipped evidence lives in the
[truth-source audit](romantic-contact-affordances.audit.md),
[technical companions](#technical-companions),
[trial report](romantic-contact-affordances.trial.md), and
[archived follow-up record](finished/romantic-contact-affordances.followups.md).
This active plan keeps only the shipped facts and invariants needed to execute
the remaining work.

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

The first implementation cannot treat narrator prose as physical truth.

- **Legacy romantic chat:** Structured clothing and coverage, retake snapshots,
  and a turn-level sensory allowance exist. Authoritative fine pose, distance,
  support, body-surface contact, per-sense exposure, and a permission ledger do
  not. The intimate-scene signal and touch-welcomeness reaction are not
  permission grants.
- **Successor chat:** World location, event cuts, observations, and a fail-closed
  permission ledger exist. Regional pose, articulation, support, active
  body-surface contact, and the structured clothing adapter remain incomplete.
- **Body surfaces:** Stable anatomy and appearance attributes exist. Shared
  regional moisture, products, residue, pressure marks, and contact temperature
  do not yet have complete owners.
- **Physiology:** The general physiology plan remains deferred. Erection,
  swelling, lubrication, vascular change, sweat, and temperature cannot be
  inferred merely because a scene is intimate.

Every missing source must be handled in one of three ways: build its minimal
owner here, depend on a named prerequisite, or omit the affected observation.
“The narrator said it last turn” is never a truth source. The verified record is
the [truth-source audit](romantic-contact-affordances.audit.md), published
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

The first trial catalog covers:

- **Contact pressure and area:** Distinguish a light toe trace, narrow heel
  contact, and broad sole pressure.
- **Regional texture:** Let the arch, ball, heel, toe pad, nail, and top of foot
  differ without separately authoring every surface.
- **Glide and drag:** Combine motion with the actual substance, fabric, skin
  texture, and pressure. Water, sweat, lotion, and oil do not share one generic
  friction rule.
- **Foot and toe position:** Describe an existing position and footwear
  restriction without inventing an emotional toe curl.
- **Nail contact:** Distinguish a nail trace or edge from soft toe contact. A
  scratch still requires a recorded event.
- **Footwear filtering:** Block bare-skin claims and report what flexible fabric
  or rigid footwear can transmit.
- **Pressure marks:** Surface real sock, strap, or shoe marks after removal; do
  not create them merely because footwear was worn.
- **Surface transfer:** Track lotion, water, dirt, or residue only after a real
  transfer is recorded.
- **Contact warmth:** Report relative warmth or coolness only from current body
  and environment state.
- **Close scent:** Use current exposure, sweat, products, cleanliness, distance,
  and airflow rather than a permanent foot label.

## Candidate intimate-region observations

The second trial should support permission-gated scenes across the anatomy a
character actually has, including external genitals, breasts and nipples, the
perineum, and anal contact where relevant.

- **Effective access and exposure:** Distinguish covered, visible through sheer
  fabric, touch through fabric, directly exposed, and internally accessible
  where appropriate.
- **Contact location, pressure, and area:** Ground which surfaces touch and
  whether contact is light, narrow, broad, still, or moving.
- **Clothing contour and compression:** Describe shape or movement transmitted
  through a garment without claiming direct anatomical access.
- **Current surface moisture:** Use authoritative lubrication, sweat, water, or
  products; never treat an intimate scene as automatically wet.
- **Friction and glide:** Combine motion, pressure, material layers, and current
  moisture.
- **Soft-tissue response:** Describe compression, displacement, rebound, or
  support only when current contact and anatomy justify it.
- **Live arousal-related shape:** Use recorded physiology such as erection,
  swelling, nipple erection, or vascular change; never guess from genre or
  contact alone.
- **Fluid or product transfer:** Report transfer only after an event records it
  on the receiving body or garment surface.
- **Visible aftermath:** Surface real dampness, impressions, displacement,
  residue, or flushing after the state owner records it.
- **Action alignment:** Require the action, body parts, path, clothing, and
  current pose to agree before offering sensory detail.

This catalog is intentionally wider than the first implementation slice. It
defines cases to prove without committing to simulate them all at once.

## Rules that protect agency and continuity

- This system describes physical consequences. It does not decide desire,
  consent, attraction, pleasure, climax, withdrawal, or any other character
  choice or emotional response.
- Any interpersonal body contact must respect actor control and target agency.
  A player describing an NPC's voluntary movement does not make that movement
  committed truth. This applies to every contact, including ordinary ones.
- **Permission is scoped, not universal** (owner ruling, 2026-07-30). Only
  **romantic and intimate** contact requires the applicable permission scope.
  Ordinary incidental and affectionate social touch is **permission-neutral**:
  it is the everyday contact the lane already narrates, and requiring a grant
  the lane cannot produce would gate ordinary behaviour behind machinery that
  does not exist. Foot play framed as romantic or fetish attention is
  `romantic` and needs the scope — it is never relabeled `affectionate` to let
  a trial commit.
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

The original numbering is preserved so links and companion specifications do not
need to be rewritten. Completed gates are separated from the active queue so a
coding agent can see the next task immediately.

### Shipped foundation

- **Slices 0–2 — shipped 2026-07-30:** Published the truth-source audit; built
  the lane-neutral contact lifecycle; and proved the fixture-driven foot domain.
  The foot domain remains production-unregistered until its place in the wiring
  order.
- **Slices 3A and 3A.1 — shipped 2026-07-31:** Hardened agency binding,
  lifecycle validation, scene/body relations, persistence acknowledgments,
  stale-write behavior, restoration, and unavailable-versus-rejected semantics.
- **Item 1 — affectionate-contact technical MVP and repairs — shipped
  2026-07-31:** Added the durable contact ledger and retake projection,
  conservative player-side starts and endings, current-exchange wardrobe
  settlement, typed reach constraints, and the minimal NPC-authored ending
  producer. The exact implementation and regressions are recorded in the
  [contact-core spec](romantic-contact-affordances.spec.contact-core.md),
  [effects companion](romantic-contact-affordances.spec.effects.md), and
  [archived follow-up record](finished/romantic-contact-affordances.followups.md).
- **Item 2 — internal trial:** Ran 2026-07-31 and
  [passed](romantic-contact-affordances.trial.md) by owner verdict 2026-08-01.
  The required repairs and targeted reruns passed. Production enablement
  completed 2026-08-02; both contact flags are live. The remaining watch item is
  the NPC-ending producer’s first organic production occurrence.

These entries are historical gates, not work remaining in the continuation
queue.

### Remaining continuation order

#### 3. Remove the rolled-back participant-declaration system completely — next

Delete both editor dropdowns and their form state. Remove the associated
profile-schema, public-profile, API-validation, resolver, adapter, blocker,
deep-link, diagnostic, contact-core, fixture, test, and export paths, plus any
feature-specific helper left without another caller.

The old values lived inside JSONB rather than a dedicated column, so ship an
idempotent data cleanup that removes the obsolete key from every character and
persona profile. Verify that a repository-wide residue search finds no runtime
reference and a production query finds zero stored keys. Do not replace the
declaration with another field or gate here; broader moderation is separate
pre-launch work outside this plan.

#### 4. Finish actor control through the live lane — partially built

The deterministic NPC contact-ending producer shipped with item 1 and remains
the frozen ending floor. The pure decision foundation, durable
assistant-message envelope, guarded atomic save, and one-call-per-reply shadow
leg shipped 2026-08-02 behind `CHAT_NPC_SCENE_DECISION_SHADOW`, default off.

Next, enable and review the shadow measurement. Authority remains blocked until
accuracy, fire rate, p50/p95/p99 added latency, timeout rate, and cost are
acceptable. If approved, roll out authority in this order: movement, contact
starts, then contact updates. The
[actor-control spec](romantic-contact-affordances.spec.actor-control.md) owns the
detailed evidence rules, chronology, retries, persistence, and rollout gates.

#### 5. Specify and implement the explicit `romantic_touch` permission owner

Obtain the owner rulings listed under
[`romantic_touch` permission-owner design](#romantic_touch-permission-owner-design),
write the specification, then implement it. Do not infer a permission grant from
scene framing, relationship state, or the existing intimate-scene signals.

#### 6. Run the genuinely romantic proof

After actor control and the permission owner are authoritative, run a
permission-gated live case without widening the contact system’s authority or
inferring permission from scene framing.

### Parked

These items were parked by owner ruling 2026-07-31 and remained parked after the
2026-08-01 PASS verdict. Do not build them until explicitly reprioritized:

- additional foot-region granularity;
- marks and material transfer;
- intimate physiology;
- successor-lane parity;
- channel-aware foot narration and production registration with positive
  texture/glide;
- further generalized contact abstractions beyond the MVP.

### Later slices

- **Slice 4 — contact-caused changes:** When unparked, connect marks and
  material transfer through explicit owner events with atomicity, provenance,
  idempotency, and branch/retake safety.
- **Slice 5 — intimate access and contact:** Reuse the contact foundation only
  after permission scope, actor control, exposure, and point-of-view gates are
  authoritative.
- **Slice 6 — live physiology and aftermath:** Consume only physiology-owned
  live reads. Do not build a local substitute for missing physiology.
- **Slice 7 — generalization and parity:** Decide which helpers belong in a
  general body-contact library and whether successor parity ships here or as a
  named follow-up.

### Standing implementation constraints

- Romantic contact emits exactly four outcomes: `committed`,
  `explicit_transition_required`, `rejected`, and `unresolved`. It never
  emits `partially_committed`.
- Missing authority is `unresolved`, not a refusal.
- Contact state and effects must be durable, idempotent, and retake/branch safe.
- The foot domain’s earlier review corrections, backfill, and registry defaults
  are complete. Production registration waits only for its remaining place in
  the wiring order.

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

Four product decisions are already settled and should not be reopened by an
implementation agent:

- **Actor control:** Player input commits only player-controlled movement. NPC
  movement must originate on the NPC/assistant/simulation side. Narrator mode
  never bypasses target agency or permission.
- **Foot-trial permission:** Incidental and affectionate touch is
  permission-neutral. Romantic or fetish-framed foot play is romantic and
  requires the relevant scope; it is never relabeled to make a trial commit.
- **Contact persistence:** Use durable event/action provenance plus a versioned
  active-contact projection captured in the retake snapshot. Contact is never
  prompt-local.
- **Regional condition ownership:** Body-surface state owns skin moisture,
  products, and residue. Garment state owns wet footwear and other garment
  conditions. Contact combines those facts but does not own them.

### General questions still open

#### Is the NPC decision read’s measured cost and latency acceptable?

**Owner:** Product. **Blocks:** item 4 movement authority.

Review shadow accuracy and fire rate, p50/p95/p99 added latency, timeout rate,
and cost per 100 replies before enabling any authority increment. The
[actor-control spec](romantic-contact-affordances.spec.actor-control.md) permits
the foundation and shadow run but not authority without this ruling.

#### Which intimate changes are ready to consume?

**Owner:** Physiology plan. **Blocks:** slice 6.

Determine which of erection, swelling, lubrication, and flushing have
authoritative live reads. This remains blocked on the deferred physiology plan;
contact must not create substitutes.

#### What is the minimum intimate permission scope?

**Owner:** Product. **Blocks:** slice 5.

Set the permission floor for intimate contact and decide when the legacy and
successor lanes may claim parity. See the
[intimate spec](romantic-contact-affordances.spec.intimate.md).

#### Do marks use the body-surface store, and how are they committed?

**Owner:** Product for ownership; engineering for mechanics. **Blocks:** parked
slice 4.

Confirm that pressure marks use the ruled body-surface store. Engineering must
then specify an atomic, idempotent, provenance-bearing commit that behaves
correctly across retries, retakes, and branches. See the
[effects companion](romantic-contact-affordances.spec.effects.md).

#### How should scent and taste be phrased?

**Owner:** Product. **Blocks:** slice 5; scent remains deferred from slice 2.

Choose grounded vocabulary that avoids repetitive or permanent value judgments.
See the [foot spec](romantic-contact-affordances.spec.foot.md) and
[intimate spec](romantic-contact-affordances.spec.intimate.md).

#### What must retakes capture beyond the contact projection?

**Owner:** Engineering. **Blocks:** settled incrementally as each slice ships.

Decide whether effects, perception, selected cues, and repetition history need
their own captured state. See the
[contact-core spec](romantic-contact-affordances.spec.contact-core.md).

#### How detailed should foot regions be?

**Owner:** Product. **Status:** parked.

When the foot track is reprioritized, decide whether to retain the shipped
sixteen-surface map or reduce its granularity. See the
[foot spec](romantic-contact-affordances.spec.foot.md).

#### When should NPC posture and support changes become authoritative?

**Owner:** Product. **Status:** deferred until after item 4 increment 3.

“She sits beside you” requires support surfaces beyond `ground`, including at
least a typed seat vocabulary. The actor-control spec excludes this from
increments 1–3; pull it forward only as a named increment 4 with a surface
design.

### `romantic_touch` permission-owner design

All eight decisions below require owner rulings before item 5 can be specified
or implemented.

1. **Directional or bilateral?** Decide whether a grant runs one way—A may
   touch B—or creates mutual permission.
2. **Persistent, scene-local, or action-local?** Decide whether a grant lasts
   for one action, one scene, the chat or story branch, or another defined
   boundary.
3. **What are the scope implication rules?** Decide whether any scope implies
   another. Exact-scope membership remains the default unless explicitly
   changed: a grant covers only its named scope.
4. **How do grant, denial, and withdrawal work?** Define acceptable evidence,
   whether denial differs from absence, and whether withdrawal is a separate
   act.
5. **Who may author permission for an NPC or player?** Define the NPC/player
   authorship boundary and whether narrator mode may create a grant. Narrator
   mode may never bypass permission.
6. **What happens on retake and branch?** Define what the retake snapshot
   captures and what permission state a new branch inherits.
7. **What provenance is stored, and when does a grant take effect?** Record who
   granted what to whom, its source and scope, and its effective position in the
   committed chronology.
8. **What does withdrawal do to active contact?** Decide whether it ends a
   committed contact immediately, requires an explicit transition, or affects
   only new attempts. The current contract floor ends live contact when its
   permission lapses and blocks the next attempt; the new owner must either
   preserve that rule or explicitly replace it.

## Technical companions

- [Truth-source audit](romantic-contact-affordances.audit.md) — the
  promotion-time lane evidence and the two owner rulings it produced
- [Technical index and ownership map](romantic-contact-affordances.spec.md)
- [Shared contact and action contracts](romantic-contact-affordances.spec.contact-core.md)
- [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md)
- [Scene and body-relations owner](romantic-contact-affordances.spec.scene.md) —
  the minimal scene owner added in slice 3A
- [NPC actor control through the live lane](romantic-contact-affordances.spec.actor-control.md) —
  item 4's stable actor/contact references, field-by-field evidence proof,
  chronology, post-settle cut, durable envelope/CAS, shadow gate, and three
  authority increments (revised 2026-08-02 after pre-implementation review)
- [Foot-contact domain](romantic-contact-affordances.spec.foot.md)
- [Intimate-region domain](romantic-contact-affordances.spec.intimate.md)
- [Follow-ups record](finished/romantic-contact-affordances.followups.md) —
  complete and archived 2026-07-31
