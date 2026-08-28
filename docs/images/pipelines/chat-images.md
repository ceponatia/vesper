# Chat image lanes

The three chat-scoped asset kinds beside the scene itself: the character's selfies, the cached
look and place reference anchors, and the player's uploaded photos. This page owns their
**render mechanics**; the lane's triggers, gates, cooldowns and lifecycle are
[../../character-chat/images.md](../../character-chat/images.md).

## Selfies

`meta.flavor: "selfie"` on kind `scene`: the chat scene pipeline
([scene-images.md](scene-images.md)) with `SELFIE_FRAMING` swapped in for `SCENE_POV_RULE` — the
exact inverse of the POV rule, the subject's own phone camera, arm's-length or mirror, aware of
the lens — via the `framing` option on `buildSceneRenderPrompt` / `renderResolvedScene`. A
selfie's cast is trimmed to the sender, and its framing ends "No one else in frame".

Selfies are **always the identity-locked reference route** (owner ruling): the per-chat
`scene_model` text-to-image pick is ignored. They skip the shot line, staging, and identity-lock
adaptation entirely ([scene-framing.md](scene-framing.md)).

A **retry-once failure policy** replaces the ladder's silent degrade: classify the first failure
(`classifyImageFailure`), retry once — a content rejection with a sanitized plan, exposure and
intimate phrasing stripped, including `staging`; a transient failure as-is — drop the failed
first row, and let a second failure stand as a debuggable `failed` row. Diagnostic:
`images.selfie.retry` (info).

## The look anchor

`kind: "chat_look"` is an identity-locked reference edit wearing the archivist-tracked outfit,
its identity reference(s) sourced from the identity-pack service
([../identity-packs.md](../identity-packs.md)).

Its prompt is **segments over the conversation's committed visual digest**
(`buildChatLookSegments`, `server/images/chat-look-segments.ts`) under the look policy: **age
omitted** (the narrative/visual age split, [avatars.md](avatars.md) §Apparent age), waist-up
frame, intimate never, and **exposure omitted**, because the operation line already states the
coverage being requested.

Like its sibling edit lane ([portrait-variants.md](portrait-variants.md)) the mint carries no
route-owned attribute sheet: it gains the digest's body-shape anchors — horns, wings, tail —
while hair, eye and skin color stay unstated and come off the reference photograph.

**Current state is deliberately suppressed** — active conditions, body-surface wetness, garment
condition. The anchor is cached under `chatLookKey`, which cannot see transient body state, so a
"skin damp" clause would bake a wet character into an asset whose key never moves again.

A digest the mint cannot build refuses **before reserving a row**, so an ineligible chat
accumulates no failed rows and simply retries on the next outfit or appearance change; a missing
participant row warns and the mint still happens on the route-owned segments alone.

`chatLookKey` is outfit + exposed + appearance overlays, keep-latest **per character** — the
loader, the freshness check and the purge all scope on `entityId`, because a chat-wide read
hands one roster member's look to another and a chat-wide purge makes two cast members evict
each other's anchor on every mint. Scenes and selfies anchor on a fresh look instead of the
always-dressed avatar, so render prompts stop fighting the reference's clothes.

## The place anchor

`kind: "chat_place"` is a text-to-image establishing shot of the current scene-memory place,
minted lazily from its sketch (`chat_place_image`, CAS onto `ScenePlace.imageId`). Once present,
chat scenes render **multi-reference** (look or avatar, plus place) through the same
multi-reference rung the scene ladder already carries.

Both anchor kinds are chat-keyed, Gallery-hidden, and hard-deleted with the conversation
(`deleteChatAssets`).

## Player photo attachments

`kind: "chat_upload"`: player photos uploaded via `POST /api/chats/:chatId/attachments`
(`uploadChatAttachment` — the same decode-bomb guards as the avatar upload, fit inside 1280px,
row-before-file, chat-keyed).

They are **input-only**: never an identity anchor or edit reference, and never in the Gallery.
Unlike scenes they are **hard-deleted** with their message or conversation (`deleteChatUploads`;
`deleteChat` removes them before the FK would SET-NULL them into limbo).

At exchange time ONE batched vision call (`engine/chat-vision.ts`, `visionModelId()`) describes
every photo on the message; the reads persist on the message meta, so regenerate never
re-spends, and reach the narrator as a fenced seen-channel tail block.
