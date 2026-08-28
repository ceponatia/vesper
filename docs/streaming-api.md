# API surface & streaming protocol

Route handlers in `apps/web/src/app/api/`. Handlers are thin: resolve user → zod-validate input → call a `server/*` function → shape the response. Errors use the envelope `{ error: { code, message } }` with a correct HTTP status.

## Routes

### Library
```
GET/POST           /api/characters            list (search ?q, ?tag) / create (201)
GET/PATCH/DELETE   /api/characters/:id        GET returns { character, portraits, mine }
POST               /api/characters/forge      prose prompt → AI draft (not saved); { prompt, section?, draft? }
                                              regenerates one section against the supplied draft
POST               /api/characters/:id/avatar          { style: "realistic"|"stylized", modelId? } ⇒ 202 { jobId, characterId }
GET/POST           /api/characters/:id/portraits       GET lists all images for the character (avatar +
                                                       variants, newest first) as { portraits, rendering };
                                                       POST queues a portrait variant — a reference edit via
                                                       the image-model registry
                                                       (images/pipelines/portrait-variants.md) —
                                                       { kind: pose|outfit|expression|setting,
                                                       instruction, modelId? } ⇒ 202 { jobId, characterId }
GET/DELETE         /api/characters/:id/portraits/:imageId   (+ POST /promote → set as avatar; 409 not_ready
                                                            until the variant leaves pending)
GET/POST, GET/PATCH/DELETE        /api/locations, /api/locations/:id
GET/POST, GET/PATCH/DELETE        /api/items, /api/items/:id   (coverage ids validated against the
                                                               body-locations registry → 400 invalid_coverage)
GET/POST, GET/PATCH/DELETE        /api/social-cards, /api/social-cards/:id   (reusable reaction-card
                                                               library; + POST /:id/clone, owner-or-public)
```

Creates return 201 with the row. Deleting an entity still referenced by another row is a 409 `in_use` (FK violation mapped, never a cascade).

The four shareable detail GETs (`characters`/`locations`/`items`/`social-cards`) carry a `mine` flag and shape the entity to it: the owner gets the full row, a **foreign viewer of a public row gets the allow-listed public representation** — no `ownerId`, no embedding/authoring internals, portraits reduced to `{ id, kind, entityKind, entityId, createdAt }`. See [auth/visibility.md](auth/visibility.md).

The character-chat lane's HTTP surface (`/api/chats/*` — the transcript GET, the send/rerun SSE, scene/relationship/time-skip routes, and its diagnostic codes) is documented in [character-chat/api.md](character-chat/api.md). The successor engine's routes live under `/api/chats` and `/api/admin/*` (see [engine/boundaries.md](engine/boundaries.md)).

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

Real accounts via [Better Auth](https://better-auth.com) ([auth/README.md](auth/README.md)), self-hosted in our Postgres. The `/api/auth/*` surface is owned by the library (signed, httpOnly, `secure` session cookies); our handlers only **read** the session. `getCurrentUser()` (`server/auth`) resolves it or throws `Unauthenticated`, which `withUser` maps to a **401** — there is no auto-minted default user. A genuine resolution failure (DB down) stays a **500 `auth_unavailable`**.

**Authorization** is one seam ([auth/visibility.md](auth/visibility.md)): every **write** is owner-strict (`ownerId = me`; a non-owner write 404s, never confirming the row). **Reads** on the browse/preview/copy path widen to **owner-or-public** via `findViewable` — characters/locations/items/social-cards carry a `visibility` (`private` default | `public`); personas and chats are always private. A public entity is **copyable** (`POST /:kind/:id/clone` → an owned, private copy with `clonedFromId` provenance and self-contained images), never live-referenced.

**Dev/QA:** `POST /api/dev/impersonate { userId }` mints a real signed session (the old `vesper_user` raw-id cookie is gone). Dev routes 404 in production. See [CLAUDE.md](../CLAUDE.md) for the seeded credential.

## Pagination & limits

The chat transcript GET (`/api/chats/:chatId`) returns the newest 100 rows plus `hasMore`/`nextBefore`, where `?before=<messageId>` keysets the next older page in `(createdAt, id)` order (a total order, so paging is stable across same-ms inserts; an unknown cursor 400s). List endpoints cap at 100 with `?q` search hitting name + tags + (when available) `search_embedding` similarity.

## Rate limits & cost controls

Two mechanisms, split by what losing them would cost. **Burst limits** are in-process sliding windows — seconds-scale, so a restart forgetting them is harmless. **Cost controls** are durable in Postgres, because an in-memory daily budget is cleared by crash-looping the process, which is exactly what an abuser would do.

- **Per-IP, before authentication.** `withRoute` — which every route reaches, `withUser` included — applies a per-IP window ahead of session resolution, so an unauthenticated flood never touches the database. The client address resolves `fly-client-ip` → `x-real-ip` → leftmost `x-forwarded-for`; an unresolvable one falls into a single shared bucket rather than a free pass, so stripping headers costs the caller their own isolation and buys no evasion. `/api/auth/*` gets a far tighter window than the app default.
- **Per-user, by named policy.** `withUser(handler, { limit: "chat" })` declares the policy; **the name is the bucket**, so every image route shares `image_generate` rather than owning a private window — the cost being bounded is "renders this account paid for", not "renders through this URL". Tiers run `read` (most generous) down through `write`, `chat`, `clone`, `upload`, `image_generate`, `forge`, `embed`, `regenerate`, to `heavy_write`. Every provider- or storage-backed lane is strictly stricter than `read`; a test pins that.
- **Daily budgets** (`usage_counters`, keyed by owner + kind + UTC day) bound text, image, embedding, and upload-byte spend per account. The check-and-increment is one `INSERT … ON CONFLICT … WHERE` statement, so parallel turns cannot both read "just under" and both proceed, and a *refused* call never inflates the counter.
- **Storage quota** is `SUM(images.bytes)` per owner over user-visible kinds — the `HIDDEN_IMAGE_KINDS` set ([images/asset-registry.md](images/asset-registry.md)) is excluded, since the user can neither see nor delete those; admission agrees, so a render whose declared `outputKind` is hidden skips the storage reservation in `imageRenderRejection` rather than refusing an at-quota account. Derived, never a counter, so the several delete paths reclaim space for free and no decrement can be forgotten.
- **Concurrent jobs** are capped per user by a conditional insert in `claimJobSlot`, enforced by the database rather than a read-then-write race. Only non-stale rows count, so a job orphaned by a crash frees its slot instead of holding it forever.
- **Backpressure** sheds *unstarted* expensive work with **503 + `Retry-After`** when a provider lane's circuit is tripped (fed by settled job outcomes, or by what a job reports through `startJob`'s `JobRunContext` when it settles its own provider failures instead of throwing) or the queue is saturated — never a read, never an in-flight turn.

A denied request is **429** with `Retry-After` and `RateLimit-Limit`/`-Remaining`/`-Reset` headers, plus a `retry` object in the error envelope (`retryAfterSeconds`, `resetAt`, `limit`, `remaining`, `scope`) so a client can tell "slow down for a minute" from "you are done until midnight UTC". Denials are logged through one `recordAbuseSignal` seam whose payload has **no free-form content field** — there is no member a prompt could travel in — and which persists an `events` row only on sustained abuse, so rejections cannot themselves become a write amplifier. Addresses are stored salted-hashed, never raw. Budget and quota accounting **degrade open** on a database failure ([resilience.md](resilience.md)): these are backstops behind limits already enforced in memory, and failing every turn closed because an accounting table blipped trades a bounded cost risk for a total outage.
