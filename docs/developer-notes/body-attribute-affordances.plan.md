# Body-attribute visual affordances

Status: active — **slices 0–4, the slice 5 wiring, and slice 6 shipped
2026-07-28; slice 7 shipped 2026-07-29** (hair vocabulary split, shared core,
hair domain, chat-lane wetness/environment owners + adapter + retake capture,
the `CHAT_AFFORDANCE_CUES` narrator cue path (default OFF), the garment second
domain with chat wiring + captured effective coverage, the read-only developer
preview, and the recognizable-feature projection + observer visual memory
behind `CHAT_RECOGNITION_CUES`, also default OFF). **Slice 5 is closed —
final verdict 2026-07-29**: after the first live comparison failed for lack
of contradiction headroom, a three-round rematch campaign under a frozen
protocol ([rematch spec](body-attribute-affordances.trial.rematch.md), $6.29)
made the measurement valid and the cue arm failed the decision rule twice
consecutively — cues never reduced contradictions, because concrete cues
make more checkable claims. **`CHAT_AFFORDANCE_CUES` parks OFF, finally**;
what survives is the measured cue-wording fix (cause-true provenance,
degree-accurate adjectives), the reusable audit harness, and the findings
(cues eliminated repetition and false-premise adoption, raised specificity
every round) — full history in the
[trial report](body-attribute-affordances.trial.md) §Rematch log. **Slice 7 is
built but production-inert** for a comparable missing-owner reason: the chat
lane only knows that a location is exposed when a garment covers it, so bare
skin reads unknown and recognition correctly stays silent until a
body-exposure owner exists. Also remaining before the release contract closes:
slice 8 (image decision), the successor-lane adapter follow-up, and
per-companion rulings. The shared foundation the
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
| Recognition memory | Shipped for legacy chat (slice 7): observer-specific notice and mention history, scoped to the memory group and retake-safe. It stays silent in production until something asserts exposure for uncovered skin. |

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

**Complete 2026-07-29.** The deterministic half ran clean 2026-07-28 (every
structural guarantee holds); the live paired comparison ran 2026-07-29 on the
replaced key and **did not meet the decision rule** — contradictions tied
exactly (the narrator already avoids them in this matrix), repetition rose
slightly, specificity genuinely improved at identical naturalness, and the
blinded judge leant to the control. The mechanism works as designed; the
measured problem it prevents was not occurring. `CHAT_AFFORDANCE_CUES` stays
OFF; any rematch should redesign the scenario matrix to induce contradiction
headroom rather than change the physics — numbers, judge caveats, and rematch
conditions in the [trial report](body-attribute-affordances.trial.md)
§Live results.

### Slice 6 — second-domain proof

**Ruled 2026-07-28: the second domain is garment wet-state/cling** (legacy
clothing truth shipped in slices 0–6 of the clothing plan; skin surface waits
for authoritative physiology inputs). It must reuse the same foundation
without adding hair knowledge to the shared core. Synthetic fixtures may
prove calculations, but do not count as production source parity. Outside the
committed first run (slices 0–5).

Scope ruling (2026-07-28): adopt the clothing system's existing material
vocabulary; ship material-dependent wet surface behavior, wet cling where
contact is actual, and effective opacity + final coverage captured with the
presentation cut; defer wind response and pose-dependent drape until the
shared scene/body-relations owner exists. After this proof lands, build the
read-only developer preview
([architecture spec](body-attribute-affordances.spec.architecture.md)).

**Shipped 2026-07-28**, including the developer preview (bottom of the chat
inspector). Honest silences that remain by design: wet cling is
production-silent because no wardrobe field records whether a garment is
loose or fitted (recording fit is the single change that lights it up —
flagged back at the [clothing plan](clothing-state-graph.plan.md) slice 8),
and see-through observations stay silent for tops because the chest is an
intimate region and the chat lane has no consent/narrative-focus owner yet.
Wet cotton and wet leather now genuinely behave differently, layered
garments combine into one captured "what is actually visible" answer per
turn, and retakes rebuild the identical read. Details in the
[garment spec](body-attribute-affordances.spec.garment-interaction.md)
§"Resolved (Slice 6 implementation)".

### Slice 7 — recognizable features and visual memory

- Derive stable identity candidates from existing body truth.
- Keep visibility, uniqueness, and importance separate.
- Track what the player viewpoint has noticed and what the narrator recently
  mentioned.
- Prove first notice, change detection, hidden-feature safety, long-absence
  recognition, and repetition control before adding acquired fine anatomy.

