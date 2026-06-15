# API surface & streaming protocol

Route handlers in `src/app/api/`. Handlers are thin: resolve user → zod-validate input → call a `server/*` function → shape the response. Errors use the envelope `{ error: { code, message } }` with a correct HTTP status.

## Routes

### Library
```
GET/POST           /api/characters            list (search ?q, ?tag) / create (201)
GET/PATCH/DELETE   /api/characters/:id        GET returns { character, portraits }
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
```

Creates return 201 with the row. Deleting an entity referenced by a world or session is a 409 `in_use` (FK violation mapped, never a cascade).

### Worlds
```
GET/POST           /api/worlds                 list (?q: name/description ILIKE) / create (201; nested
                                               locations/loreChunks/cast/items materialize world_* rows)
GET/PATCH/DELETE   /api/worlds/:id             detail (incl. cast/locations/links/items/lore)
POST               /api/worlds/forge           prose prompt → AI world draft (not saved); section regen
                                               like character forge
POST               /api/worlds/from-draft      save a forge draft: cast stubs forged into characters
                                               (cap 3; failures degrade to tagged stubs), names resolved,
                                               then the standard create path ⇒ 201 { id, diagnostics };
                                               forge-rate-limited
POST               /api/worlds/:id/from-draft  save edits from the draft shape (same conversion; all four
                                               nested families full-replace) ⇒ 200 { id, diagnostics }
POST               /api/worlds/:id/duplicate   deep-copy world (+lore/cast/locations/items); sets
                                               duplicated_from_world_id (201, body { name? } optional)
POST               /api/worlds/:id/sessions    spawn a session: { title?, embodied? (default true),
                                               playerCharacterId? } ⇒ 201 { session, diagnostics }
```

World PATCH semantics: scalar fields merge; each nested array (`locations`, `loreChunks`, `cast`, `items`), when present, **fully replaces** that family. Replacing `locations` cascades away links and item placements, so map editors send locations + cast + items together. Deleting a world with sessions is a 409 `in_use`.

### Sessions & play
```
GET                /api/sessions               ?recent caps at 20 (default 100) · ?worldId filters
GET/DELETE         /api/sessions/:id           GET adds worldName; DELETE cascades all play state and
                                               removes the session's scene images (rows + files)
POST               /api/sessions/:id/restart   recovery runs first; 409 session_busy unless ready
GET                /api/sessions/:id/feed      turn_messages + dividers, paginated (?before=<turnNumber>)
GET                /api/sessions/:id/status    sidebar payload: participants+state, scene, clock
                                               (+ delta: latest turn's { minutes, cause }, null on
                                               old turns), wardrobe, containers, sceneGen
                                               (+ latestImageId and ready-image gallery), resolved
                                               narrator model (session.narrativeModel)
GET                /api/sessions/:id/relationships   relationship edges { id, fromParticipantId,
                                               toParticipantId, kind, stage } — stages only, raw
                                               affinity values never leave the server
GET                /api/sessions/:id/job       { status, jobType?, diagnostics? } for polling
POST               /api/sessions/:id/participants/:participantId/inner-note
                                               { text ≤2000 } — authorial interior note for an NPC
                                               (memory/feeling/belief, never dialogue) ⇒ 202 { jobId };
                                               queues a non-blocking inner_note job (rate-limited);
                                               400 player_participant when targeting the player
POST               /api/sessions/:id/participants/:participantId/clothing
                                               dev/admin only, non-production: { action: "wear"|"remove",
                                               itemInstanceId } flips a participant-held clothing item
                                               between worn and held inventory; 409 session_busy while
                                               a turn is processing
POST               /api/sessions/:id/turns     ⇒ SSE stream (below)
PATCH/DELETE       /api/sessions/:id/messages/:messageId      edit (→ reconcile job) / delete
                                               (an emptied turn is removed entirely)
POST               /api/sessions/:id/messages/:messageId/rerun ⇒ SSE stream; latest turn only
POST               /api/sessions/:id/scene     { action: "generate" | "regenerate" } ⇒ 202 { jobId, queued: true }
                                               (an in-flight scene job is reused: 200, queued: false) ·
                                               { action: "setInterval", interval: 0–100 }
GET                /api/sessions/:id/turns/:turnId/inspect     Turn Inspector: agent results, diagnostics,
                                               retrieval events (windowed by turn timestamps). Admin-only (403)
```

### Misc
```
GET                /api/images/:id/file        serve from data/ (ready rows only; immutable cache headers)
GET                /api/dev/me                 { user, users } — resolved identity + everyone switchable
POST               /api/dev/switch-user        { userId } → sets the dev cookie
```

## Turn streaming (SSE)

`POST /api/sessions/:id/turns` body: `{ input: string (≤8000), author: "player" | "director" | "companion" (default "player"), speakerParticipantId? }`.
Response: `text/event-stream`. Events, in order:

```
event: start    data: { "turnId": "…", "turnNumber": 12 }
event: chunk    data: { "segmentIndex": 0, "speaker": null | "Maya", "content": "delta text" }
event: status   data: { "phase": "processing" }            // narration done, agents running
event: done     data: { "turnId": "…" }
event: error    data: { "code": "…", "message": "…" }      // terminal
```

- `chunk.content` is a **delta** (append to the segment's accumulated text). Segments arrive in `segmentIndex` order; a new index closes the previous segment.
- A `blocked` condition (session busy) is a plain 409 JSON response, not a stream.
- Client: `src/lib/client/turn-stream.ts` parses with scoped buffering, calls `onStart/onChunk/onStatus/onDone/onError`, and invokes `onIncomplete` if the stream closes without `done`/`error`. An incomplete stream is a **client display problem only** — the server finishes the turn regardless (best-effort SSE writes, [resilience.md](resilience.md) §5); the UI's retry affordance just re-polls `/job` + `/feed` to pick up the finished turn.
- After `done`, the client polls `/job` (1.5s) until the session is `ready`, then refreshes `/status` (state sidebar) and `/feed`.

## Auth

Dev-cookie identity (same model as the old app): `vesper_user` cookie → `users` row; `getCurrentUser()` in `server/auth`. Every query is owner-scoped. Swapping in a real provider later means replacing `server/auth` only.

## Pagination & limits

`/feed` returns the latest 80 messages with a `before` cursor (the play screen virtualizes long sessions). List endpoints cap at 100 with `?q` search hitting name + tags + (when available) `search_embedding` similarity.
