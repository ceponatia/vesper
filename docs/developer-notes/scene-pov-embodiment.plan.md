# Scene POV embodiment — the player's own body in frame (plan)

Status: **active** — written 2026-07-16 from an owner brainstorm ask. **Slice 0 (the
blush scrub) shipped 2026-07-16**; slices 1–4 remain and are all **unblocked**:
[persona-library.plan.md](persona-library.plan.md) shipped the same day, so the
persona's body attributes (`personaToCharacterProfile` → `characterAppearanceSummary`)
and the player's worn coverage (`resolvePlayerWardrobe` →
`exposedRegions(playerWorn)` — structured-only, no manual `exposed` flag to fake) are
both available now. `character_chats.player_state` is where the wardrobe lives.

Topic slug `scene-pov-embodiment`. Scope: **the character-chat scene path only**
(`server/images/character-scene.ts`) — see [Lane scope](#lane-scope).

## What we're building

Today every scene image is composed from the player's eyes and the player is
**absolutely absent**. That is a useful lie: the fiction constantly puts the
player's hands on someone, and the image can't show it. We want POV shots that
include the viewer's own arms, legs, torso, and — when the fiction and the
wardrobe both agree — genitals, driven by chat state.

Two failure modes bound the work:

1. **Third-person men.** Naming male anatomy in a prompt without binding it to the
   camera makes the model paint a whole second person into the room.
2. **Clown makeup.** Owner report: "blush"/"flushed" in a prompt renders as
   stage blusher, not physiology. Independent of POV, fixed here because it is
   the same prompt surface.

## Why the current rule is not just a string

Absence is enforced in **three** places, and softening one without the others
regresses straight to men in the room:

- `SCENE_POV_RULE` (`images/prompts.ts:998`) — the render-prompt rule, restated
  verbatim on every route.
- `SCENE_COMPOSER_SYSTEM` (`prompts.ts:521`, `:526`) — tells the composer the
  player must never appear, *and* to translate player-directed beats into solo
  equivalents ("hand resting on his arm" → dropped).
- `scrubPlayerFromAction` (`prompts.ts:875`) — the deterministic backstop that
  deletes any clause still naming the player.

The comment above `SCENE_POV_RULE` records the scar tissue: phrasing the player
**as the camera** made models paint hands gripping a camera into the foreground,
and a literal "no camera" negative would only anchor the model on cameras.

## The core insight

**What prevents a third-person man is not a negative — it is a person-count
assertion plus frame geometry.** "No man in frame" will anchor on *man* exactly
the way "no camera" anchored on cameras. What works instead:

- **Possessive binding** — "the viewer's own forearm", never "a man's forearm".
  No subject noun for the player, ever.
- **Frame geometry** — "entering frame from the bottom edge, strongly
  foreshortened, cropped by the frame". A limb cropped by the frame edge
  *cannot* be composed as a standing subject; the geometry does the work the
  negative can't.
- **A positive count** — "Exactly one person is fully in frame: Mira." This is
  the realistic-model analogue of the booru `solo focus` tag. Count is derived
  from the featured list, not hardcoded.
- **Head explicitly out of frame** — what makes it POV rather than a man.

The reference-edit route helps: the base image is her portrait, so the
composition is already anchored on her and a foreground forearm is a small edit,
not a recomposition.

## Coverage gates anatomy — deterministically, not by asking an LLM

The ask was for "the composer to block fields from the image model's context —
not showing genitalia when the player is wearing pants or underwear." Agreed on
the *where* (the compose stage is the gate), with one important placement change:

**The coverage gate must be code, not the composer.** The composer runs on the
moderation-prone tool model with `allowIntimate: false` — which is exactly why
the existing architecture injects the *character's* intimate anatomy at render
assembly and never through the composer. The same split applies to the player:

- `exposedRegions(playerWorn)` → `pelvis === "covered"` is a **boolean**. Wearing
  pants makes the genitals part structurally unavailable — it never enters the
  plan, so there is no prompt text and nothing for the composer to leak. It
  cannot drift, and it cannot be talked out of.
- The **composer proposes** which non-intimate parts are in frame (hands,
  forearms, lap, legs) — a judgment call from the narration, which is its job.
- **Final parts = composer's pick ∩ coverage-allowed ∩ route-allows-intimate.**

The composer proposes; coverage disposes. This is the same shape as
`intimateAttrRendersExposed` / `sceneRevealAppearance` on the character side, and
it is why [persona-library.plan.md](persona-library.plan.md) rules the player's
wardrobe **structured-only with no manual `exposed` toggle** — a togglable flag
would be a hole straight through this gate.

## Lane scope

**Character chat only.** `images/character-scene.ts` is already the designated
iteration ground for image-prompt tuning — the `imageReveal` tag shipped there
first with exactly this note in `docs/images.md`: "Today this is wired on the
character-chat scene path only … avatars and in-session scenes keep strict
exposure gating until the tag is adopted there."

The session lane keeps its absolute rule **and its tests** —
`pipeline.test.ts:154` ("player wardrobe never enters image prompts") and
`scene.test.ts:272` ("player wardrobe not rendered") stay green and unmodified.
The session player is a different model (a real library character via
`worlds.playerCharacterId`); unifying is not this plan's business.

## Slices

### Slice 0 — the blush scrub — **shipped 2026-07-16**

Two leak paths, and the reword alone won't hold without both.

**Deterministic.** `visualStateNote` (`images/character-scene.ts:106`) writes the
word into the prompt directly — 3 of its 5 phrases:

- `:109` intoxication > 0.7 → "**flushed** and visibly unsteady from drink"
- `:110` intoxication > 0.35 → "lightly **flushed** and loose from a drink or two"
- `:118` arousal > 0.55 → "**flushed**, eyes bright and breath shallow"

Any skin-*color* word is the trap — models paint pigment as cosmetics. Reword to
signals rendered as physiology: glassy or unfocused eyes, heavy-lidded gaze, damp
hairline, sheen of sweat, parted lips, loosened posture. ~3 lines.

**LLM echo.** The arousal meter's narrator hint (`contracts/meters/registry.ts:77`)
literally says "flushed skin" → the narrator writes it → the composer reads that
narration → its `pose`/`mood` hand it back. Fix with a composer rule banning
skin-color words **plus** a deterministic `scrubBlush(text)` over pose/mood/
appearance at assembly — same belt-and-braces shape as `scrubPlayerFromAction`,
because the rule alone is not trustworthy.

**Leave alone:** the narrator hint itself (good prose guidance; narration isn't
rendered), the `flushed` pipLabel, and the `fluster` condition
(`chat-state.ts:2264` — `attributeEffects: []`, so it never reaches an image).

**Shipped as described.** Two notes from the build: `skin.undertone` has a `rosy`
allowed value, but it is an **authored identity attribute** and is deliberately NOT
scrubbed — the scrub's boundary is composer-authored free text (`action`, `mood`),
exactly like `scrubPlayerFromAction`. And the two `visualStateNote` tests that
asserted the literal word "flushed" now assert the **inverse invariant** across the
whole meter grid, which is the property worth pinning. Still unverified against a
live model — see [Testing](#testing).

### Slice 1 — `SCENE_POV_RULE` becomes a builder (independent)

Replace the constant with `sceneFramingRule(parts)`:

- `parts` empty → **today's exact string, byte-identical**. Default path, zero
  regression, snapshots unchanged.
- non-empty → the embodied variant (possessive binding + geometry + count line +
  head-out-of-frame).

Lands with the part list always empty, proving the seam without changing a single
rendered image. Belongs in the **never-dropped** tier of `budgetVenicePrompt`
(`prompts.ts:1140`) alongside the POV rule and pose — the Venice edit routes cap
at 1500 chars (`prompts.ts:1045`) and this must not be what gets excerpted.

### Slice 2 — the viewer-part registry + the coverage gate

`contracts/images/viewer-body.ts` — a closed vocabulary, not free text.
Registries are the extension point, so phrasing is a data edit:

```ts
{ id: "forearms",
  framing: "entering frame from the lower edge, foreshortened",
  intimate: false,
  /** The RegionExposure key that must read bare/sheer for this part. null ⇒ ungated. */
  requiresBare: null }
{ id: "genitals",
  framing: "in the near foreground, cropped by the lower frame edge",
  intimate: true,
  requiresBare: "pelvis" }
```

Parts: `hands`, `forearms`, `lap_thighs`, `legs_feet`, `torso`, `genitals`.
The gate intersects a proposed list against `exposedRegions(playerWorn)` and the
route's `allowIntimate`. Pure, unit-testable without a model: *pants on ⇒
genitals gone* is a table test.

### Slice 3 — the composer proposes

Add `viewerBody: string[]` to `SceneSpec`, clamped against the registry in
`resolveScenePlan` (`prompts.ts:913`) with a diagnostic — the same clamp pattern
as `focal_clamped` / `absent_character_dropped`. Invert the two composer rules
(`prompts.ts:521`, `:526`): contact beats stop being dropped and instead become
viewer parts **plus** the character's half of the contact. Make
`scrubPlayerFromAction` part-aware — with parts in frame, rewrite "the player's
arm" → "the viewer's arm" rather than deleting the clause; keep the drop when the
list is empty.

### Slice 4 — persona body facts reach the prompt

The viewer's arms need a skin tone or they change color every scene. Source them
from the persona's attributes through `personaToCharacterProfile` +
`characterAppearanceSummary` — restricted to a **viewer-visible subset** (an
`imageReveal`-style tag is the natural home if the list grows). Intimate anatomy
rides `sceneRevealAppearance(..., {intimate: true})` on the uncensored route
only, exactly as the character's does.

## Testing

Prompt-level unit tests carry most of this — the gate, the clamp, the scrubs, and
the byte-identical empty-parts path are all pure. What they *can't* tell you is
whether the model paints a man anyway.

`docs/scene-image-eval/` already has the harness shape
(`scripts/eval/scene-images/`, a fixture set rendered against live Venice models
into a reviewable index). Extend it with embodied fixtures across the routes and
review by eye. The metric that matters: **third-person contamination rate** —
what fraction of embodied renders put a whole second person in frame. Establish
it before slice 3 ships, since that's the slice that can regress it.

## Open questions

- **Does Venice's *edit* endpoint accept `negative_prompt`?** None of the three
  calls send one today (`server/ai/venice.ts:90`, `:149`, `:204`). A real
  negative-prompt **parameter** is a different animal from an in-prompt negative —
  it doesn't anchor — and it is the natural home for both "blush, rosy cheeks,
  makeup" and a third-person guard. Confirmed for `/image/generate`; unverified
  for the Qwen edit routes. **Worth checking the Venice API docs before slice 0**,
  since it may be a cleaner fix than the scrub (or a complement to it).
- **Do the selfie and `chat_look` routes need the gate?** A selfie is the
  subject's own camera — `SELFIE_FRAMING` (`prompts.ts:1007`) is the POV rule's
  inverse and says "No one else in frame", so viewer parts must be **forced
  empty** there. `chat_look` is a wardrobe reference render, also no viewer.
  Recommend: parts are scene-framing-only, asserted by test.
- **Which parts should the composer be allowed to propose unprompted?** A
  conservative default (only when the narration states contact) keeps the blast
  radius small — most scenes render exactly as they do today. Alternative: let it
  propose hands freely for immersion. Recommend conservative to start.
- **Does the multi-reference rung need different geometry wording?**
  `assembleMulti` (`prompts.ts:1164`) enumerates references and identity-locks
  each; a viewer limb is not a reference, so the count line has to read "two
  people are fully in frame … plus the viewer's own hand" without the model
  treating the hand as reference 3. Untested.

## Related

- [persona-library.plan.md](persona-library.plan.md) — supplies the body and the
  coverage this consumes. **Hard dependency for slices 2–4.**
- `docs/images.md` §Scene images — the POV hard rule, the reference ladder, the
  `imageReveal` tag, and the "chat path only" precedent. **Update it here.**
- [finished/chat-selfies.plan.md](finished/chat-selfies.plan.md) — `SELFIE_FRAMING`,
  the POV rule's existing inverse.
- [finished/chat-scene-fidelity.plan.md](finished/chat-scene-fidelity.plan.md) —
  identity anchors + the state-aware chat scene (`visualStateNote`'s home).
- `docs/scene-image-eval/index.md` — the eval harness to extend.
</content>
