# Body-attribute visual affordances

Status: active — **slices 0–4 and the slice 5 wiring shipped 2026-07-28**
(hair vocabulary split, shared core, hair domain, chat-lane
wetness/environment owners + adapter + retake capture, and the
`CHAT_AFFORDANCE_CUES` narrator cue path, default OFF). **Slice 5 itself is
not complete until its comparison trial runs** — the owner-gated live-model
comparison of contradiction rate, repetition, specificity, and naturalness
against the current appearance path is pending. Also remaining before the
release contract closes: slice 6 (garment second domain — ruled 2026-07-28),
slice 7 (recognition memory), slice 8 (image decision), the successor-lane
adapter follow-up, and per-companion rulings. The shared foundation the
[romantic-contact plan](romantic-contact-affordances.plan.md) consumes is
live.

## In one sentence

Turn stable appearance details and trustworthy live state into a few grounded
visual observations, so bodies, hair, skin, and clothing behave consistently
without asking the narrator to invent the physical result.

## The experience we want

Consider shoulder-length, dense hair after rain. If the hair is loose, wet,
touching an exposed neck, and caught in a light breeze, the system should know
that damp strands may clump and cling while the water weight suppresses most
wind movement. The narrator may then say that damp blonde strands cling to the
character's neck.

The narrator should receive that current observation, not a page of hair
measurements and not a prewritten sentence. It still decides how—or
whether—to use the detail.

The common result should be silence. Existing appearance descriptions still
introduce ordinary, stable features. This system speaks up only for a current
effect, meaningful change, useful constraint, or action-relevant relationship.

## Why it matters

This work should:

- reduce contradictions between appearance, clothing, pose, weather, and live
  body state;
- make the same physical situation behave consistently across turns;
- suppress attractive-sounding effects when their cause is missing;
- give the narrator one or two useful details instead of a body inventory;
- help distinctive features make characters recognizable without repeating
  them every turn;
- eventually give scene images the same grounded visual facts as prose.

Success means more selective and reliable detail, not simply more body
description.

## What exists today—and what does not

Promotion does not make every required source fact available. The first slice
must preserve this distinction:

| Area | Current position |
| --- | --- |
| Stable appearance | Canonical attributes, body locations, body configuration, and provenance already exist. Some vocabularies still mix several physical ideas in one value and need cleanup before calculation. |
| Clothing | Legacy character chat has structured garment instances, coverage, presentation, wetness, and local garment marks. Its narrator cues are still behind a tuning flag. The successor clothing adapter and affordance integration remain unfinished. |
| Pose and contact | Neither chat lane currently owns dependable body-region pose, support, or surface-contact truth. Free-text narration and image-pose text are not authoritative substitutes. |
| Weather and force | Current wind, precipitation, impulses, and body motion are not yet available as one dependable cross-lane read. A phenomenon that lacks its actual cause must remain silent. |
| Physiology and body surfaces | The general physiology system is still deferred. There is no complete shared source yet for regional sweat, piloerection, vascular changes, body-surface residue, or persistent pressure marks. |
| Perception | Successor observations provide a stronger witness/channel model. Legacy chat has coverage and a turn-level sensory allowance, but no full per-sense exposure or proximity model. |
| Retakes | Both lanes support retakes, but through different state/cut mechanisms. The new read must be captured through each lane's real rollback boundary. |
| Recognition memory | General memory exists, but precise observer-specific visual notice and mention history do not yet. |

A missing owner is real work or a reason to defer that phenomenon. It is never
permission to infer state from genre, narrator prose, or what would make the
scene prettier.

The [readiness audit](body-attribute-affordances.audit.md) records the current
lane capability matrix. The
[architecture spec](body-attribute-affordances.spec.architecture.md) owns the
implementation boundaries.

## What this layer owns

The visual-affordance layer brings together facts owned elsewhere:

- stable appearance comes from canonical attributes and realized anatomy;
- current wetness, vascular signs, swelling, temperature, and lasting marks
  come from physiology or body state;
- garments, fit, material, support, coverage, and displacement come from the
  clothing system;
- posture, contact, clearance, and movement come from pose, space, and action
  state;
- rain, wind, motion, and impacts come from environment and committed events.

This layer reads those facts and works out the current visible consequence. It
does not rewrite them, remember hidden aftermath, choose behavior, or decide
that a possible action occurred.

Perception then decides what a particular observer can notice. Ranking decides
whether the result is useful enough to offer the narrator. Recognition memory
may remember what that observer noticed, but it never becomes body truth.

## The three kinds of answer

### A current visual observation

Something is actually present now, such as damp hair clumping, moisture beading
on exposed skin, a wet hem hanging heavily, or a tail pinned by the current
chair and posture.

