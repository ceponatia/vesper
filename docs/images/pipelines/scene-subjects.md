# Scene subjects

How every person in a chat scene gets described: where their facts come from, how coverage is
stated, what the identity reference underspecifies, and how live chat state reaches the shot.
The lane is [scene-images.md](scene-images.md); the camera and POV rules are
[scene-framing.md](scene-framing.md).

## Facts come from the visual image digest

Every present character sources their facts from the visual image digest
(`server/images/scene-subject-visual.ts`). The queue hands the render one **committed chat cut
per present member** — camera-less shadow inputs built by `chatVisualStateShadowInput`
(`engine/chat-pipeline.ts`), the same factory the admin visual-state inspector preview uses, so
the scene digest and the preview assemble one cut identically — resolving every member's memory
group in one batched query. A selfie's cast is trimmed to the sender. A member with no
participant row has no cut — the queue warns and skips them — and a cut naming a different
character is skipped with `images.scene_render.visual_subject_mismatch` (warn). Either way the
program describes nobody it has no cut for, and the render then refuses rather than drawing the
rest: the cut is the only description of a person a scene has, so a member without one is a
member the picture cannot contain ([scene-images.md](scene-images.md) §Trigger and cast).

After the composer's plan resolves, `applySceneCastVisual` binds the plan's **viewpoint** —
its committed camera, plus the band the composer's own lighting phrase names — into each
member's ONE selection pass, never a re-select, and hands back one `SceneSubjectVisualSlice`
per person: the realized digest, the three-layer attribute resolve it was selected over, the
realized body and the canonical coverage readout — the program's own cut shape. The viewpoint
is built once per plan: two people in one shot stand in one room under one lamp, and a
per-subject derivation is how two members of one cast end up selected at different detail
tiers. A scene that named no light leaves the lane's declared band standing rather than
asserting a darkness nobody established ([scene-framing.md](scene-framing.md) §The camera).

Two output consequences ride this sourcing:

- covered `imageReveal: "skin"` surface detail does not reach a text-to-image scene prompt (the
  coverage-aware selection — painted toenails under slippers stay unstated); and
- scene prompts carry the digest's **mandatory morphology anchors** — horns, wings, tail — which
  the reference-subject field production could not express (the identity-anchor whitelist does
  not carry them).

The digest owns the species feature groups, anatomy departures, cataloged distinctive marks,
and the current-state owners (active conditions, body-surface wetness). What a chat scene
sends is compiled from the **cut itself** — the digest, the subject's resolved attributes, the
canonical coverage readout and the realized body — through the character seam
([../character-prompts.md](../character-prompts.md)): the character adapter projects the visual
attributes the digest does not carry as typed subject facts, states coverage **once** as
authoritative `subject.exposure` claims over the readout, and synthesizes the identity anchor
for a subject a required identity reference names. Of the plan's per-character fields, the
lowering reads only the name, the pose and the activity — `SceneCharacterSpec` carries no
appearance, anchor or reveal text — and the plan's outfit summary and exposure serve the
composer and the staging gate, never the image model.

The scene's own decisions — the setting, the light, the mood, the capture mode, the staged
arrangement, what each person is doing — do not travel as prose either: the lane lowers its
resolved plan into typed prompt-program inputs (`scene-lowering.ts`), and the endpoint's
dialect words them ([scene-framing.md](scene-framing.md)). A cut that cannot be built **fails
the row before provider spend** (`images.scene_render.visual_digest_unavailable`), and the
cast's `meta.visualState` provenance is written at reserve time so it survives a failed
render. A cut that assembles but loses a required anchor on its way to the prompt is the
compile's refusal, not this seam's: every rung compiles with `refuseOnMissingRequired`, and a
refusing rung is dropped from the chain ([scene-images.md](scene-images.md) §The attempt
ladder).

## One digest describes the whole cast

Each member is realized from their own committed cut, so a render that compiles a
[prompt program](../prompt-programs.md) folds those cuts into the single
multi-subject digest the assembly takes.

The fold keeps every fact, every subject slice and every suppression in cast
order, re-ranks nothing and drops nothing: the per-cut selection already applied
the camera, the policy and the budget, and re-deciding would make the merged
digest disagree with the provenance each cut recorded. Prompt budget stays the
dialect compile's job, which is the layer that knows the endpoint's ceiling. The
snapshot and selection fingerprints are folds of the members' own, so two casts
fold alike exactly when every member's cut was the same.

