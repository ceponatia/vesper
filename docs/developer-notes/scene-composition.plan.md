# Scene image composition — camera, facing, and intimate staging

Status: awaiting acceptance — all three slices built 2026-08-14; waiting on
the paid per-slice A/B probes and the owner's acceptance-scene grading
(owner-gated spend)

Outcome: A player can get a scene image composed from where they actually stand
in the fiction — a character with her back to them is painted from behind, and
an intimate moment is staged the way the story just described it — so that the
picture stops contradicting the scene it illustrates.

Technical companion: [scene-composition.spec.md](scene-composition.spec.md)

Related work, and the boundary with each:

- [image render quality](image-render-quality.plan.md) owns **how each model is
  told** things — per-model prompt dialects, negative steering, identity-lock
  wording per model. This plan owns **what the shot contains**: where the
  camera stands, which way the subject faces, what act is being staged. The two
  meet at the identity-lock wording, which this plan adapts when a face is
  partly hidden and that plan translates per model.
- [visual state and attention](visual-state.plan.md) owns the lane-neutral
  projection of what a character looks like right now, including body language
  read from committed scene facts. This plan does not build a second
  projection: its committed-state slice reads those facts directly as an
  interim, and migrates onto the visual-state image digest when that ships.
- [romantic contact affordances](romantic-contact-affordances.plan.md) owns the
  committed scene facts themselves — posture, who faces whom, distance, active
  contact. This plan only reads them, and writes nothing back.
- [spatially controlled scene images](spatial-scene-images.plan.md) owns the
  long-horizon structural route: real pose and depth control derived from a 3D
  frame. This plan is the prompt-level treatment of the same complaint,
  reachable now without new providers or paid gates; whatever it proves about
  camera vocabulary and staging carries forward into that plan's contracts.

## Why

Every chat scene image today comes back with the character front and center,
squarely facing the camera — whatever the story says. If the player has walked
up behind her and wrapped their arms around her waist, the image still shows
her from the front. If she is at the stove with her back to the room, the image
turns her around. During intimate play the mismatch is at its worst: the text
describes a specific act with a specific geometry, and the picture shows a
nude portrait — right person, right room, wrong moment, and almost always the
wrong orientation (owner report, 2026-08-10).

Four things cause this, and none of them is the image model misbehaving:

- **Nothing ever states a camera.** The prompt says the image is seen through
  the player's eyes, but never where those eyes are relative to the subject —
  in front, behind, above, close, across the room. Image models fill the gap
  with their strongest prior: a front-facing subject looking at the lens.
- **The pipeline actively rotates her toward the camera.** Player-directed
  beats are deliberately translated into "toward the viewer" — correct when
  the player stands in front of her, and exactly backwards when the player is
  behind her (her gaze should become a glance back over her shoulder, not a
  turn to face front).
- **The identity reference pulls the same direction.** Scenes are edits of a
  front-facing portrait under an instruction to preserve the face — and the
  cheapest way for a model to prove it preserved the face is to show it.
- **The composing model is deliberately cautious.** The small model that plans
  each shot runs in a safe configuration; during explicit moments it writes
  vague poses ("close to the viewer, intimate"). The character's explicit
  anatomy is already injected separately, in code — but the _act_ never is, so
  the render gets anatomy with no staging.

## What the owner gets

- **The shot follows the fiction.** A short fixed menu of shot facts — which
  way the subject faces relative to the viewer (toward, three-quarter,
  profile, away with a glance back, fully away), how close the camera is, and
  whether it looks down or up — proposed from the recent story and stated
  explicitly in the render prompt. Anything other than the front-facing
  default must quote the narration that grounds it, the same
  propose-then-verify pattern that keeps the viewer's own hands honest today,
  so the camera never wanders on a whim.
- **The player's own words count.** The shot planner currently reads only the
  narrator's replies. "I come up behind her" is usually stated by the player,
  so the player's recent messages join its reading material.
- **Intimate moments are staged, not implied.** A fixed catalog of stageable
  intimate configurations — held from behind, kneeling before the viewer,
  astride facing toward or away, bent over a surface, and so on — each
  carrying its camera setup and an explicit phrasing written once, in code,
  and emitted only on the route that already carries explicit anatomy. The
  composing model only picks the entry and quotes its evidence; it never
  writes the explicit text itself, so a cautious model cannot water the shot
  down and a bold one cannot invent what the story didn't say.
- **Committed facts beat guesswork.** When the chat's committed movement state
  already knows she is facing away or kneeling (it tracks posture, facing,
  distance, and touch — fed by typed movements, dark today), those facts are
  handed to the shot planner as authoritative and its proposal is clamped to
  match. This is the seam the engine's own facing data plugs into later:
  structured state wins wherever it exists, and the transcript covers
  everything else.
- **Evidence before enable.** Each behavior change ships behind its own small
  paid A/B probe on the existing scene-image eval harness, owner-reviewed the
  same way the phantom-limb fix was — including the known tension that a
  from-behind shot cannot show the face that proves identity.

## Boundaries

### In scope

- The chat-lane scene image path (composer, plan resolution, render prompt) —
  the established iteration ground for image-prompt work.
- The shot-fact and staging vocabularies, their evidence gates, and the prompt
  text they emit on each render route.
- Reading the chat's committed scene facts for the focal character and the
  player, and the equivalent engine read for successor chats when the engine
  exposes one.