### A useful constraint

A current fact prevents a contradiction: hair is bound, a wing is blocked, a
surface is covered, or support limits visible movement. Constraints normally
stay behind the scenes unless explaining them matters to the action.

### A future capability answer

Questions such as whether a wing can shelter someone or whether a character can
reach a shelf may reuse some body information later. They are not ambient
visual observations and cannot enter narration as though the action happened.

## Important boundaries

- This is not a full physics, cloth, collision, strength, or fluid simulator.
- It does not decide what a character chooses, feels, or attempts.
- It does not create a second wardrobe, physiology, pose, contact, memory, or
  image system.
- It does not call a vision model while composing a turn.
- It does not run a background tick or keep private aftereffect timers.
- It recomputes the few relevant body areas from the committed story moment.
- Retakes reuse the captured physical/perception read rather than later live
  state.
- Persistent tangles, marks, displacement, dirt, and damage must be recorded by
  the system that owns them.
- Missing or malformed inputs produce conservative silence and diagnostics,
  not guessed detail.

## Recognizable features

Recognizability is a view of existing truth, not a
`recognizable_features[]` list on the character.

A crooked nose can remain a nose attribute. Shoulder freckles can be a located
appearance fact. A missing finger must come from evented anatomy state. A scar,
prosthetic cover, favorite ribbon, or newly visible mark stays with its natural
owner.

The recognition layer asks:

- Is the detail visible to this observer now?
- How unusual is it?
- How important is it to identity, history, or the relationship?
- Has this observer noticed it before?
- Has it changed, become newly relevant, or been mentioned too recently?

That allows a feature to strengthen recognition without being redescribed in
every reply.

## Current release contract

The first usable release requires:

1. the shared read, evidence, perception, ranking, and capture foundation;
2. hair as the first production proving domain, with every proposed hair
   observation either backed by an authoritative source or explicitly deferred;
3. one second domain proving the foundation is not secretly hair-specific;
4. a feature-flagged romantic-chat comparison showing that cues reduce
   contradictions without causing repetition;
5. observer-specific recognizable-feature notice and mention behavior.

Scene-image reuse requires a recorded decision after narration is stable. It
does not have to ship merely to close the first narrator release.

Appendage, soft-tissue, garment, skin, and relative-geometry specs are
design-ready companions, not silent promises that every domain ships in the
first release. Before this plan closes, each companion must be explicitly
recorded as implemented, moved to a named follow-up, or parked. The active
plan/spec family stays together; it may be archived to `finished/` only after
the plan ships.

## Delivery outline

### Slice 0 — confirm vocabulary and truth sources

- Clean up or quarantine ambiguous hair vocabulary.
- Add a structured way to say whether hair is loose, bound, pinned, or covered.
- Publish a lane-by-lane source map for wetness, coverage, contact, force,
  events, perception, and retakes.
- For every missing source, either include an owner in the slice plan or defer
  the affected observation. Narrator text is never promoted to authority.

### Slice 1 — shared visual-affordance foundation

- Add one lane-neutral way for domains to receive stable appearance, current
  state, evidence, and safe diagnostics.
- Add the registry, perception, ranking, and strict cue cap.
- Keep it disconnected from the narrator until fixture tests pass.

### Slice 2 — hair structure and current behavior

- Turn trustworthy hair attributes into a stable hair description for
  calculation.
- Combine that structure with current wetness, arrangement, and coverage.
- Prove expected relationships such as more binding never creating more free
  movement.

### Slice 3 — hair observations

- Add wet clumping, wind or body-motion response, skin adhesion, and droplet
  shedding.
- Require the actual contact, force, or recent impulse each observation needs.
- Keep any observation whose source is unavailable out of production.

### Slice 4 — production inputs and retakes

- Connect the pure calculations to each lane's authoritative sources.
- Capture selected physical and perception results through the lane's real
  rollback/cut boundary.
- Prove that hidden state cannot leak and that retakes reuse the same moment.

### Slice 5 — narrator trial

- Offer at most one or two perception-safe cues behind a feature flag.
- Compare contradiction rate, repetition, specificity, and prose naturalness
  with the current appearance path.
- Keep stable appearance and affordance cues from duplicating one another.

### Slice 6 — second-domain proof

**Ruled 2026-07-28: the second domain is garment wet-state/cling** (legacy
clothing truth shipped in slices 0–6 of the clothing plan; skin surface waits
for authoritative physiology inputs). It must reuse the same foundation
without adding hair knowledge to the shared core. Synthetic fixtures may
prove calculations, but do not count as production source parity. Outside the
committed first run (slices 0–5).

### Slice 7 — recognizable features and visual memory

