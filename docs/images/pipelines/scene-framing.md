# Scene framing

How a chat scene decides where the camera is, what of the viewer may appear, and how an
intimate act is depicted. The lane itself — cast, composer, attempt ladder — is
[scene-images.md](scene-images.md); what each person looks like is
[scene-subjects.md](scene-subjects.md).

## Player POV

Every scene image is composed from the player's eyes: first-person POV, and the player is
never visible.

**The framing names no limb, in any polarity.** "The player is the camera" made image models
paint hands gripping a camera; its replacement "no hands or held objects in frame" summoned
disembodied foreground hands whenever the pose text mentioned the character's hands or feet;
and an enumerated possession line — "every hand, arm, leg and foot belongs to Kristin" — still
painted a phantom viewer hand when A/B'd live
(`scripts/eval/scene-images/phantom-limb-ab.ts`). A limb noun summons a limb even when
possessively bound.

What ships, clean 3/3, is three parts together:

- `SCENE_POV_RULE` — "…the player is never visible in the image";
- the **person-count assertion** — "Exactly one person is fully in frame: Kristin. Nobody else
  appears."; and
- an **abstract possession clause** — "Every visible body part belongs to Kristin."

The pose text's own limbs are bound to the character by composer rule and by the deterministic
`bindLimbsToOwner` backstop ("one hand holding a cup" → "Kristin's hand holding a cup"), so a
limb appears in the prompt only where the shot wants one, and never without an owner.

## Embodied POV — chat lane only

The player's absolute absence is a useful lie: the fiction constantly puts their hands on
someone and a strictly disembodied shot cannot show it. The chat lane therefore lets the
viewer's own body enter the foreground.

`sceneFramingRule({parts, subjects})` returns the disembodied count/possession rule with no
parts and the embodied variant with them. `SceneComposerContext.embodiedViewer` is the opt-in,
and **only `buildCharacterSceneContext` sets it**, so the non-embodied variant stays the
default (`sceneComposerSystem(false) === SCENE_COMPOSER_SYSTEM`, pinned).

What stops a limb becoming a third person is never a negative — "no man in frame" anchors on
*man*, as "no camera" once did. It is **possessive binding** ("the viewer's own"), **frame
geometry** (cropped by the edge, strongly foreshortened — a limb the frame cuts through can't
be composed as someone standing there), and a **positive person-count assertion** derived from
the featured list, the realistic-model analogue of booru `solo focus`. The vocabulary is a
closed registry (`contracts/images/viewer-body.ts`), because the phrasing IS the feature.

**The anti-eagerness evidence gate.** An LLM given an optional field uses it far more often
than the fiction warrants, so every proposed part must carry a `viewerBodyEvidence` entry — a
**verbatim quote** from the recent narration that puts that part of the player in the shot —
and `resolveScenePlan` drops any part whose quote doesn't substring-match the transcript
(normalized; `images.scene_composer.viewer_body_ungrounded`, info). The composer proposes, the
transcript disposes. This is deliberately NOT a second "should we?" model call, which would
carry the same option-bias as the first.

The composer proposes non-intimate parts only — it runs with `allowIntimate: false` whatever
model its seam picks, since exposure gating is code's job however bold the composer is — so
**intimate anatomy never touches it**, exactly as `sceneRevealAppearance` never has.

`resolveViewerParts` is the gate: unknown id → route → coverage, with **missing coverage
counting as covered** (default-shut). It runs **per-prompt** inside `buildSceneRenderPrompt`,
since the ladder's rungs disagree about `allowIntimate`. Only anatomy is gated — a *clothed*
torso in frame is a fine POV element. The player's coverage is computed from their persona's
worn items ([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md) §The player's
wardrobe), never a manual flag, which is why that wardrobe has no `exposed` toggle at all.

## The camera