**Shipped 2026-07-29.** Recognizability stayed a view of existing truth, as
ruled. One new area records how identity details are *owned* — a fine body
locus with a finite left/right hand schema, a registry of feature kinds
(freckle cluster, birthmark, mole, scar), located appearance facts with
validity windows and supersedence, evented anatomy state, and a short list of
which canonical attributes are recognition-worthy at all. A second new area
owns the observer-relative half: what this observer can currently make out,
what they have noticed before, and whether saying it earns the beat. The chat
lane wires both behind `CHAT_RECOGNITION_CUES` (default OFF), appending at
most one extra line to the existing cue block. Observer memory follows the
**chat memory group**, so "continue our history" retains recognition while a
fresh conversation starts as strangers, and each row keeps the generation
before the current exchange so a retake re-runs from the identical memory
rather than counting the same look twice. Looking is recorded even when
nothing is said; only a cue that actually reached the transcript starts a
cooldown. Twenty-three acceptance scenarios prove both specs' lists end to end.

Honest silences that remain by design:

- **Nothing can fire in production yet.** The chat lane asserts exposure only
  for garment-covered locations and hair, so a nose, a face, or a forearm
  reads *unknown* — and recognition fails closed on unknown. A body-exposure
  owner (or an adapter overlay declaring uncovered, coverage-relevant
  locations visible) is the single change that lights the trial up. This is
  the same shape of gap as slice 6's missing garment fit, and is deliberately
  not papered over.
- Even with exposure solved, **no shipped attribute clears the notice bar** at
  ordinary conversational distance: a crooked nose scores just under it, and
  teeth need deliberate inspection, which this lane cannot detect. Scars,
  birthmarks and missing digits clear it comfortably — but nothing authors
  located facts or anatomy state in chat yet, so the pipeline passes none.
- **A change does not outrank a recent mention.** If a known feature changes
  within about a story day of the narrator last mentioning it, the change is
  adopted into memory silently instead of being narrated. Defensible, but a
  calibration ruling if the owner wants change privileged.
- The developer preview does not yet show the recognition line (minor
  follow-up).

