# Chat image input — player-sent photos the character sees

Status: **shipped — 2026-07-11** (planned, ruled, and built the same day — the
third of the seven-plan engagement batch. All three slices landed: the upload
route + composer attach/tray (client canvas downscale → `chat_upload` assets,
no migration — the kind enum is type-level), the batched vision read
(`engine/chat-vision.ts`, persisted on message meta, degraded reads never
persisted so a retake retries) + the fenced tail block + static rule 17, and
the full delete lifecycle (message snip / rerun successors / deleteChat).
Photo-only sends are legitimate. Slice-3's "inspector shows the description"
lands for free — the prompt preview renders the tail block. Deferred as
planned: photos inside the `*Name: …*` comms grammar (the selfies work owns
image-message presentation); paste-to-attach was dropped from v1 (file pick +
the client downscale covers the flow — add on request).)

Chat is text-only inbound while the vision seam already exists
([images.md](../../character-chat/images.md) §Image understanding: `generateChecked` takes an
`images` option, `visionModelId()` is the code default, first consumer is the
portrait→attributes pass). A character who genuinely reacts to a photo the
player shows her — and remembers it — is a large realism jump for one bounded
vision call.

## Design

- **Upload**: `POST /api/chats/:chatId/attachments` — reuse the avatar-upload
  machinery (`server/images/upload.ts`: decode/pixel caps from the
  security-hardening pass, sharp re-fit to a bounded max dimension, EXIF
  rotate, row-before-file) with a new `images.kind: "chat_upload"`, `chat_id`
  set, `meta.source: "upload"`. Per-route body-cap raise + the heavy-write rate
  limiter. One image per message in v1.
- **Message**: the user line carries `meta.attachmentImageId`; the transcript
  renders an image bubble (existing immutable `GET /api/images/:id/file`).
- **Perception**: in `submitChatMessage`, before prompt build, a vision pass
  describes the image (2–4 factual sentences + salient objects/people, bounded
  length), injected inside the player-input perception partition as **seen**
  channel content: `Attached photo (what you see): …`. Failure degrades to "an
  image you can't quite make out" + `chat_vision.describe_failed` — never a
  failed exchange. Demo mode: the degraded default.
- **Memory**: the archivist sees the description in its window and files
  ordinary `perceived` facts — no new field. The description also persists on
  the message (`meta.visionDescription`) so regenerate/rerun re-serve it
  without a second vision spend.
- **Lifecycle**: unlike scenes, `chat_upload` assets are player content —
  message snip, Clear Chat, and `deleteChat` **hard-delete** them (extend the
  delete paths; the `image_sweep` reconciles stragglers). They never appear in
  the Gallery (it is kind-filtered to scenes already).
- **Safety**: uploads are input-only — never an identity anchor or edit
  reference. The parked uploaded-avatar intimate guard
  ([deferred.plan.md](../deferred.plan.md), scene-images.spec §3) remains the
  launch blocker for any future reference use of user uploads.

## Slices

1. Upload route + composer attach (file pick + paste-to-attach) + inline
   render + delete paths + caps tests.
2. Vision pass + prompt injection + `meta.visionDescription` + degradation
   tests (fallback line **and** diagnostic code).
3. Int test: fact extraction from a described photo; the inspector's prompt
   preview shows the injected description.

## Rulings (owner, 2026-07-11)

- **Add one `CHAT_RULES` rule** (static prefix): react in character to what the
  photo shows — never inventory it back or call it an "image/attachment" — with
  the per-turn injection carrying the matching wording.
- **Multi-image from the start**: up to 4 attachments per message. Design
  consequence: ONE batched vision call describes all of a message's photos
  (ordered `descriptions[]`), not a call per image; the comms-grammar photo
  phrasing still defers to the selfies work.

## Cross-links

- [chat-selfies.plan.md](chat-selfies.plan.md) — the two directions of
  photo-messaging should share the inline image-message rendering.