- Eval fixtures and A/B probes for orientation and staging.

### Non-goals

- **No pose maps, depth maps, control inputs, or new providers.**
  [spatial-scene-images.plan.md](spatial-scene-images.plan.md) and
  [qwen-advanced-image-subsystem.plan.md](qwen-advanced-image-subsystem.plan.md)
  own structural control; this plan changes only text.
- **No per-model prompt dialects or negative steering** —
  [image-render-quality.plan.md](image-render-quality.plan.md) owns those.
- **No new state, no writes.** The shot planner's spatial guesses live and die
  inside one render job; they never become scene facts, and narration never
  becomes physical authority. The committed-state slice is read-only.
- **No selfie changes.** Selfies keep their own framing rule (the subject's
  camera, aware of the lens).
- **No new player-facing toggles.** Staging reuses the gates that already
  govern explicit content — the uncensored render route, the exposure state,
  and the narration itself. A staging the fiction didn't describe never fires.
- **Not the visual-state projection.** Body-language projection stays with
  [visual-state.plan.md](visual-state.plan.md); this plan keeps its committed
  state read small so it can migrate onto that digest.

## Slices

- **Slice 1 — the camera follows the fiction.**

  Status: built 2026-08-14 — awaiting its A/B probe on the fixture rows.

  The shot planner proposes orientation, distance, and camera height from a
  fixed menu, quoting narration for anything non-default; the player's recent
  messages join its context; the render prompt states the shot explicitly and
  adapts the identity wording when the face is only partly visible. Behavior
  is compared against today's output on fixed fixtures before acceptance.

- **Slice 2 — intimate acts are staged.**

  Status: built 2026-08-14 — awaiting its probe, including the owner's
  three-scene acceptance grading.

  The staging catalog with per-entry camera setup, implied viewer-body parts,
  and explicit phrasing emitted only on the uncensored route; evidence,
  exposure, and route gates in code. A staged configuration is eligible only
  when exactly one character is present, unless a catalog entry explicitly
  supports more (owner ruling 2026-08-14) — ordinary, unstaged scene images
  keep drawing the whole present cast as they always have. The shot planner
  also moved onto a less cautious model here (owner ruling 2026-08-10), with
  the chat's own narrative model as the refusal fallback — the catalog still
  owns every explicit word either way.

- **Slice 3 — committed facts override inference.**

  Status: built 2026-08-14 — awaiting the same probe rows.

  Chat scene facts (posture, facing, distance, active contact) reach the
  planner as authoritative context and clamp its camera proposal; absent facts
  change nothing. Successor chats read the engine equivalent when one exists;
  the read migrates onto the visual-state image digest when that ships.

## Where the work stands

- **[scene-composition.spec.md](scene-composition.spec.md)** — complete: all
  three slices built 2026-08-14, with the per-slice status, the build's
  rulings, and the probe harness recorded there. Nothing is accepted yet —
  acceptance is the probes.

## Success criteria

- On the fixture set's orientation rows (behind, glance-back, profile, lying
  face-down), a blinded owner review prefers the new composition and finds no
  identity regression on the front-facing rows.
- During intimate play on the uncensored route, the rendered act matches the
  described act; moderated routes carry no staging text and keep rendering
  clean.
- A committed facing or posture fact is never contradicted by the planner's
  guess in the final prompt.
- A scene with no grounding evidence renders exactly as it does today — the
  front-facing default is the fallback, not a casualty.
- No slice's behavior turns on without its owner-reviewed probe; probes are
  the only new spend.
- **Three staged acts are graded pass/fail on visible elements** in slice 2's
  probe, on the uncensored route (owner-specified acceptance scenes,
  2026-08-10). Each element below must be checkable in the rendered image:
  - **Doggy style** — she is on all fours facing away from the camera, and
    the viewer's own hands rest on her waist or hips.
  - **Oral** — either her face is visible looking up as she goes down on the
    viewer, or the shot looks down on the top of her head with the viewer's
    hand resting on it. Either composition passes.
  - **Missionary** — she lies on her back beneath the camera looking up at
    the viewer, the viewer's genitals enter frame at the bottom edge with
    penetration shown, and the viewer's hands hold her legs or her waist.
    Either hand position passes.
  - In all three, the viewer's hands and anatomy appear only where the
    existing coverage and route gates allow, and nobody but her and the
    viewer's own body parts is in frame.

## Open questions

- **Should the subject's intimate-anatomy phrasing be suppressed on a
  from-behind shot?** Today it still emits there, and a prompt that describes
  her front over a shot of her back may make the model turn her around. The
  probe's behind-nude row measures it; detail in
  [the spec](scene-composition.spec.md) §Known tensions.

The launch rulings — a character described as behind-facing renders fully away
unless the story actually describes the glance back; the shot planner moves to
a less cautious model with the narrative model as refusal fallback;
orientation is focal-only while one-on-one chats are the test bed — are
recorded as owner rulings (2026-08-10) in
[the spec](scene-composition.spec.md), alongside the 2026-08-14 rulings the
build settled (solo-cast staging eligibility; no larger spatial abstraction;
the composer-model flip ahead of its probe).

## Technical companion

[scene-composition.spec.md](scene-composition.spec.md) — vocabularies, schema
changes, gates, prompt assembly, committed-state mapping, diagnostics,
fixtures.