Detail lives in the
[feature spec](body-attribute-affordances.spec.recognizable-features.md#resolved-slice-7-implementation-2026-07-29)
and the
[visual-memory detail](body-attribute-affordances.recognizable-features.memory.md#shipped-slice-7-implementation-2026-07-29).
Successor-lane projection, conditions and presentation as feature owners,
cast-relative uniqueness, semantic-memory document emission, and recognizable
motion all stay deferred per the 2026-07-28 rulings.

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

- **Scene/body-relations owner (ruled 2026-07-28, not yet planned)** — the
  shared owner for pose, support, surface level, actual contacts, and
  impulses that most remaining domains wait on. Character chat ships it
  first; its contact lifecycle reuses the romantic-contact plan's contact
  core. It gets its own plan (or lands inside the romantic-contact build)
  when scheduled — see the
  [architecture spec](body-attribute-affordances.spec.architecture.md)
  §"Scene/body-relations owner".
- [Clothing state graph](clothing-state-graph.plan.md) owns garment truth and
  must finish the relevant adapter/integration work before garment affordances
  claim lane parity.
- [Physiology](deferred/physiology.plan.md) owns live responses. Skin and
  intimate physiology observations wait for its authoritative outputs.
- [Romantic contact](romantic-contact-affordances.plan.md) reuses the shared
  evidence, perception, ranking, and capture foundation but owns contact
  commitment and contact-caused effects.

## Rulings snapshot (owner, 2026-07-28)

The 2026-07-28 review settled most of what was open. Each detail doc's
"Resolved" section carries the full ruling; in short, the owner approved:

- the shipped adapter and registry architecture, with a read-only developer
  preview to follow once the garment domain proves the foundation twice
  ([architecture spec](body-attribute-affordances.spec.architecture.md));
- **one shared scene/body-relations owner** — coarse posture, support,
  surface level, actual contacts, and impulses — built first in character
  chat, restoring with the scenario on retakes. This single owner unblocks
  hair adhesion, garment cling and drape, appendage constraints,
  soft-tissue effects, relative geometry, and the romantic-contact plan.
  Unknown contact still means silence, and a continuity extractor may
  record established passive facts but never authorize new interpersonal
  contact;
- reusing the clothing system's existing material vocabulary, with the
  first garment release scoped to wet surface behavior, wet cling where
  contact is actual, and effective opacity + final coverage captured with
  the presentation cut (wind and pose-dependent drape wait for the shared
  owner) ([garment spec](body-attribute-affordances.spec.garment-interaction.md));
- the physiology-sign shape (what the body does, never why the character
  feels), three-mode skin response calibrated by tone/undertone (never
  race-as-input, never "low redness visibility = no response"), split
  product ownership, and body-surface mark state
  ([skin spec](body-attribute-affordances.spec.skin-surface.md));
- generic soft-tissue regions (breasts first, buttocks second), wardrobe-
  owned support (unknown = unavailable), the four-way vocabulary split, and
  a strict intimate narrative-focus rule — at most one intimate cue per
  exchange, requiring a current action/transition, with exposure and
  consent as hard gates
  ([soft-tissue spec](body-attribute-affordances.spec.soft-tissue.md));
- tail constraints as the first appendage fixture (after the shared owner),
  wing wet-loading second, with new tail flexibility/prehensility/surface
  axes before those properties drive mechanics
  ([appendage spec](body-attribute-affordances.spec.appendages.md));
- simple height anchors + footwear/posture/surface arithmetic for relative
  geometry, deferring leg/neck length, with images receiving only semantic
  relations after narration proves them
  ([relative-geometry spec](body-attribute-affordances.spec.relative-geometry.md));
- typed located facts plus evented anatomy for recognizable features (a
  finite hand schema first), definition-based uniqueness in v1,
  projection-time observer weighting, freshness-bucket decay with a
  recognition floor, and cut-captured mention history
  ([feature spec](body-attribute-affordances.spec.recognizable-features.md);
  [memory detail](body-attribute-affordances.recognizable-features.memory.md));
- human acceptance as the only gate that makes a reference-image proposal
  canonical ([architecture spec](body-attribute-affordances.spec.architecture.md)).

Two further rulings landed later the same day, after the slice 5 trial's
deterministic run:

- **current-effect cues override the "no appearance description" turn rule**
  ("cues win") — that rule exists to stop re-describing unchanged looks, and
  a live physical change (damp strands clinging after rain) is new
  information, not static appearance. The prompt now carves the cue block
  out of the restriction instead of contradicting it; nothing changes when
  the flag is off or no cue fired
  ([trial report](body-attribute-affordances.trial.md) §Owner rulings);
- **the slice 5 live comparison is deferred, not skipped** — the stored
  model key turned out to be dead ($0 spent), so the flag stays OFF and the
  live half waits for a working key; the deterministic half's structural
  guarantees all passed.

**Calibration stance**: numeric coefficients for skin response, soft-tissue
motion, appendage flexibility, and visual-memory thresholds are
fixture-tested calibration defaults, never permanent product law.

## Open questions

- Should hooded hair be able to show its loose ends stirring? Today a hood
  lets damp clumping through but the ends-only motion case cannot fire in
  play — an opaque-coverage calibration ruling is needed.
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions))
- Should a bath/pool soaking carry its own "still dripping" provenance in
  narration, now that it correctly no longer reads as rain?
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions))
- Does wet darkening need per-color lightness metadata, or only a relative
  semantic tag?
  ([hair spec](body-attribute-affordances.spec.hair.md#open-questions))
- Who owns exposure for **uncovered** skin? Recognition is production-inert
  until something says a nose or a forearm is visible; the options are a real
  body-exposure owner or a chat-adapter overlay that declares
  coverage-relevant uncovered locations visible.
  ([feature spec](body-attribute-affordances.spec.recognizable-features.md#resolved-slice-7-implementation-2026-07-29))
- Should the shipped attribute priors be recalibrated so an ordinary
  distinctive face can be noticed across a table? Today a crooked nose lands
  just under the notice bar and teeth sit at an inspection-only detail tier,
  so no attribute-sourced feature can fire even with exposure solved.
  ([feature spec](body-attribute-affordances.spec.recognizable-features.md#resolved-slice-7-implementation-2026-07-29))
- Should a **changed** feature outrank the mention cooldown? A change within
  roughly a story day of the same feature's last mention is remembered but
  never narrated.
  ([visual-memory detail](body-attribute-affordances.recognizable-features.memory.md#shipped-slice-7-implementation-2026-07-29))
- Is the **emotional-callback** cue worth keeping at its shipped weights? With
  the current priors it can never win — importance ties its threshold and
  novelty always outranks it — so the reason exists but is unreachable.
  ([visual-memory detail](body-attribute-affordances.recognizable-features.memory.md#shipped-slice-7-implementation-2026-07-29))
- ~~Does the affordance cue path earn a rematch with a redesigned matrix?~~ —
  **resolved 2026-07-29**: it got one, run to the frozen protocol's terminal
  state the same day. Final verdict: two consecutive valid fails,
  `CHAT_AFFORDANCE_CUES` parks OFF; a differently-shaped narrator aid
  (constraint-only or change-gated cues) would be a new plan.
  ([trial report](body-attribute-affordances.trial.md#rematch-log))

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
