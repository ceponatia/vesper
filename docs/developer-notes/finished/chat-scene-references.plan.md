# Chat scene references — current-look and place anchors

Status: **shipped — 2026-07-11** (planned, ruled, and built the same day — the
fifth of the seven-plan engagement batch. All three slices landed: the
`chat_look`/`chat_place` kinds + `chatLookKey`/renders (`images/chat-look.ts`),
the two detached jobs (enqueues split into `chat-reference-enqueue.ts` to keep
the finalizer↔handler import acyclic; the finalizer fires the look mint on
outfit/appearance changes, `queueChatScene` fires the place mint lazily), and
consumption — scenes/selfies anchor on a fresh look over the avatar, and chat
scenes go **multi-reference** (look + place) through the previously-unused
`venice_multi_edit` rung. `ScenePlace.imageId` rides the scene-memory jsonb
(no migration anywhere — both kinds and both job types are type-level enums).
Rulings + the images-table-as-cache refinement recorded above; provenance rows
(`image_references`) come free via `renderResolvedScene`.)

Chat scenes anchor on the canonical avatar — always wearing the default outfit —
so once the fiction has re-dressed or undressed the character, every render must
argue the edit model out of repainting the reference's clothing ("depict only
the clothing described… add no garment that is not listed" is fighting the
picture we handed it). And setting continuity rides a text sketch alone: the
multi-edit rung (`venice_multi_edit` via `routeSceneProviders`) is built and
used by sessions (avatar + location image), but the chat lane has no second
reference image to feed it.

## Design

1. **Current-look reference.** When the archivist records an `outfit` change
   (or on the first render with a non-default outfit), enqueue a detached
   `chat_look_image` job (the `chat_scene_sketch` shape: optimistic CAS, never
   the exchange lock, one live per chat): an identity-locked single-reference
   edit from the canonical avatar with the outfit phrase +
   `PORTRAIT_IDENTITY_LOCK`-style wording, waist-up. Cache on chat state:
   `look_image_id` + `look_outfit_key` (hash of the outfit text + the
   appearance-relevant `attributeOverlays`) — migration. Scene and selfie
   renders anchor on the look image while the key matches; stale or absent ⇒
   the canonical avatar (today's behavior). A regenerate rollback restoring an
   older outfit just mismatches the key and falls back / re-fires — harmless.
2. **Place images.** `ScenePlace` gains an optional `imageId`
   (schema-in-jsonb on `scene_memory`, `parseOr`-guarded — no migration): once
   the sketch agent has written a place's `sketch`, a second detached job
   (`chat_place_image`) renders it text-to-image (the entity-image shape: empty
   of people, interior/exterior inferred from the sketch, the shared scene
   default model) and CASes the id on. Lazily and only for the **current**
   place — the first scene render in a place queues it.
3. **Threading.** `queueChatScene` → the chat render passes mode `multi` with
   `[look-or-avatar, placeImage]` when both exist; `routeSceneProviders`
   already degrades to the single ladder below two references. The per-chat
   `scene_model` t2i hot-swap keeps dropping references entirely (unchanged).
   Look/place land as `image_references` rows for provenance.

## Slices

1. Look job + state cache + anchor swap + fallback tests (missing look, stale
   key, rollback).
2. Place-image job + jsonb field + lazy queue + sweep behavior.
3. Multi-edit threading + provenance rows + a diagnostics assert
   (`provider_fallback` fires when the place image is absent).

## Rulings (owner, 2026-07-11)

- **New `chat_look` kind** (Gallery-hidden for free, never in the scene strip,
  hard-deleted with the conversation). Place images get the sibling
  `chat_place` kind for the same reasons.
- **Mint on outfit change, image-active chats only**: the look job fires when
  the archivist records an outfit/appearance change, but only once the chat has
  ever rendered a scene/selfie — text-only chats never pay. Only the LATEST
  look is kept; the prior deletes on replacement.
- **Overlay refresh: yes** — the look key hashes outfit + exposed flag +
  appearance-relevant `attributeOverlays`, so a haircut invalidates the cached
  look like a change of clothes.

Design refinement while building: the look cache lives on the **images table
itself** (`meta.lookKey` on the latest ready `chat_look` row), not on chat-state
columns — no migration, and regenerate rollback can't desync a cache pointer
from the asset it names; a stale key simply falls back to the avatar.

## Cross-links

- [chat-selfies.plan.md](chat-selfies.plan.md) — selfies anchor on the look
  image the moment it exists.
- [emotional-weather.plan.md](emotional-weather.plan.md) — feeling enriches
  `visualStateNote` on these renders; independent otherwise.
