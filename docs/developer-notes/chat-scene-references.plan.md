# Chat scene references — current-look and place anchors

Status: **next** (planned 2026-07-11, from the character-chat & schema engagement
review — seven-plan batch at the top of [roadmap.md](roadmap.md) §Next; effort
**M+**)

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

## Open questions

- Asset kind for looks: a new `chat_look` kind (per images.md "Adding a
  pipeline") vs `scene` + `meta.flavor: "look"`. The look must be chat-keyed
  and Gallery-hidden either way — pick at build.
- Cost control: look images render unprompted on outfit change — cap per chat
  (ring of N, delete the oldest) and/or only mint once the chat has rendered at
  least one scene?
- Should an `attributeOverlays` change alone (a haircut, no outfit change)
  refresh the look? v1: yes for free, by folding the overlay hash into
  `look_outfit_key`.

## Cross-links

- [chat-selfies.plan.md](chat-selfies.plan.md) — selfies anchor on the look
  image the moment it exists.
- [emotional-weather.plan.md](emotional-weather.plan.md) — feeling enriches
  `visualStateNote` on these renders; independent otherwise.