Three preconditions refuse before provider spend:

- **One committed moment.** The queue mints one cut id for the whole cast, so two
  ids mean two scenes' visual truth.
- **One camera.** Merging cuts selected under two cameras would pick one of two
  contradictory shots with nothing recording that the other existed.
- **One entry per person.** A duplicated subject gives the cast an extra body.

Scope is deliberately **not** a precondition: a chat scopes a memory group per
participant, so two people in one render never share one, and equality would
refuse every ensemble scene. The merged digest carries the focal's scope, which
travels nowhere — a committed read names its cut, not its scope — and each
member's own scope is already recorded in the per-member `meta.visualState`
provenance the row carries.

## One field production describes everybody

`applySceneCastVisual` runs one shadow assembly, one camera-bound selection and one digest
realization per subject — nobody can answer what somebody else is wearing or showing — and
feeds every one of them through the same per-subject producer that describes a lone character
(`applySceneSubjectVisual` is the one-subject spelling of the same call). Focal first, then
roster order: the merged provenance takes its identifying fields from the head record, and a
refusal names the focal's failure before a bystander's. There is no second appearance
algorithm for bystanders.

The per-subject provenance merges into **one** `meta.visualState` record: subjects and
suppressions concatenated in cast order, snapshot and selection fingerprints combined into a
cast-wide composite, the cut id and story minute from the shared cut, and the camera
fingerprint from the focal — the framing identity of a shot is the focal's read.

A cut that cannot be assembled refuses the **whole** render, and a required anchor no owner can
value refuses the rung, for a bystander as readily as for the focal: a scene missing one
person's anchors is the same wrong picture.

## Bare-region phrasing

Listing only worn garments isn't enough — image models default every subject to fully clothed,
so a removed top never shows. From each NPC's coverage (`exposedRegions` + `formatExposure`,
the visibility rule owned by
[../../contracts/items/visibility.md](../../contracts/items/visibility.md))
the lane classifies torso (`chest`), lower body (`pelvis`/groin·hips), legs (`thighs`), and
feet as `covered` / `sheer` / `bare`, then injects explicit phrasing: "topless, bare chest",
"bare below the waist", "bare legs", "barefoot", or a single "fully nude" when torso, pelvis
and legs are all bare.

Chat wardrobe state is authoritative. If a character has no worn clothing items,
`exposedRegions([])` is the current outfit state and the render prompt says they are nude
rather than keeping a clothed reference avatar.

**Head and hands are deliberately omitted** — bare there is the universal default and would
fire on everyone. **Feet are included by choice**, and since pants stop at `ankles`, an NPC
with no modelled footwear reads barefoot.

## Subject body reveal

The identity reference is a **waist-up** portrait, so it locks the face and upper body but
underspecifies the figure below it — and a committed cut cannot supply the intimate half of
that figure. The visual-state image selection keeps its consent gate **shut in every lane**
(the chat lane has no consent owner, and no owner is not "allowed"), so no cut carries
intimate anatomy whatever the wardrobe exposes. Non-intimate body facts are the cut's own and
reach the prompt as the digest's facts.