The composer proposes a **camera**: orientation (`toward_viewer` / `three_quarter` / `profile`
/ `away_glance_back` / `away`), distance (`close` / `medium` / `full_figure` / `wide`), and
height (`eye_level` / `high` / `low`) — a closed registry in
`contracts/images/scene-camera.ts`.

Any non-default orientation or height must carry a **verbatim quote** from the recent
narration or the player's own words, the same anti-eagerness gate as `viewerBodyEvidence`;
ungrounded degrades to the frontal default (`images.scene_composer.camera_ungrounded`). The
player's newest message joins the composer prompt (`The player's own words: …`) and **all**
player messages join the evidence corpus (`sceneEvidenceCorpus`) — "I come up behind her" is
the player's sentence, never the narrator's. **Away means fully away** (owner ruling):
`away_glance_back` needs a quote containing the glance itself (`GLANCE_WORDS`), else it
degrades to `away`.

`buildSceneRenderPrompt` emits a `Shot: …` line (focal-name-bound, non-default components
only; the all-default camera emits nothing, keeping evidence-less prompts byte-identical) and
**adapts the identity lock** when the shot hides the face — an appended sentence ("…face is
not visible in this shot; preserve the hair…, build and skin tone exactly from the reference —
do not rotate…"), never an edit of `PORTRAIT_IDENTITY_LOCK` itself, so the Qwen exact-string
lock rewrite still matches.

## Intimate staging

Intimate acts are staged from a closed catalog (`contracts/images/scene-staging.ts`, 13
entries). The composer picks an id plus a quote, and the registry owns every explicit word: a
template with per-entry camera, viewer parts, `requiresBare` subject regions, and an `intimate`
flag.

The gates are in code — lane, registry, **cast** (a `"solo"` entry needs exactly one present
NPC; every entry is solo today), committed-fact consistency, evidence, and subject coverage —
then a per-prompt route check and an **all-or-nothing viewer-part gate**: every part the
template names must survive `resolveViewerParts` on this prompt, or the sentence stays out.

A surviving staging overwrites the camera and its template leads the pose, and its named parts
drop out of the generic foreground-geometry line so the same hands are never placed twice.

**Committed scene facts beat inference.** The chat's scene state (`character_chats.scene` —
facing, postures, proximity, pair contacts, via `contracts/images/scene-committed.ts`) reaches
the composer as authoritative context lines and clamps its camera
(`images.scene_render.camera_from_state`); a staging whose geometry contradicts a committed
fact drops (`staging_contradicted`); absent facts change nothing.

The resolved `{camera, staging}` ids land on `images.meta` for the lightbox and probe grading.
Selfies skip the shot line, staging, and lock adaptation entirely, and the selfie sanitize
retry strips `staging` alongside the exposure fields.

## Staging changes the model

The stock scene model follows every compositional instruction but cannot draw explicit
anatomy, so an `intimate` staging on the uncensored reference route swaps the render onto the
LoRA-capable wrapper `qwen/qwen-image-edit-plus-lora` — resolved from the registry by base
slug, off every picker — bound to one builtin `image_loras` row at its curated scale
(`images/scene-lora.ts`, over the shared pairing in `images/nsfw-lora.ts`).

The trigger mirrors the staged sentence's own gates (intimate staging, not a selfie,
`allowIntimate`, reference route, an identity anchor), so the sanitize retry — which strips
`staging` — renders LoRA-free without a second rule, and every other render is untouched.

Four legs degrade to the stock model with `images.scene_render.lora_unavailable` naming which
one (`wrapper_model` · `wrapper_eligibility` · `library_row` · `credential`); the taken route
logs `images.scene_render.lora_route`. The stored locator is the LoRA's public URL and never a
credential: `CIVITAI_API_TOKEN` is read by one app-side accessor and appended as a query
parameter where the binding maps to provider input, so no token reaches the database, an image
row, or a log line. The image row records the wrapper slug and the resolved LoRA id in `meta`
beside `{camera, staging}`.
