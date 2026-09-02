# Scene images

The character-chat scene lane. The render pipeline is shared with avatars and portraits; the
chat lane feeds it via `buildCharacterSceneContext` + `queueChatScene`
(`images/character-scene.ts`) and runs as a `scene_image` job.

Framing, camera and staging are [scene-framing.md](scene-framing.md); how each person is
described is [scene-subjects.md](scene-subjects.md). The lane's player-facing triggers,
cooldowns and lifecycle are [../../character-chat/images.md](../../character-chat/images.md).

## Trigger and cast

A scene renders every N turns (`SceneGenState.interval`, 0 = off), on a milestone or strong
reaction when the chat's `sceneAuto` is `"milestones"`, or manually.

**The cast is the roster filtered to `presence: "present"`** (`queueChatScene`). Presence is
the only location-like state chat tracks, so "in the same room" and "present" are the same
claim, and an away member is offstage and never drawn into the shot. Everyone present gets
their own identity reference — their own `chat_look` when the chat has minted one, else the
identity-pack service's canonical-portrait candidate — ordered **people before the place**, so
a short reference capacity drops the setting rather than a character.

A selfie stays single-subject whoever else is in the room, and a cast with nobody present falls
back to the filing subject rather than rendering an empty room. **Two present characters
sharing a name degrade to the first** (a `chat_scene` warn): names are not unique and every
downstream binding is by name, so the pair collapses into one and the cast clause never fires.
The Image Lab refuses this outright; a player-facing render draws one person rather than none.
A 1-on-1 chat is a roster of one.

## Step 1 — the scene composer

`sceneComposerModelId(chatComposerModel?)` is the composer's own `MODEL_DEFAULTS.sceneComposer`
seam, pinned to a snapshot and asked with reasoning off — a call configuration the composer A/B
measured rather than a slug anyone picked. It is backed by a curated list
(`lib/composer-models.ts`) with one retry on `composerFallbackModelId(primary)` when the primary
degrades, and the deterministic heuristic as the terminal fallback (`generateChecked`).

Its candidate subject pool is the **conversation's roster**; the scene and place come from the
chat's scene memory, never from prose. Each present character arrives with:

- a **species phrase** — the label only, for non-human casts, via `speciesLabelPhrase`, surfaced
  in both the composer line and the render's textual character detail (the authored generic
  `appearance` is not sent to image models);
- activity and posture; and
- an **occlusion-filtered** wardrobe (`resolveWardrobeVisibility`, the same rule as avatars:
  hidden layers omitted entirely, sheer-covered items at most a vague hint, coverage-less items
  kept), with visible garments phrased by description + appearance like the avatar. There is
  **no waist-up filter** here, so below-the-waist clothing reaches full-body scene shots.

The same phrasing feeds both the composer prompt and the final render prompt. The composer also
gets the scene setting and time-of-day from scene memory, for lighting, and the **last 2
exchanges' narration** as budgeted excerpts, newest largest.

It designates ONE focal character from the pool — or none, since an empty room composes a
**location-only POV shot**, a legitimate output rather than an error — plus which other roster
members are in frame.

The output is clamped server-side by `resolveScenePlan`: a focal name not in the roster is
replaced (`images.scene_composer.focal_clamped`), invented "others" are dropped
(`images.scene_composer.absent_character_dropped`), and every character's outfit phrase is
forced from wardrobe state, because prose lies. **Membership is the roster's, not the
composer's**: `resolveScenePlan` backfills any present character the composer omitted from
`others` (`images.scene_composer.present_character_added`, info). The composer picks the focal
and what each person is doing, never who exists — the render sends that person's reference
regardless, and a plan missing them asserts a person count contradicting its own reference
list.

### Which model plans the shot is selectable per conversation

`SCENE_COMPOSER_MODELS` (`lib/composer-models.ts`) is the curated set. An id earns its place by
being run through `scripts/eval/scene-images/composer-model-ab.ts`, the self-grading A/B that
asks every candidate the real question and grades its answer through this same
`resolveScenePlan`.