The scene **route** supplies the intimate half instead, per rung, as typed
`subject.intimate_anatomy` facts beside the digest (`contracts/images/subject-reveal.ts`,
through the character seam's `intimateReveal` input) — on a rung whose references permit
intimate detail, which is the uncensored reference-edit rungs and never the bare-prompt
fallback or a content-rejection retry. The projection reads the cut's own resolved attributes
and coverage readout under one rule, the same one the Image Lab's staged bench compiles
through ([../../contracts/attributes.md](../../contracts/attributes.md) `imageReveal`):

- `"shape"` — silhouette that reads *through* clothing (breast size and shape) — is stated
  **always**;
- `"skin"` — surface detail (nipples) — only when its region reads bare or sheer;
- untagged intimate anatomy (vulva, penis, testicles) when its region is exposed; anal and
  perineal categories never render in an image (owner ruling 2026-07-23: every render views
  the character from the front);
- sensory scent and taste never render.

A rung that forbids intimate detail compiles the cut alone. Coverage is not intimate detail
and is stated on every rung — "bare at the torso" is the wardrobe's truth, and the reveal is
what a bare torso lets the prompt say about the body under it. The projection runs at render
assembly, not via the composer LLM.

The cut is selected **once**, and every rung of the attempt chain compiles the same cut. What
differs per rung is what the route adds to it: the intimate reveal above, and the intimate
**staging**, which the scene lowering carries only on a route whose references permit it
([scene-framing.md](scene-framing.md) §Intimate staging).

This is wired on the **character-chat scene path only** (`images/character-scene.ts`, the
iteration ground for image-prompt tuning); avatars keep strict exposure gating
([avatars.md](avatars.md) §Intimate-anatomy gating). The chat lane's outfit and exposure come
from the chat state's wardrobe resolve, never `profile.defaultOutfit`
([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md)). Tuning which fields
reach the model — or flipping one between shape and skin — is a one-line registry edit on the
attribute.

## State-aware appearance

`buildCharacterSceneContext` folds the chat's live state into the shot. Active conditions
overlay attributes via `conditionAttributeOverlays` inside each member's cut, so a
"disheveled" or "unwashed" condition renders that way with the same inherent-attribute guard
as the narrator prompt; mood and affect ride the identity reference. Meters are not a
visual-state owner: no committed cut carries a meter reading and no compiled scene states one,
so a meter's physiology reaches a prompt only if it is lowered as a typed scene fact.

**No skin-colour words anywhere in an image prompt.** "Flushed", "blushing" and "rosy" render
as *stage blusher* — a clown-makeup face, not a body state — so a body state is stated as
physiology the model paints as physiology (eyes, lips, breath, sweat, posture, hair). The one
leak path is the **composer echo**: the narrator's own arousal threshold hint says "flushed
skin" (`contracts/meters/registry.ts`), and the composer reads it in the recent narration and
hands it back in `pose` or `mood`. `SCENE_COMPOSER_SYSTEM` rules against colour words *and*
`scrubBlush` (`images/prompts-scene-plan.ts`, applied to each action field in `characterSpec`
and to `mood` in `resolveScenePlan`) drops any surviving clause whole — the rule alone is not
trustworthy, the same belt-and-braces as `scrubPlayerFromAction`. Deliberately **not**
scrubbed: `skin.undertone: rosy` is an authored identity attribute (the registry is the
author's intent, not the composer's slip), and the narrator's hint itself stays, because
narration isn't rendered.

## Identity anchors and the setting

A subject named by a required identity reference carries a synthesized **identity anchor** in
the digest — a model-neutral fact that this subject is the person in the reference — and the
bound endpoint's dialect words the lock
([../character-prompts.md](../character-prompts.md) §Identity on a reference-anchored render).
The reference stays authoritative for the face: an edit lane's digest states no identity
descriptors, so nothing in the prompt invites the model to repaint what it should be copying.
`ScenePresentCharacter` and `SceneCharacterSpec` carry no appearance or anchor text at all —
the cut is the only description of a person a scene render has.

**Setting from scene memory:** `queueChatScene` derives the `room` from the chat's scene memory
— the current place's background **sketch** when the `chat_scene_sketch` agent has written one,
else its established name and details — and threads `sceneMemory.timeOfDay` through. An empty
memory keeps the `DEFAULT_CHAT_ROOM` placeholder.

## Player-free poses

The composer's pose and activity rules require each phrase to be paintable with the character
ALONE. Player-directed beats translate to their solo equivalent: gaze and orientation become
"toward the viewer"; contact and leading are dropped while expression and energy are kept — a
worked example lives in `SCENE_COMPOSER_SYSTEM`. Pose and activity must carry distinct beats
(no smile in one and laugh in the other).

A deterministic backstop, `scrubPlayerFromAction` (applied in `characterSpec`, so composer text
and the posture/activity fallback both pass through it), rewrites gaze-type player references
to the viewer and drops any clause still naming the player. Pronoun references are deliberately
left to the composer rule, because in a multi-character scene a pronoun may be another
character.

**Pose and activity stay two fields all the way down.** How a body is HELD and what it is
DOING are different beats and they lower to different concepts, so every scrub — the player
scrub, the blush scrub, and the `bindLimbsToOwner` backstop — runs on each field on its own,
trailing period stripped first. Losing `bindLimbsToOwner` on either half reopens a recorded
phantom-limb failure ([scene-framing.md](scene-framing.md) §Whose eyes the shot is through).
The roster fallback fires only when the composer wrote neither field: a pose with an empty
activity is an answer, and backfilling state over it would state a stale activity beside a
fresh pose.
