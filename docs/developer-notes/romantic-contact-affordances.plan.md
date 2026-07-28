# Romantic contact affordances

Status: next (promoted from deferred/ 2026-07-28 — foot-first. The committed
first scope is delivery slices 0–4: everything needed to make the
[foot domain](romantic-contact-affordances.spec.foot.md) fully work in romantic
chat, including committed contact effects. Intimate regions — slices 5–6 — stay
in this plan and queue behind the foot proof. Each technical companion spec
ships and moves to `finished/` individually as its slice lands; this plan moves
to shipped only when the owner is satisfied all necessary contact affordances
are covered. Sequenced directly behind
[body-attribute-affordances.plan.md](body-attribute-affordances.plan.md), which
builds the shared affordance core this plan consumes.)

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

These are observations, not prose. The narrator still decides how—or
whether—to weave them into a reply.

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
| Glide and drag | Combines current sliding motion with lotion, sweat, water, fabric, skin texture, and pressure. |
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
- Adult intimate contact must pass the authoritative consent and policy check
  before a committed contact exists. Missing or uncertain permission fails
  safely.
- Possibility is not actuality. Reachable, sensitive, compressible, or capable
  of becoming wet does not mean touched, aroused, compressed, or wet.
- Clothing changes require real wardrobe actions. The contact layer cannot
  undress or reposition garments for narrative convenience.
- Live body changes come from physiology and body state. Stable character
  attributes describe baseline anatomy, not the current response.
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
  removed.
- [Physiology](deferred/physiology.plan.md) owns live responses such as erection,
  swelling, lubrication, flushing, temperature, and sweat.
- [Skin surface](body-attribute-affordances.spec.skin-surface.md) owns the
  readable surface effects of moisture, products, marks, and residue.
- [Soft tissue](body-attribute-affordances.spec.soft-tissue.md) supplies the
  reusable body-shape and deformation ideas that contact can consume.
- [Recognizable features and visual memory](body-attribute-affordances.spec.recognizable-features.md)
  provide the precedent for noticing important details without repeating them.

The contact layer owns none of those source facts. It brings their current
answers together for one interaction.

## Delivery outline

The committed first roadmap scope is slices 0–4 — the foot proof, end to end.
Slices 5–6 follow under this same plan once the foot trial passes; slice 7
closes the loop.

### Slice 0 — confirm the truth sources

Inventory what chat and successor chats already know about pose, reach,
clothing, body surfaces, physiology, consent, perception, and turn capture.
Resolve gaps before treating any field as authoritative.

### Slice 1 — shared contact foundation

Add one small, lane-neutral way to represent an allowed contact: the two
surfaces, any material between them, pressure, movement, time, and evidence.
Separate an attempted action from a committed contact.

### Slice 2 — foot contact proof

Add the foot surface map and ship pressure, regional texture, and footwear
filtering first. Then add sliding and contact warmth. Use authored fixtures
rather than open-ended narrator interpretation.

### Slice 3 — romantic-chat evaluation

Offer at most one or two grounded cues to the romantic-chat narrator behind a
feature flag. Compare continuity errors, clothing errors, repetition, sensory
specificity, and prose quality with the existing path.

### Slice 4 — changes caused by contact

Connect marks and material transfer through explicit events owned by body,
clothing, or action state. Prove that retakes and branches restore the same
result.

### Slice 5 — intimate access and contact

Reuse the proven contact foundation for adult intimate regions. Start with
effective exposure, material-between, contact pressure, clothing contour,
friction, and current surface moisture. Keep intimate gates fail-closed.

### Slice 6 — live physiology and aftermath

Add only the physiology-owned shape and surface changes that have authoritative
inputs. Connect visible or tactile aftermath without creating a second arousal
model.

### Slice 7 — decide what generalizes

After foot and intimate fixtures work, decide which helpers truly belong in a
general body-contact library and which should remain region-specific.

## How we would judge the trial

Use a small, repeatable set of adult romantic-chat scenes rather than relying
only on free-form play. Each scene should be run with the feature off and on.
Review:

- physical contradictions;
- clothing and exposure contradictions;
- invented arousal, consent, movement, or reactions;
- useful sensory specificity;
- repetition across sustained contact;
- whether a change becomes mentionable at the right time;
- consistency between original replies and retakes;
- whether the narrator sounds natural rather than like a physics report.

The trial succeeds when it reduces contradictions and adds concrete variation
without making replies longer, more clinical, or repetitive.

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

- **Which pose and contact facts are dependable today?** The first slice must
  identify the authoritative source in both chat lanes
  ([shared-contact spec](romantic-contact-affordances.spec.contact-core.md)).
- **How much movement may be treated as an ordinary part of an action?** A
  slight lean or ankle turn may be harmless; clothing removal, major posture
  changes, and resistance never are
  ([shared-contact spec](romantic-contact-affordances.spec.contact-core.md)).
- **Where should a committed contact live?** It may be a turn event, captured
  scene state, or both; it cannot be only an inference made while prompting
  ([shared-contact spec](romantic-contact-affordances.spec.contact-core.md)).
- **How detailed should foot regions be?** The surface map should distinguish
  meaningful play without becoming an anatomy mesh
  ([foot spec](romantic-contact-affordances.spec.foot.md)).
- **Who owns regional moisture and residue?** Contact can distribute an existing
  source or calculate transfer, but it cannot invent or privately persist one
  ([foot spec](romantic-contact-affordances.spec.foot.md);
  [intimate spec](romantic-contact-affordances.spec.intimate.md)).
- **Which intimate changes are ready to consume?** Erection, swelling,
  lubrication, flushing, and similar reads depend on the physiology plan's
  authoritative first slice
  ([intimate spec](romantic-contact-affordances.spec.intimate.md)).
- **What is the minimum intimate consent scope?** The successor consent ledger
  is stronger than legacy chat's current signals; the trial must not pretend
  those lanes provide the same guarantee
  ([intimate spec](romantic-contact-affordances.spec.intimate.md)).
- **How should scent and taste be phrased?** The vocabulary must stay grounded
  in authored baseline and current condition without turning bodies into
  repetitive value judgments
  ([foot spec](romantic-contact-affordances.spec.foot.md);
  [intimate spec](romantic-contact-affordances.spec.intimate.md)).
- **What must be captured for retakes?** The committed contact, state changes,
  perception result, selected cues, and repetition history may all matter
  ([shared-contact spec](romantic-contact-affordances.spec.contact-core.md)).

## Technical companions

- [Technical index and ownership map](romantic-contact-affordances.spec.md)
- [Shared contact and action contracts](romantic-contact-affordances.spec.contact-core.md)
- [Foot-contact domain](romantic-contact-affordances.spec.foot.md)
- [Intimate-region domain](romantic-contact-affordances.spec.intimate.md)
