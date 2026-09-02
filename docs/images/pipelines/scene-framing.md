# Scene framing

How a chat scene decides where the camera is, whose eyes the shot is through, what of the
viewer may appear, and how an intimate act is depicted — and how each of those decisions
reaches the prompt a provider receives. The lane itself — cast, composer, attempt ladder — is
[scene-images.md](scene-images.md); what each person looks like is
[scene-subjects.md](scene-subjects.md).

## Owns / does not own

- **Owns:** the composer's capture-mode, camera, viewer-body and staging decisions, the
  evidence gates that admit them, and the **lowering** that turns a resolved plan — and the
  viewer's own body in its foreground — into the typed inputs a prompt program compiles
  (`server/images/scene-lowering.ts`).
- **Does not own:** the vocabulary those inputs are written in, or the `scene` and `viewer`
  channels they travel on ([../prompt-programs.md](../prompt-programs.md) §Scene semantics);
  the final wording, which is the endpoint dialect's; how each person is described
  ([scene-subjects.md](scene-subjects.md)).

The lowering runs **per rung**, not per plan: the ladder's rungs disagree about
`allowIntimate`, and the plan commits its decisions once.

## Whose eyes the shot is through

Every chat scene image is composed from the player's eyes unless the route says otherwise.
**An absent capture decision means first-person POV; this lane never asserts a third-person
camera.** Which first person it is — disembodied, or embodied with the viewer's own body
cropped in — is resolved **per rung** from the parts that survive that rung's gates, because
a prompt that asserts the viewer's absence beside a description of their hands contradicts
itself. Embodiment is a framing state, not only a set of per-part claims: it decides the
capture-mode sentence, whether the possession clause may run, and how the count is worded.

Third person versus first belongs to the route rather than the composer — a selfie is chosen
before the plan is composed, and asking a model to re-derive it would let a confused answer
un-selfie a render the player asked for — and the shared vocabulary deliberately carries no
default capture mode, so no lowering can spell `framing ?? default` and invert every chat
scene into an observing camera.

**The framing names no limb, in any polarity.** "The player is the camera" made image models
paint hands gripping a camera; its replacement "no hands or held objects in frame" summoned
disembodied foreground hands whenever the pose text mentioned the character's hands or feet;
and an enumerated possession line — "every hand, arm, leg and foot belongs to Kristin" — still
painted a phantom viewer hand when A/B'd live (the phantom-limb A/B; its probe script is
retired to git history). A limb noun summons a limb even when possessively bound.

What ships, clean 3/3, is a composite of four parts across three layers, no one of which is a
single POV sentence:

- the **capture-mode claim** (`scene.capture_mode`), marked required so no budget squeeze can
  drop it and leave the other three arguing about a frame nobody described;
- the **person-count assertion** — "Exactly one person is in frame." — carried by the operation
  contract's subject count rather than by a scene claim. It counts the **cast**, never the
  viewer, so an embodied shot takes the `fully in frame` wording instead: the cast are the
  bodies the frame holds whole, and a limb the frame edge cuts is not one of them. The tag
  family says the same thing as `solo focus` rather than `solo`. The distinction is the
  dialect's to spell; that the count excludes the viewer is not;
- an **abstract possession clause** (`scene.possession`) — "Every visible body part belongs to
  Kristin." Its value is a list of entity refs the dialect resolves to names, so there is no
  place in the fact for a limb noun. It is emitted for the **disembodied** first person only:
  a selfie has the subject's own arm on the lens, an observing camera has no viewer in the
  room to bind limbs against, and an embodied frame would be handing the viewer's own limbs
  to an NPC;
