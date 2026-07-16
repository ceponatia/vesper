# Scene POV embodiment — the player's own body in frame (plan)

Status: **shipped — 2026-07-16** (all five slices). Written the same day from an owner
brainstorm ask, alongside [persona-library.plan.md](persona-library.plan.md), which it
depends on and which shipped first.

> **Completion note.** Chat-lane scene images are now composed from the player's eyes *with
> a body*: their hands/arms/lap/legs enter frame when the narration puts them there, and
> their genitals only when the shot is already looking down their own body, their coverage
> reads bare, and the route is uncensored — three independent conditions, two of them code
> rather than judgment.
>
> **Not verified against a live model.** Every gate, clamp and phrase is unit-tested (pure),
> but no image has been rendered through this. §Testing describes the eval sweep and the
> **third-person contamination rate** it exists to measure — that is the next step, and it is
> the only thing that can tell us whether the anti-third-person levers actually work.
> Slices 1–4 are also **not deployed** (the running Fly build predates them).
>
> **Deviations, all recorded per slice below:** slices 1+2 landed together (the builder needs
> the registry's type); `SCENE_COMPOSER_SYSTEM` had to become lane-aware because it is shared
> by both lanes; the route gate runs per-prompt, not at plan time; and only anatomy is
> coverage-gated, since a clothed torso in frame is a fine POV element.

The dependency it needed: [persona-library.plan.md](persona-library.plan.md) supplies the
persona's body attributes (via `personaToCharacterProfile`) and the player's worn coverage
(`resolvePlayerWardrobe` → `exposedRegions(playerWorn)` — structured-only, with no manual
`exposed` flag to fake), stored on `character_chats.player_state`.

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

### Slice 1 — `SCENE_POV_RULE` becomes a builder — **shipped 2026-07-16**

Replace the constant with `sceneFramingRule(parts)`:

- `parts` empty → **today's exact string, byte-identical**. Default path, zero
  regression, snapshots unchanged.
- non-empty → the embodied variant (possessive binding + geometry + count line +
  head-out-of-frame).

Lands with the part list always empty, proving the seam without changing a single
rendered image. Belongs in the **never-dropped** tier of `budgetVenicePrompt`
(`prompts.ts:1140`) alongside the POV rule and pose — the Venice edit routes cap
at 1500 chars (`prompts.ts:1045`) and this must not be what gets excerpted.

> **Shipped together with slice 2**, not before it: `sceneFramingRule(parts)` cannot be
> written without the part type slice 2 defines, and slice 1 alone would have been a
> builder with nothing to build from. The byte-identical property the split existed to
> protect is kept as a **test** instead (`sceneFramingRule({})` ⇒ `SCENE_POV_RULE`), which
> is where it belonged anyway — and every caller still passes no parts, so not one rendered
> image changes yet.
>
> Two refinements found in build: the rule needs the **featured names** for its count
> assertion, so the signature is `sceneFramingRule({parts, subjects})` rather than
> `(parts)`; and **selfies ignore viewer parts entirely** — a selfie is the subject's own
> camera, with no viewer standing in the scene to have a body (pinned by test). The
> never-dropped-tier requirement turned out to be satisfied structurally: only
> `outfitSummary`/`setting` pass through `budgetVenicePrompt`'s `fit()`, so the framing rule
> was never at risk of being excerpted — now asserted by a test that budgets a fat prompt
> down to the 1500-char cap and checks the rule survives intact.

### Slice 2 — the viewer-part registry + the coverage gate — **shipped 2026-07-16**

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

> **Shipped as designed.** `resolveViewerParts` filters unknown id → route → coverage, and
> **missing coverage counts as covered** — the same default-shut rule `chatSceneIsIntimate`
> follows, so an unestablished scene earns nothing. One correction to the sketch above:
> **only anatomy is gated.** `torso` and `lap_thighs` are `requiresBare: null`, because a
> *clothed* torso in frame is a perfectly good POV element (you can look down at your own
> shirt) — the gate exists to stop anatomy rendering through trousers, not to stop the body
> being in shot. In practice `genitals` is the only gated part today.

### Slice 3 — the composer proposes — **shipped 2026-07-16**

Add `viewerBody: string[]` to `SceneSpec`, clamped against the registry in
`resolveScenePlan` (`prompts.ts:913`) with a diagnostic — the same clamp pattern
as `focal_clamped` / `absent_character_dropped`. Invert the two composer rules
(`prompts.ts:521`, `:526`): contact beats stop being dropped and instead become
viewer parts **plus** the character's half of the contact. Make
`scrubPlayerFromAction` part-aware — with parts in frame, rewrite "the player's
arm" → "the viewer's arm" rather than deleting the clause; keep the drop when the
list is empty.

> **Shipped as designed, plus one thing the plan missed: `SCENE_COMPOSER_SYSTEM` is shared
> by both lanes.** `composeSceneSpec` is called by the session pipeline *and* the chat
> scene, so inverting its rules in place would have quietly embodied the session lane too —
> against this plan's own §Lane scope. It is now `sceneComposerSystem(embodied)`, opted into
> by `SceneComposerContext.embodiedViewer`, which only `buildCharacterSceneContext` sets.
> `SCENE_COMPOSER_SYSTEM` remains as the disembodied prompt and a test pins the two
> byte-identical, so the session lane's prompt did not move at all.
>
> The clamp turned out to want **two** diagnostics rather than one:
> `viewer_body_unrequested` (a lane that never asked — the composer ignored its rules) and
> `viewer_body_dropped` (an id outside the vocabulary, *including an intimate one* — the
> composer runs `allowIntimate: false` and has no intimate vocabulary, so proposing
> `genitals` is off-script even though the render gate would also catch it).
>
> The **route gate runs per-prompt, inside `buildSceneRenderPrompt`**, not at plan time:
> the ladder's rungs disagree about `allowIntimate` (uncensored edit yes, text-to-image
> fallback no) and each gets its own prompt — so the plan carries the registry-clamped
> proposal + the player's coverage, and each prompt intersects them with its own route.
> Exactly how `intimateAppearance` already works.
>
> `scrubPlayerFromAction` is embodied-aware, but only when parts are actually in frame:
> rewriting "her hand on the player's arm" → "the viewer's arm" in a shot with no arm in it
> would ask for something the image doesn't contain.

### Slice 4 — persona body facts reach the prompt — **shipped 2026-07-16**

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
- ~~**Which parts should the composer be allowed to propose unprompted?**~~ **Built
  conservative**: the rule says "empty is the default and the common case — list a part
  ONLY when the recent narration puts it in the frame", so most scenes render exactly as
  they did. Loosen it if POV shots feel too rare once the eval has run.
- **When are the viewer's genitals in frame? — the one rule with no owner ruling behind
  it.** The composer cannot propose them (no intimate vocabulary, by design), so they are
  *derived*: the shot must already be looking down the viewer's body (`lap_thighs` or
  `torso` in frame) — a hand on her cheek is not a view of your own crotch — and then the
  ordinary gate still applies (pelvis bare/sheer, uncensored route).
  `LOOKING_DOWN_PART_IDS` in `contracts/images/viewer-body.ts` is that guess, and it is a
  one-line data edit. **Worth an explicit ruling once the eval shows what it looks like.**
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
