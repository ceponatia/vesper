# API surface & streaming protocol

Route handlers in `src/app/api/`. Handlers are thin: resolve user → zod-validate input → call a `server/*` function → shape the response. Errors use the envelope `{ error: { code, message } }` with a correct HTTP status.

## Routes

### Library
```
GET/POST           /api/characters            list (search ?q, ?tag) / create (201)
GET/PATCH/DELETE   /api/characters/:id        GET returns { character, portraits, mine }
POST               /api/characters/forge      prose prompt → AI draft (not saved); { prompt, section?, draft? }
                                              regenerates one section against the supplied draft
POST               /api/characters/:id/avatar          { style: "realistic"|"stylized" } ⇒ 202 { jobId, characterId }
GET/POST           /api/characters/:id/portraits       GET lists all images for the character (avatar +
                                                       variants, newest first) as { portraits }; POST queues a
                                                       Venice variant { kind: pose|outfit|expression|setting,
                                                       instruction } ⇒ 202 { jobId, characterId }
GET/DELETE         /api/characters/:id/portraits/:imageId   (+ POST /promote → set as avatar; 409 not_ready
                                                            until the variant leaves pending)
GET/POST, GET/PATCH/DELETE        /api/locations, /api/locations/:id
GET/POST, GET/PATCH/DELETE        /api/items, /api/items/:id   (coverage ids validated against the
                                                               body-locations registry → 400 invalid_coverage)
GET/POST, GET/PATCH/DELETE        /api/social-cards, /api/social-cards/:id   (reusable reaction-card
                                                               library; + POST /:id/clone, owner-or-public)
```

Creates return 201 with the row. Deleting an entity still referenced by another row is a 409 `in_use` (FK violation mapped, never a cascade).

The four shareable detail GETs (`characters`/`locations`/`items`/`social-cards`) carry a `mine` flag and shape the entity to it: the owner gets the full row, a **foreign viewer of a public row gets the allow-listed public representation** — no `ownerId`, no embedding/authoring internals, portraits reduced to `{ id, kind, entityKind, entityId, createdAt }`. See [auth.md](auth.md) §"Public" is a representation, not the row.

The character-chat lane's HTTP surface (`/api/chats/*` — the transcript GET, the send/rerun SSE, scene/relationship/time-skip routes, and its diagnostic codes) is documented in [character-chat/api.md](character-chat/api.md). The successor engine's routes live under `/api/chats` and `/api/admin/*` (see [contracts/simulation.md](contracts/simulation.md)).

### Misc
```
GET                /api/gallery                owner's ready scene images (chat scenes + entity/portrait art)
                                               (scenes[]: id, references[], prompt, createdAt)
DELETE             /api/gallery/:id            hard-delete one owned scene image (row + file); 404 if not owned / not a scene
GET                /api/images/:id/file        serve from data/ (ready rows only; owner OR same-owner public-entity image; immutable cache)
POST               /api/characters/:id/clone   clone a public/own entity → owned private copy (also locations, items, social-cards)
GET                /api/auth/*                 Better Auth surface (sign-in/up/out, OAuth, magic-link, get-session)
GET                /api/auth-config            { providers[], emailPassword, magicLink } — enabled methods for the sign-in UI
GET                /api/dev/me                 { user } — resolved identity (dev-only; 404 in production)
POST               /api/dev/impersonate        { userId } → mints a real signed session (dev-only; 404 in production)
```

## SSE streaming

The one streaming surface is the character-chat exchange — `POST /api/chats/:chatId/messages` (and the rerun / "another take" variants) stream `text/event-stream`. The event protocol, its buffering client, and the poll-to-settle flow are documented in [character-chat/api.md](character-chat/api.md) and [character-chat/pipeline.md](character-chat/pipeline.md). Best-effort SSE writes mean a dropped stream is a client display problem only — the server finishes the exchange regardless ([resilience.md](resilience.md)).

## Auth

Real accounts via [Better Auth](https://better-auth.com) ([auth.md](auth.md)), self-hosted in our Postgres. The `/api/auth/*` surface is owned by the library (signed, httpOnly, `secure` session cookies); our handlers only **read** the session. `getCurrentUser()` (`server/auth`) resolves it or throws `Unauthenticated`, which `withUser` maps to a **401** — there is no auto-minted default user. A genuine resolution failure (DB down) stays a **500 `auth_unavailable`**.

**Authorization** is one seam ([auth.md](auth.md)): every **write** is owner-strict (`ownerId = me`; a non-owner write 404s, never confirming the row). **Reads** on the browse/preview/copy path widen to **owner-or-public** via `findViewable` — characters/locations/items/social-cards carry a `visibility` (`private` default | `public`); personas and chats are always private. A public entity is **copyable** (`POST /:kind/:id/clone` → an owned, private copy with `clonedFromId` provenance and self-contained images), never live-referenced.

**Dev/QA:** `POST /api/dev/impersonate { userId }` mints a real signed session (the old `vesper_user` raw-id cookie is gone). Dev routes 404 in production. See [CLAUDE.md](../CLAUDE.md) for the seeded credential.

## Pagination & limits

The chat transcript GET (`/api/chats/:chatId`) returns the newest 100 rows plus `hasMore`/`nextBefore`, where `?before=<messageId>` keysets the next older page in `(createdAt, id)` order (a total order, so paging is stable across same-ms inserts; an unknown cursor 400s). List endpoints cap at 100 with `?q` search hitting name + tags + (when available) `search_embedding` similarity.