- **`bindLimbsToOwner`**, the deterministic backstop ("one hand holding a cup" → "Kristin's
  hand holding a cup"), which stays upstream in the application and is not a claim. It runs on
  the pose and the activity separately, because the composer produces them as two fields.

So a limb appears in the prompt only where the shot wants one, and never without an owner.

## The embodied viewer — chat lane only

The player's absolute absence is a useful lie: the fiction constantly puts their hands on
someone and a strictly disembodied shot cannot show it. The chat lane therefore lets the
viewer's own body enter the foreground. `SceneComposerContext.embodiedViewer` is the opt-in,
and **only `buildCharacterSceneContext` sets it**, so the non-embodied composer system stays
the default (`sceneComposerSystem(false) === SCENE_COMPOSER_SYSTEM`, pinned).

What stops a limb becoming a third person is never a negative — "no man in frame" anchors on
*man*, as "no camera" once did. It is **possessive binding** ("the viewer's own"), **frame
geometry** (cropped by the edge, strongly foreshortened — a limb the frame cuts through can't
be composed as someone standing there), and the **positive person-count assertion** above, the
realistic-model analogue of booru `solo focus`. Which parts exist is a closed registry
(`contracts/images/viewer-body.ts`) because it is a gate list before it is anything else;
the two anchors are the endpoint dialect's words, and a compiled prompt is where they are
checked.

**The anti-eagerness evidence gate.** An LLM given an optional field uses it far more often
than the fiction warrants, so every proposed part must carry a `viewerBodyEvidence` entry — a
**verbatim quote** from the recent narration that puts that part of the player in the shot —
and `resolveScenePlan` drops any part whose quote doesn't substring-match the transcript
(normalized; `images.scene_composer.viewer_body_ungrounded`, info). The composer proposes, the
transcript disposes. This is deliberately NOT a second "should we?" model call, which would
carry the same option-bias as the first.

The composer proposes non-intimate parts only — it runs with `allowIntimate: false` whatever
model its seam picks, since exposure gating is code's job however bold the composer is — so
**intimate anatomy never touches it**; the intimate reveal is the route's own projection over the
committed cut (`contracts/images/subject-reveal.ts`), spent per rung at render assembly.

`resolveViewerParts` is the gate: unknown id → route → coverage, with **missing coverage
counting as covered** (default-shut). Only anatomy is gated — a *clothed* torso in frame is a
fine POV element. The player's coverage is computed from their persona's worn items
([../../character-chat/wardrobe.md](../../character-chat/wardrobe.md) §The player's wardrobe),
never a manual flag, which is why that wardrobe has no `exposed` toggle at all.

**Every part that survives the gate reaches the prompt, and the viewer channel is what
carries it.** The viewer is not a subject — no entity slice, no ref a relation could bind, no
place in `operation.subjectCount` — so their facts ride the digest's flat scene list on a
channel of their own, between the scene and the cast
([../prompt-programs.md](../prompt-programs.md) §Scene semantics). Three concepts, projected
by `contracts/images/viewer-digest.ts`:

- **`viewer.body_geometry`** — the parts the frame crops in, as ids. One clause for all of
  them, because the foreground is a single region of the picture and three separate
  statements about it give a model three chances to compose three separate things. The
  geometry sentence is the endpoint dialect's, exactly as a camera band's is; the part
  vocabulary is what crosses the seam.
- **`viewer.appearance`** — the skin and build of those parts, from the player's persona
  through the one persona→character adapter. `skin.tone` and `build.frame` ride any embodied
  frame and each part adds only its own descriptors, so a shot of the viewer's hands on
  someone's cheek does not state their leg hair. Without it a foreground arm changes colour
  between shots and reads as a different person reaching in.
- **`viewer.intimate_anatomy`** — the exposed half, stated only by a route that permits it,
  and **only for a region the frame is pointed at**. Coverage and framing are two separate
  questions here, unlike for the cast: the camera is the viewer's own eyes, so a shot holds a
  few cropped limbs rather than a whole figure, and what the wardrobe leaves uncovered
  elsewhere on the body is not in the picture. Each part declares the exposure regions it
  puts on screen (`revealsIntimateRegions` — `torso` shows the torso, `genitals` the pelvis,
  every other part none), and an intimate attribute is stated only when an in-frame part
  shows its region **and** the coverage readout uncovers it. Coverage is the cast's own rule
  reused, so the two paths cannot disagree about what a bare region permits.

**A part a staged sentence already places gets no generic geometry line.** A staging says
where a limb is on somebody and the geometry claim says where it is relative to the lens;
both at once puts the same two hands in two places in one prompt, which is the
self-contradiction that makes a model paint a third party's arms rather than choose. The
staging owns geometry and nothing else — its parts still carry the viewer's skin and build,
and the ownership is read off the staging claim the rung actually emitted, so an arrangement
the route or coverage withheld leaves its parts to the generic line.

**A part's derived-intimate rule stands.** `genitals` is added when `lap_thighs` or `torso`
is already in frame, because the composer has no intimate vocabulary and can never propose
it, and that framing is the only one in which the part is in view. It earns nothing on its
own: the route and coverage gates still run over the result, and without the derivation the
viewer's own exposed anatomy would have no path to a prompt at all.

## The camera

The composer proposes a **camera**: orientation (`toward_viewer` / `three_quarter` / `profile`
/ `away_glance_back` / `away`), distance (`close` / `medium` / `full_figure` / `wide`), and
height (`eye_level` / `high` / `low`) — a closed registry in
`contracts/images/scene-camera.ts` over the shared vocabulary.

Any non-default orientation or height must carry a **verbatim quote** from the recent
narration or the player's own words, the same anti-eagerness gate as `viewerBodyEvidence`;
ungrounded degrades to the frontal default (`images.scene_composer.camera_ungrounded`). The
player's newest message joins the composer prompt (`The player's own words: …`) and **all**
player messages join the evidence corpus (`sceneEvidenceCorpus`) — "I come up behind her" is
the player's sentence, never the narrator's. **Away means fully away** (owner ruling):
`away_glance_back` needs a quote containing the glance itself (`GLANCE_WORDS`), else it
degrades to `away`.

**Only the components that moved are lowered.** `toward_viewer` + `medium` + `eye_level` is
what "no evidence moved the camera" resolves to, so a shot that resolved it asserts nothing
about where the lens is; distance and framing fall silent together, because both are read off
one shot distance and keeping the crop while dropping the reach leaves half a camera standing.
The suppression lives in the lowering and only there — **the compiler may never synthesize a
camera from that absence**, because a compiler-side default would assert a front-on waist-up
frame on every scene the fiction never framed.

Height is the one component nothing upstream can supply: the visibility model weights detail by
distance, angle and light, and how high the lens sits changes none of that. It enters the
digest as a `camera.height` fact through the assembly input rather than as a visibility read.

**A scene that names its own light overrides the placeholder.** The visual lane declares
`lighting: bright`, and a declared read is a known read, so the placeholder was reaching the
prompt and telling every night scene it was brightly lit. The composer's lighting phrase now
names a band (dark / dim / bright, checked darkest first — a phrase naming both ends, "a single
candle against the dark", is the darker one) and that band enters the one selection pass
through the same door distance, angle and framing already use, while the phrase itself travels
as a `location.lighting` claim. The camera's own lighting fact is always silent, so a
three-band restatement can neither agree redundantly nor contradict the scene's words. A phrase
that classifies as nothing leaves the band unstated rather than inventing one, and `silhouette`
stays camera-only — backlighting says where the camera stands, not how a place is lit.

**A shot that cannot show the face adapts the lock.** Face visibility is the orientation
registry's answer — `profile` and `away_glance_back` are partial, `away` is hidden — and a
staged arrangement may override it, a shot down onto the crown of a head being the case the
override exists for. Whenever the answer is not "the whole face", the lowering states it as a
`subject.face_visibility` claim on the focal, and each dialect words it as **its own sentence
beside the identity lock**: what to preserve when the face is not the evidence — hair, build
and skin tone, plus the visible features on a partly turned shot — and that the subject is not
to be rotated to face the camera. The lock string itself is never edited, because it is matched
verbatim at the model boundary; the lock is the dialect's, emitted from the digest's identity
anchor ([../character-prompts.md](../character-prompts.md) §Identity on a reference-anchored
render).

A front-facing shot states nothing — there is no adaptation to make when the face is the
evidence — and neither does a selfie, where the subject holds the lens and the geometry is
theirs rather than a camera the fiction moved. A staging's own answer wins over the
orientation's wherever the plan committed the arrangement, **including on a rung whose gates
withheld the staged sentence**: withholding the words never un-turns the body.

## Intimate staging

Intimate acts are staged from a closed catalog (`contracts/images/scene-staging.ts`, 13
entries). The composer picks an id plus a quote; the **registry** owns selection, the camera
override, the viewer parts, `requiresBare`, the `intimate` flag, face visibility, cast and every
explicit word, while the ids and what each one means in facts are shared with the compiler
([../prompt-programs.md](../prompt-programs.md) §Scene semantics). The registry is a keyed
record satisfying the shared table, so adding an id fails the registry until it answers for it,
and the order a menu or a composer prompt enumerates the catalog in is an explicit list rather
than object key order.

The gates are in code — lane, registry, **cast** (a `"solo"` entry needs exactly one present
NPC; every entry is solo today), committed-fact consistency, evidence, and subject coverage.
The lowering then re-runs the per-render ones on **each rung**:

- a **selfie** has no viewer standing anywhere for a two-body geometry;
- an **intimate** arrangement travels only a route that permits it;
- every viewer part the template names must survive `resolveViewerParts` on that rung, **all or
  nothing**. This one is the leak-proofing: a template speaks the viewer's anatomy in its own
  words, so an arrangement emitting while the coverage gate dropped a covered player's part
  would smuggle past the very rule the phrasing is checked by.

A committed arrangement the lowering does not state is recorded with its reason
(`images.scene_lowering.staging_unsent`, info). One that survives is a **required** scene
claim — a scene that silently lost it renders as an ordinary portrait of an intimate beat — and
its camera replaced the proposed one when the plan resolved, because the geometry is entailed
by the act.

**Committed scene facts beat inference.** The chat's scene state (`character_chats.scene` —
facing, postures, proximity, pair contacts, via `contracts/images/scene-committed.ts`) reaches
the composer as authoritative context lines and clamps its camera
(`images.scene_render.camera_from_state`); a staging whose geometry contradicts a committed
fact drops (`staging_contradicted`); absent facts change nothing.

The resolved `{camera, staging}` ids land on `images.meta` for the lightbox and probe grading. A
selfie drops both the staged arrangement and the possession clause, and the selfie sanitize
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