An admin picks one per chat from the conversation menu (`SceneComposerSelect` →
`GET`/`PATCH /api/admin/self/scene-composer/:chatId` → `character_chats.scene_composer_model`,
`""` ⇒ the curated default); the value is read by `loadChatComposerModel` and threaded
`queueChatScene` → `renderCharacterSceneImage` → `composeSceneSpec`.

It sits **outside** the scenario blob on purpose — it is operational configuration, so "another
take" never reverts it — the same placement as `agentReasoningProfile`, and the opposite of
`sceneModel`, which picks the IMAGE model that paints the shot rather than the text model that
plans it. The resolver is strict (an uncurated id coerces to the default with a warning, since
this value reaches OpenRouter on the deployment's key), and `composerFallbackModelId` guarantees
the ladder's two rungs are never the same model.

## Step 2 — the render

Image generation runs entirely on **Replicate** through the model registry
([../providers/README.md](../providers/README.md)).

Each present character anchors on their own identity reference: their fresh `chat_look` when
the chat has minted one, else the identity-pack service's candidate for their canonical
portrait ([../identity-packs.md](../identity-packs.md)). A blocked pack **refuses the whole
scene** rather than substituting another image, and a member with no portrait at all is
described textually.

**Two reference modes** (`SceneGenState.referenceMode`): **single** (default) sends ONE anchor;
**multi** feeds every member's anchor in roster order up to the model's reference cap to the
multi-reference rung, identity-locking each. Either way the other or overflow characters are
described from their own cut — the digest's facts, their wardrobe and coverage, and their
resolved action.

The prompt every rung sends is a **compiled prompt program** — the lane's only prompt path
([../character-prompts.md](../character-prompts.md)). The cast's committed cuts fold into one
multi-subject world digest, the operation contract states the job and how many people are in it,
and the bound endpoint's dialect words the result. The compiled positive text is both the row's
stored `prompt` and the intent's; the compiled exclusions ride the normalized
`controls.negativePrompt`, so they reach a provider only through the version's own probed field.

**The prompt budget belongs to the compile, and comes from the model.** Each rung compiles its
own prompt program, budgeted from the resolved model's declared prompt binding rather than a
fixed ceiling, and the fitter protects the mandatory floor: a squeeze trims optional detail, and
a rung that cannot express a required fact refuses before provider spend rather than sending a
prompt Vesper already knows is incomplete ([../prompt-programs.md](../prompt-programs.md)).

Two consequences are specific to a cast:

- **Reference labels come from the program's own reference plan, and the rung sends that plan.**
  Each rung offers its program the lane's list — people before the place, cut to the model's
  capacity — and sends exactly the list the program planned, in the program's order, so a
  numbered slot names the image the payload carries at that position by construction rather
  than by two lists happening to agree. Planning that would move a slot a numbering dialect
  names **refuses** (`image_prompt_program.references_renumbered`) rather than ship a plausible
  picture of the wrong composition — and each identity reference names the cast member it
  depicts, so an ensemble binds each face to its own person.
- **The person count is asserted from the committed cast**, through the operation contract's
  subject count: the claim that arms the single-subject guard on a solo shot and tells the
  anatomy guards how many bodies to defend on an ensemble one.

Wardrobe and exposure are claimed from each member's committed coverage readout rather than from
what the anchor image happens to show, so a shed garment cannot be repainted back onto a
fully-dressed reference avatar. Fitting is the bound model's own declared prompt budget, and it
may never drop the mandatory floor.

`scripts/image-reference-numbering.test.ts` fails the build if any module under
`server/images` authors a reference-slot label of its own (the census is empty and may never
grow), or if a `prompts-scene-*` module other than the composer's contract and the plan
resolver appears in that folder or is imported there.

## The attempt ladder

`renderSceneImage` builds a `SceneVisualReference[]` (the featured characters + location, with
each available avatar's image + the location image + provenance attached) plus a
`referenceBuffers` map (`imageId` → bytes), resolves the chat's stored pick through
`resolveImageProfileForTask("scene", …)`, and `routeSceneAttempts` orders **that one model's**
degradation ladder. Both edit rungs run the same model — the chat's pick — since the ladder is
one model's degradation path, not a hop between models.

The rung ids name reference tiers, not vendors:

1. **`multi_edit`** — multi-reference edit, mode `multi`, when ≥2 usable reference images exist
   *and the model accepts ≥2*.
2. **`edit`** — single-reference edit, when ≥1 anchor image exists.
3. **`generate`** — the bare-prompt rung, which runs **only when no reference image exists at
   all** (owner ruling 2026-07-29: it cannot honor a reference, so an edit failure fails the row
   visibly instead of silently painting a different-looking person).
4. **demo monogram.**

The caller's `mode` (`single` | `multi`) only prepends the multi rung; it never blocks a render —
`multi` degrades to the single-edit rung when fewer than two references are available, or the
model only takes one.

**Each rung compiles its own program**, because the rungs are genuinely different renders of one
scene: the multi-reference rung composes N faces, the single-reference rung edits one, and the
bare rung describes everybody from text with no reference at all. Each states its own reference
claims and its own operation kind — `instruction_edit` on the edit rungs,
`text_to_image_description` on the bare one — so an anchor-less render never carries an identity
lock, and each shape resolves its own binding row. `allowIntimate` rides the image refs'
`allowForIntimate`; for multi, every featured character ref must clear it. It decides two things
per rung: whether a staged arrangement travels, and whether the cast's exposed intimate anatomy
is stated ([scene-subjects.md](scene-subjects.md) §Subject body reveal).

Programs are pure and cheap, so the whole chain is compiled **before anything is reserved**, and
a non-demo rung that cannot produce one is **dropped from the chain** — whether its program
refused, its model and job shape resolved no active binding, or it was reached with no committed
cast cut. A rung that cannot be described honestly is a rung that cannot run, and handing off to
the next one is what the ladder is for, so a drop costs the render nothing until the drops run
out. `images.scene_render.rungs_dropped` (warn) names which rungs left the chain. The `demo` rung
is untouched by any of this: it paints a monogram and reads no prompt.

**An empty chain is a visible refusal.** An edit-only model with no usable reference routes no
rungs at all, and a chain whose every rung was dropped leaves none; either way the render fails
with `images.scene_render.no_attempt` and reserves nothing, rather than rendering from somewhere
else. Such a row stores an **empty** `prompt`: no rung would have sent one, and recording a
prompt nothing was going to ask for is the one thing a failed render must not do.

The executor walks the chain with a **reason-keyed retry** over `classifyImageFailure`
([README.md](README.md) §Failure classification): a transient failure retries once on the same
rung, a content rejection never retries and drops to the next rung, and a billing failure never
retries at all.

Every downgrade logs `images.scene_render.provider_fallback` (info, `{from,to,reason}`,
including the upstream error message); a chain where every rung failed transiently logs
`images.scene_render.service_outage` (warn). A chain where every rung failed marks the row
`failed` with the upstream cause — with a reference present there is deliberately no
text-to-image rung to degrade to.

A render failure's cause must not black-hole, so rather than relying on a caller to thread a
`DiagnosticSink`, `renderResolvedScene` tees the diagnostics into a `DiagnosticCollector` and
**drains it to the server log** (`logDiagnostics`, `images.scene_render` scope) on every render,
staying quiet on the success path. The chat look and place mints drain the same way
(`images.chat_look` / `images.chat_place`), since their production caller is a detached job with
no sink.

Failures mark the job and image row `failed` with the error; the conversation is never blocked
by image work.

## The scene model pick

The scene strip's per-chat model pick (`character_chat_state.scene_model`, owner request
2026-07-11) is a registry model **id**, filtered to `canEdit` and reference-only (owner ruling
2026-07-29), because a scene without the avatar reference defeats the point of a scene image.
The pick threads chat state → `queueChatScene`'s job payload → the render, so a scene renders on
the model the conversation chose at queue time; an id that no longer resolves degrades to the
scene default.

## Chat keying and the transcript

Every chat scene row carries `images.chat_id` (FK, **SET NULL on chat delete** — the asset
survives in the Gallery) and `anchor_message_id` (plain text, no FK — the assistant line the
scene illustrates, captured at **queue time**: the newest assistant line for a manual render,
the exchange's own reply for an auto render). A dangling anchor — a deleted or snipped message —
degrades to strip-only, never an error.

`GET /api/chats/:id/scene` lists **only** the conversation's own rows: sibling chats with the
same character never leak in, and un-chat-keyed rows surface solely in the Gallery. Each entry
carries its generation `prompt` for the dev-only lightbox prompt panel. The listing is
DB-backed, so an in-flight render survives page refreshes and resurfaces there when it
completes; the conversation page polls while a `chat_scene_image` job is live or a pending row
exists ([../../ui/conversation.md](../../ui/conversation.md) §Scene images), and ready anchored
scenes render inline in the transcript under their message.

An auto render at a big moment queues through the shared `queueChatScene`, deduped to one live
render per chat, fire-and-forget: a failed queue log-warns and the settled reply is never
touched. A scene keeps its queue-time anchor, so a reply later replaced by "another take" leaves
the moment illustrating the superseded beat.

Deleting a conversation scrubs **prompts per chat** for chat-keyed rows (sibling conversations
keep theirs); legacy null-`chatId` rows keep the character-wide scrub.

## Scene references

At render, the scene records what it features — the focal and other in-frame characters resolved
to their library `characterId`, the active location, and the identity anchor's avatar with
provenance — as **one row per reference** in the `image_references` table
(`recordImageReferences`), the authoritative, queryable record
([../../database/README.md](../../database/README.md)).

Columns: `kind` (`character` / `location`, with `style` / `pose` / `layout` reserved for
multi-reference providers), `entity_id` (library id; null for non-entity roles), `role`,
`source` (`generated` / `uploaded` / `composite` / `entity`; null = unknown), `image_id` (the
asset actually fed to a provider; null when textual-only), and `name`. FK-cascade on the scene
image, so every delete path drops the rows automatically.

The table supersedes `images.meta.references`. The contract split is `SceneVisualReference` (the
render-input superset) versus `SceneReference` (the Gallery DTO the table projects to). It is
**forward-only**: a scene rendered before the table existed carries no reference rows.

## The Gallery hub

`/gallery` · `GET /api/gallery` ([../../ui/README.md](../../ui/README.md)) is tabbed by
`images.kind`:

- **`?tab=scenes`** (default) lists every owner's **ready** character-chat scene in one
  keyset-ordered query (`entityKind:"character"` — owner-scoped character join, so a deleted
  character drops them; chat-keyed via `chat_id`, which deleting the conversation SET-NULLs, so
  the asset stays with its prompt scrubbed);
- **`?tab=portraits`** lists `portrait_variant` rows joined to their character; and
- **`?tab=entity`** lists `entity` art with the source location or item name resolved.

Every tab pages by the **keyset cursor** `?cursor=<createdAtMs>_<id>` plus `?limit` (default
100, cap 500; a garbage cursor degrades to page 1) with a client-side "Load more" button, and
carries the **`favorite`** flag (`images.favorite`; `PATCH /api/gallery/:id {favorite}` toggles
it, an optimistic heart on the tiles, a Favorites filter chip narrowing every tab). Scenes group
client-side by view mode — character or timeline — and filter by avatar chip, whose `character`
refs are sourced server-side from `image_references`, not `meta`.

Deletion — the hover ✕, the **Select**-mode multi-delete, and the filter-scoped **Delete all** —
runs `DELETE /api/gallery/:id` / `POST /api/gallery/delete {ids}` → `deleteOwnedImage(s)`,
guarded to the gallery's kinds (`GALLERY_IMAGE_KINDS`: scene · portrait_variant · entity, never
avatars, chat uploads, or look/place anchors). `clearEntityImagePointers` then nulls any soft
pointer at the deleted ids (a character's `avatar_image_id`, a location's or item's `image_id`)
so nothing dangles. Every gallery view *and* the conversation page's scene strip derive live
from the `images` table — there is no cached image id — so the image leaves every view at once.
