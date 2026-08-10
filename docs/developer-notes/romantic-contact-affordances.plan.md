# Romantic contact affordances

Status: active — the affectionate tier is live for players, and every
construction item through item 5 is shipped. **Live:** slices 0–2, 3A and
3A.1, the affectionate-contact MVP and its passed trial (items 1–2, turned on
in production 2026-08-02), the retired-declaration cleanup (item 3), and —
since 2026-08-10 — item 4's shadow measurement, whose window is accumulating on
a build that carries the measurement instrument. **Shipped but dark:** item 4's
three authority increments (behind the staged authority flag) and item 5's
`romantic_touch` permission owner. **Remaining:** review the measurement
window and take the owner's ruling on its measured accuracy, cost, and latency;
enable authority one kind at a time; then run item 6's permission-gated
romantic proof.

Outcome: A player can touch a character during a chat and have the story keep
track of that touch — where it lands, what clothing is in the way, and when it
ends — so that a reply stops describing a bare shoulder that is still under a
coat.

The per-item record is the [delivery outline](#delivery-outline). Supporting
evidence lives in the
[truth-source audit](romantic-contact-affordances.audit.md),
[technical companions](#technical-companions),
[trial report](romantic-contact-affordances.trial.md), and
[archived follow-up record](finished/romantic-contact-affordances.followups.md).
The exact production switch settings are owned by the
[technical index](romantic-contact-affordances.spec.md) §"Feature flags".
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

- **Character chat:** Structured clothing and coverage, retake snapshots, a
  turn-level sensory allowance, and — since this plan's own work went live —
  distance, support, and an active body-surface contact record all exist. Fine
  pose and per-sense exposure still do not. A permission ledger exists but is
  switched off; the intimate-scene signal and the touch-welcomeness reaction are
  not permission grants and never become them.
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
“The narrator said it last turn” is never a truth source. The
[truth-source audit](romantic-contact-affordances.audit.md) is the verified
record of what was missing when this plan started, on 2026-07-30; the technical
index's [capability status](romantic-contact-affordances.spec.md) is the current
picture.

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
- **Item 3 — retired declaration cleanup — shipped 2026-08-04:** The abandoned
  declaration system and its contact-core seam were removed end to end, with no
  replacement field or gate. Contacts persisted by older builds still parse,
  pinned by a regression test, and migration 0095 removed stored profile
  residue. Detailed proof lives in the finished follow-up record and migration.
- **Item 4 — NPC actor control through the live lane — shipped 2026-08-10
  (authority dark):** The deterministic NPC contact-ending producer from item 1
  remains the frozen ending floor. Everything beyond it is now built and
  shipped: the pure decision foundation, the durable per-reply decision record,
  and the guarded atomic save (2026-08-02); the one-call-per-reply shadow
  measurement leg; the three authority increments — an NPC moving relative to
  one person, starting one affectionate hand touch, and changing the gesture of
  a touch she is already making — behind a staging control that enables them
  one kind at a time; and the measurement instrument (per-decision spend and
  waiting-time telemetry plus the aggregate review report, 2026-08-10). The
  shadow measurement was switched on in production 2026-08-10 on a build
  carrying that instrument, so its window is accumulating. **The authority
  increments stay dark** until the owner's ruling on the measured window — that
  review is the remaining item-4 work below. The
  [actor-control spec](romantic-contact-affordances.spec.actor-control.md) owns
  the evidence rules, chronology, retries, persistence, rollout gates, and the
  instrument itself.
- **Item 5 — the explicit `romantic_touch` permission owner — shipped
  2026-08-04 (dark until item 6):** The product rulings were settled 2026-08-04
  and are summarized under
  [`romantic_touch` permission-owner rulings](#romantic_touch-permission-owner-rulings);
  the
  [permission-owner specification](romantic-contact-affordances.spec.permission.md)
  was implemented the same day (see its §As built): the branch-local
  directional grant ledger and standing-grant projection, the resolver's
  exact-scope read with the player-target exception, the conservative NPC-side
  grant/denial/withdrawal decision, the audited developer-menu override,
  revocation ending dependent contact atomically, and the next-reply stop
  instruction. Everything is behind `CHAT_ROMANTIC_PERMISSION` (off, and
  effective only while the affectionate tier's own switch is on; the developer
  override has its own separate capability), so production behavior is
  unchanged until the owner enables it for the item-6 proof. The MVP stayed
  deliberately narrow: one exact, directional `romantic_touch` scope for
  romantic contact aimed at an NPC, implying no kissing, intimate touch,
  undressing, nudity exposure, or sex. Test/development permission changes go
  through the developer menu's structured, audited path only; chat prompts
  never act as administrative overrides. Relationship-based revocation remains
  reserved, per ruling 2.

These entries are historical gates, not work remaining in the continuation
queue.

### Remaining continuation order

#### 4. Review the shadow measurement window and enable authority

The construction shipped (see the item-4 entry above); what remains is
operational and strictly ordered. The measurement window opened 2026-08-10.
Let it accumulate real chat replies, then produce the review figures with the
measurement report and label its review-corpus export for the accuracy pass —
the [actor-control spec](romantic-contact-affordances.spec.actor-control.md)
§"Execution, flags, and cost gate" owns the instrument and the required
figures. Authority stays blocked until accuracy, fire rate, p50/p95/p99 added
latency, timeout rate, and cost are acceptable to the owner. If approved,
enable authority in this order — movement, contact starts, then contact
updates — each step a one-value staging change.

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

Five product decisions are already settled and should not be reopened by an
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
- **How close two people are only counts while they are together** (settled
  2026-08-04, applies to both lanes): the game forgets how far apart two
  characters were standing when one of them leaves, when the scene moves to a
  new place, or when the story clock skips ahead — the same moments that
  already end whatever they were touching. It does not forget on an ordinary
  turn. Forgetting means the distance is simply unknown again, not "far away",
  and coming back does not restore it: somebody has to walk over. Detail in the
  [actor-control spec](romantic-contact-affordances.spec.actor-control.md)
  §"Pair relations require continuous co-presence".

### General questions still open

#### Is the NPC decision read’s measured cost and latency acceptable?

**Owner:** Product. **Blocks:** every item-4 authority increment, and item 6
behind them. **Blocked on:** the measurement window, open since 2026-08-10 and
still accumulating.

The window is running on a build that carries the spend telemetry. Once it has
accumulated enough real replies, the measurement report produces the fire rate,
p50/p95/p99 added latency, timeout rate, and cost-per-100-replies figures this
ruling needs, and its review-corpus export is what the accuracy judgment is
made from. The
[actor-control spec](romantic-contact-affordances.spec.actor-control.md) permits
the foundation and the shadow run but not authority without this ruling.

#### Which intimate changes are ready to consume?

**Owner:** Physiology plan. **Blocks:** slice 6.

Determine which of erection, swelling, lubrication, and flushing have
authoritative live reads. This remains blocked on the deferred physiology plan;
contact must not create substitutes.

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

### `romantic_touch` permission-owner rulings

These decisions were settled by the owner on 2026-08-04. They are no longer
open questions for an implementation agent.

1. **Permission is directional when an NPC is the target.** If Alex may touch
   Mara romantically, that says nothing about whether Mara may touch Alex.
   NPC-to-NPC permission therefore needs a separate grant in each direction.

   The player is the deliberate exception. Vesper does not need to calculate a
   standing grant before an NPC tries to touch the player, because the player
   writes their own reaction. The NPC still needs authority over its own action,
   and the narrator must not decide that the player accepts, reciprocates, or
   enjoys it.

2. **A grant belongs to one story branch.** It persists across scenes in that
   branch until it is withdrawn or automatically revoked. It never leaks into
   an unrelated chat, a character copy, or a sibling branch.

   When authoritative relationship-state transitions exist, a sufficiently
   large decline may revoke a grant. For example, a fall from `cherished` to
   `cold` may revoke Alex's permission to touch Mara. A relationship increase
   must never create or silently restore permission; a new grant is required.
   Exact thresholds remain future relationship-system work.

3. **Scopes do not imply one another.** The MVP stores only the exact
   `romantic_touch` scope. It does not silently include kissing, intimate
   anatomy, undressing another participant, exposing oneself to them, or sex.

4. **Grant, denial, absence, and withdrawal are different facts.** A production
   grant may come from explicit NPC dialogue or unambiguous NPC-authored conduct
   that directly offers the contact. Do not infer it from attraction, arousal,
   relationship label, lack of resistance, or scene tone. A denial of one
   attempt does not necessarily erase a standing grant; wording such as “not
   now” normally rejects the present attempt, while “do not touch me like that
   anymore” withdraws the standing grant.

   The first implementation must be tested against adversarial and natural
   dialogue because simple consent detection is expected to need refinement.
   Use a grounded structured decision, not a broad keyword detector.

5. **Nobody may author permission for somebody else.** Player input and
   player-authored narrator mode cannot create, alter, or withdraw an NPC's
   permission. An NPC grant must originate from NPC-side assistant output or
   the simulation.

   Tests need a deliberate override, so authorized development/test users may
   change permission and relationship values through the developer menus. That
   is a structured, auditable control path; chat text is never an admin command
   and must not activate the override.

6. **Retakes and branches restore permission with the story state.** Retaking
   an assistant reply restores the permission state from before that reply and
   removes any grant, denial, or withdrawal created by the discarded reply. A
   branch inherits the state at its fork point, and later changes stay local to
   that branch.

7. **Permission never works retroactively.** Every permission change records
   who changed what for whom, the exact scope, its source message or event, its
   story/branch identity, and its effective position in committed chronology.
   A grant may authorize a clearly later action in the same committed reply,
   but never an earlier action. Retake cleanup from ruling 6 prevents a
   discarded reply's permission from leaking backward; ordered provenance
   covers the separate same-reply case.

8. **Revocation ends permission-dependent active contact.** The permission
   change and the contact ending are committed in order. The contact is no
   longer active once permission lapses. If the prose has not already shown the
   stop or separation, the next narrator input receives a high-priority,
   binding state-change or action-outcome instruction so the response handles
   it naturally rather than silently continuing the contact.

9. **The long-term model is a permission matrix, not one romance score.**
   `cherished` or `smitten` describes how an NPC feels; it does not by itself
   establish readiness for kissing, nudity, intimate touch, undressing, or sex.
   Future work should add exact directional scopes and per-scope relationship
   revocation thresholds. The current MVP must stay simple without claiming
   those future scopes are covered.

The
[permission-owner specification](romantic-contact-affordances.spec.permission.md)
owns the technical event, projection, ordering, override, rollback, and test
requirements.

## Technical companions

- [Truth-source audit](romantic-contact-affordances.audit.md) — the
  promotion-time lane evidence and the two owner rulings it produced
- [Technical index and ownership map](romantic-contact-affordances.spec.md)
- [Shared contact and action contracts](romantic-contact-affordances.spec.contact-core.md)
- [Directional permission owner](romantic-contact-affordances.spec.permission.md) —
  item 5's branch-local grant ledger, exact scope, chronology, revocation,
  developer override, and rollback rules
- [Observations, effects, and presentation](romantic-contact-affordances.spec.effects.md)
- [Scene and body-relations owner](romantic-contact-affordances.spec.scene.md) —
  the minimal scene owner added in slice 3A, live in character chat since
  2026-08-02
- [NPC actor control through the live lane](romantic-contact-affordances.spec.actor-control.md) —
  item 4's stable actor/contact references, field-by-field evidence proof,
  chronology, post-settle cut, durable envelope/CAS, shadow gate, and three
  authority increments — all built, all dark
- [Foot-contact domain](romantic-contact-affordances.spec.foot.md)
- [Intimate-region domain](romantic-contact-affordances.spec.intimate.md)
- [Follow-ups record](finished/romantic-contact-affordances.followups.md) —
  complete and archived 2026-07-31
