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
participant row, or a cut naming a different character, degrades to the legacy field production
**for that member alone**, with a warn rather than a refusal.

After the composer's plan resolves, `applySceneSubjectVisual` binds the plan's **viewpoint** —
its committed camera, plus the band the composer's own lighting phrase names — into the
digest's ONE selection pass, never a re-select, and replaces the focal spec's preformatted
appearance, identity-anchor and reveal fields with digest-sourced clauses, through the same
segments builder and clause table the avatar lane uses, under the scene policy: **age never
stated, full-figure frame, intimate skin only where the region reads bare**. The viewpoint is
built once per plan: two people in one shot stand in one room under one lamp, and a per-subject
derivation is how two members of one cast end up selected at different detail tiers. A scene
that named no light leaves the lane's declared band standing rather than asserting a darkness
nobody established ([scene-framing.md](scene-framing.md) §The camera).

Two output consequences ride this sourcing:

- covered `imageReveal: "skin"` surface detail does not reach a text-to-image scene prompt (the
  coverage-aware selection — painted toenails under slippers stay unstated); and
- scene prompts carry the digest's **mandatory morphology anchors** — horns, wings, tail — which
  the reference-subject field production could not express (the identity-anchor whitelist does
  not carry them).

The digest owns the species feature groups, anatomy departures, cataloged distinctive marks,
and the current-state owners (active conditions, body-surface wetness). The route's **residual
sheet** keeps everything the projection does not yet carry in the legacy flat form,
`identityAnchorSummary` still leads the anchor phrase (the digest's identity/morphology clauses
join it), a cataloged mark keeps its single statement on the sheet/anchor side, and the reveal
lines (`sceneRevealAppearance`) keep their exposure machinery and per-route intimate gating.

The transport emits `appearance` for textual subjects and `identityAnchors` for referenced ones
— mutually exclusive per subject — so a fact is never stated twice in one prompt, and the
builder's own exposure segment is deliberately not consumed: the transport already states
coverage once, from the queue's canonical readout.

**What this sourcing changes is where the per-character field strings come from, and nothing
else.** The scene's own decisions — the setting, the light, the mood, the capture mode, the
staged arrangement, what each person is doing — do not travel as prose at all: the lane lowers
its resolved plan into typed prompt-program inputs, and the endpoint's dialect words them
([scene-framing.md](scene-framing.md)). LoRA routing and the attempt chains are untouched. A
digest that cannot be built, or a required fact with no resolvable clause, **fails the row
before provider spend** (`images.scene_render.visual_digest_unavailable` /
`images.scene_render.visual_required_missing`), and the digest's `meta.visualState` provenance
is written at reserve time so it survives a failed render.

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
feeds every one of them through the same per-subject producer that describes a lone character,
patching `plan.focal` and the matching `plan.others` entries. There is no second appearance
algorithm for bystanders.

The per-subject provenance merges into **one** `meta.visualState` record: subjects and
suppressions concatenated in cast order, snapshot and selection fingerprints combined into a
cast-wide composite, the cut id and story minute from the shared cut, and the camera
fingerprint from the focal — the framing identity of a shot is the focal's read.

A required fact with no clause refuses the **whole** render, for a bystander as readily as for
the focal: a scene missing one person's anchors is the same wrong picture.

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
underspecifies the figure below it. `buildSceneRenderPrompt` therefore supplements the
identity-locked subject with a body line built from attributes tagged `imageReveal`
([../../contracts/attributes.md](../../contracts/attributes.md)):

- `"shape"` — silhouette that reads *through* clothing (breast size/shape, waist, hips, leg
  build/length, foot size) — is described **always**;
- `"skin"` — surface detail (nipples, leg hair, toenails, foot arch) — only when its region
  reads bare or sheer.

`sceneRevealAppearance(…, {intimate})` splits them by sensitivity: the SFW lower-body half
(`Body (below the portrait's framing): …`) rides every route, while the intimate half (breast
silhouette always, nipples and anatomy when exposed) rides only the uncensored route. Untagged
intimate anatomy (vulva, penis) keeps the plain exposure gate, so nothing is lost. Sensory
scent and taste never render.

`buildSceneRenderPrompt` emits the intimate half **only when `allowIntimate` is set**, which
`renderResolvedScene` passes on the uncensored reference-edit rungs and never on the
bare-prompt fallback. It is injected at render assembly, not via the composer LLM — so a scene
shows explicit anatomy iff the character has it, the region is exposed, and the route is
uncensored.

This is wired on the **character-chat scene path only** (`images/character-scene.ts`, the
iteration ground for image-prompt tuning); avatars keep strict exposure gating
([avatars.md](avatars.md) §Intimate-anatomy gating). The chat lane's outfit and exposure come
from the chat state's wardrobe resolve, never `profile.defaultOutfit`
([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md)). Tuning which fields
reach the model — or flipping one between shape and skin — is a one-line registry edit on the
attribute.

## State-aware appearance

`buildCharacterSceneContext` folds the chat's live state into the shot. Active conditions
overlay attributes via `conditionAttributeOverlays`, so a "disheveled" or "unwashed" condition
renders that way with the same inherent-attribute guard as the prompt, and
`visualStateNote(meters)` appends a render-tuned visible-state phrase — glassy-eyed and
unsteady from intoxication, lank and sheened from low hygiene, heavy-lidded from low energy,
breath shallow from arousal — to the subject's appearance. The route threads
`chatState.meters` and `conditions` in; mood and affect ride the avatar reference, not this
note.

**No skin-colour words anywhere in an image prompt.** "Flushed", "blushing" and "rosy" render
as *stage blusher* — a clown-makeup face, not a body state — so every meter phrase states
physiology the model paints as physiology instead (eyes, lips, breath, sweat, posture, hair).
Two leak paths are closed: `visualStateNote` is the deterministic one, and the **composer echo**
is the LLM one, since the narrator's own arousal threshold hint says "flushed skin"
(`contracts/meters/registry.ts`) and the composer reads it in the recent narration and hands it
back in `pose` or `mood`. `SCENE_COMPOSER_SYSTEM` rules against colour words *and* `scrubBlush`
(`images/prompts-scene-plan.ts`, applied to each action field in `characterSpec` and to `mood`
in `resolveScenePlan`) drops any surviving clause whole — the rule alone is not trustworthy, the
same belt-and-braces as `scrubPlayerFromAction`. Deliberately **not** scrubbed:
`skin.undertone: rosy` is an authored identity attribute (the registry is the author's intent,
not the composer's slip), and the narrator's hint itself stays, because narration isn't
rendered.

## Identity anchors and the setting

`identityAnchorSummary` (whitelisted identity-critical attributes — skin tone and undertone,
lips, eyes, hair, face shape and freckles) rides `ScenePresentCharacter.identityAnchors` on the
chat context builder, and `buildSceneRenderPrompt` emits it **only for the identity-locked
reference subject**, worded reference-authoritative ("Same person as the reference image — …
the reference is authoritative where they differ") so it reinforces the lock without overriding
the avatar. The multi-reference path gets the same per-anchored-character phrase.

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