- Derive stable identity candidates from existing body truth.
- Keep visibility, uniqueness, and importance separate.
- Track what the player viewpoint has noticed and what the narrator recently
  mentioned.
- Prove first notice, change detection, hidden-feature safety, long-absence
  recognition, and repetition control before adding acquired fine anatomy.

### Slice 8 — image-consumer decision

Evaluate whether the captured observations improve scene-image composition.
Record a ship, follow-up, or rejection decision; do not build a separate
image-only body model.

## How we will judge it

- A missing cause never produces an effect.
- Covered or unseen state never reaches the narrator.
- Possibility never becomes an event.
- Stronger binding, support, or coverage does not increase the motion it
  constrains.
- Static appearance is not repeated as a current effect.
- The narrator gets at most one or two useful cues and does not sound like a
  physics report.
- The same committed moment gives the same result on a retake.
- Legacy and successor adapters produce the same answer for the same normalized
  fixture, while honestly omitting phenomena their lane cannot support.
- Recognition memory is observer-specific and cannot rewrite anatomy.

## Dependencies and related plans

- [Clothing state graph](clothing-state-graph.plan.md) owns garment truth and
  must finish the relevant adapter/integration work before garment affordances
  claim lane parity.
- [Physiology](deferred/physiology.plan.md) owns live responses. Skin and
  intimate physiology observations wait for its authoritative outputs.
- [Romantic contact](romantic-contact-affordances.plan.md) reuses the shared
  evidence, perception, ranking, and capture foundation but owns contact
  commitment and contact-caused effects.

## Open questions

- Where do lane-specific adapters live, how is the mixed domain registry typed,
  and is a developer preview useful?
  ([architecture spec](body-attribute-affordances.spec.architecture.md#open-questions))
- Which authoritative source first supplies coarse pose and hair/body contact?
  (Current force and the retake capture seam were resolved in Slice 0 — see the
  [hair spec resolutions](body-attribute-affordances.spec.hair.md#resolved-slice-0-2026-07-28);
  contact/pose remains unowned and adhesion stays fixture-only.)
- Should hooded hair be able to show its loose ends stirring? Today a hood
  lets damp clumping through but the ends-only motion case cannot fire in
  play — an opaque-coverage calibration ruling is needed.
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions))
- Should a bath/pool soaking carry its own "still dripping" provenance in
  narration, now that it correctly no longer reads as rain?
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions))
- What is the shared physiology-sign shape, how are diverse skin responses
  calibrated, and who owns products and persistent marks?
  ([skin spec](body-attribute-affordances.spec.skin-surface.md#open-questions))
- What garment material vocabulary and contact read are required, which garment
  observations ship first, and what coverage result is captured?
  ([garment spec](body-attribute-affordances.spec.garment-interaction.md#open-questions))
- Which appendage materials and flexibility facts are trustworthy, who owns
  clearance/concealment, and which fixture comes first?
  ([appendage spec](body-attribute-affordances.spec.appendages.md#open-questions))
- Which soft-tissue vocabulary and first regions are safe to calculate, who
  supplies support, and what narrative-focus rule prevents voyeuristic
  repetition?
  ([soft-tissue spec](body-attribute-affordances.spec.soft-tissue.md#open-questions))
- How should height bands, posture, surfaces, and footwear produce relative
  geometry, and when should images consume it?
  ([relative-geometry spec](body-attribute-affordances.spec.relative-geometry.md#open-questions))
- Where do located features and anatomy changes live, how are uniqueness and
  importance set, and how do intimate gates, motion identity, notice decay,
  mention history, and semantic memory interact?
  ([feature spec](body-attribute-affordances.spec.recognizable-features.md#open-questions);
  [memory detail](body-attribute-affordances.recognizable-features.memory.md#open-questions))
- What confidence is required before a reference-image proposal becomes a
  canonical value that may drive calculation?

## Technical companions

- [Current readiness audit](body-attribute-affordances.audit.md)
- [Shared architecture](body-attribute-affordances.spec.architecture.md)
- [Code organization](body-attribute-affordances.spec.code-organization.md)
- [Hair](body-attribute-affordances.spec.hair.md)
- [Skin surface](body-attribute-affordances.spec.skin-surface.md)
- [Garment interaction](body-attribute-affordances.spec.garment-interaction.md)
- [Appendages](body-attribute-affordances.spec.appendages.md)
- [Soft tissue](body-attribute-affordances.spec.soft-tissue.md)
- [Relative geometry](body-attribute-affordances.spec.relative-geometry.md)
- [Recognizable features](body-attribute-affordances.spec.recognizable-features.md)
- [Visual-memory detail](body-attribute-affordances.recognizable-features.memory.md)
- [Feature catalog](body-attribute-affordances.recognizable-features.catalog.md)
