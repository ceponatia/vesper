# Images in chat

Everything visual the lane exchanges: photos the player attaches, selfies the
character sends back, and the cached reference anchors renders are built from.
The render pipeline itself lives in [images.md](../images.md).

## Player photos (image input)

The player can attach up to **4 photos per message** (owner ruling 2026-07-11 —
multi-image from the start) and the character genuinely sees them
([developer-notes/chat-image-input.plan.md](../developer-notes/finished/chat-image-input.plan.md)):

- **Upload** (`POST /api/chats/:chatId/attachments`, one photo per call): the composer
  downscales client-side (canvas, ≤1600px → JPEG), the server re-decodes with the
  avatar-upload bomb guards and fits inside 1280px as a `kind: "chat_upload"` asset —
  chat-keyed, Gallery-hidden, **input-only** (never an identity anchor or edit
  reference; the parked uploaded-avatar guard stays the launch blocker for that).
- **Send**: the exchange body carries `attachmentIds`; `claimChatAttachments` keeps
  only this chat's ready uploads (foreign ids drop), stamps `anchor_message_id`, and
  the ids ride the user line's `meta.attachments`. A **photo-only send** (no text) is
  legitimate — showing something IS the message.
- **Vision** (`engine/chat-vision.ts`): ONE batched call (`visionModelId()`) describes
  all of a message's photos in order — 2–4 factual sentences each — persisted onto the
  message meta so regenerate/rerun never re-spend (a **degraded** read is deliberately
  NOT persisted, so a retake retries it). Failure/demo degrades every photo to *"a
  photo you can't quite make out"* + `chat_vision.describe_failed`, never a failed
  exchange. The read runs pre-reply (tight 20s cap).
- **Prompt**: the descriptions render as a fenced "Attached photos (what you see)"
  tail block — seen-channel content under the perception partition — governed by the
  static **rule 16** (owner ruling): react in character to what the photo shows, never
  inventory it back, never call it an "image"/"attachment". The pulse + archivist read
  the same descriptions appended to the player's turn (clearly labeled, never
  persisted), so a shown photo can be classified and remembered as ordinary
  `perceived` facts.
- **Lifecycle**: attachments are player content and hard-delete with their message —
  the message DELETE route, rerun's successor snip, and `deleteChat` (which removes
  every `chat_upload` BEFORE the FK would SET-NULL them into limbo; never-sent
  orphans go with the conversation too). Scenes keep their SET-NULL Gallery survival;
  uploads never appear there (kind-filtered).


## Selfies (character-sent photo messages)

The character can send photos back
([developer-notes/chat-selfies.plan.md](../developer-notes/finished/chat-selfies.plan.md), owner
rulings 2026-07-11):

- **Three triggers, one queue decision.** A player **request** (`detectSelfieRequest`,
  regex — any register: handing a photo over face-to-face is the player's call), an
  unprompted **offer** — gated **apart-only** (ruled: a selfie simulates texting, so
  the comms register — a `*Name: …*` span in the player's message or the last reply —
  is the deterministic "not in the same place" signal), warm-or-better regard, and a
  ~15-exchange cooldown (`selfie_history` ring, migration 0034, rollback-safe) —
  or the **opener** arm (chat-initiative slice 5): a warm initiative opener may
  attach the "thinking of you" photo (`chatSelfieOpenerEligible` — warm +
  cooldown; no comms-span requirement since a reopen has no fresh exchange to
  read, so the license line is register-CONDITIONAL — "if your opening lands as
  a text" — and the fiction enforces apartness: an in-scene opener never
  "sends", so nothing queues). Each arms a one-turn tail **license**
  (`chatSelfieLine` — a request makes declining first-class; an offer is
  "entirely optional, never forced"). The render queues only when the **pulse**
  read the reply as actually sending one (`sentPhoto`) AND a gate armed it — a
  hallucinated "sending you a pic" on an unarmed turn stays fiction, and a
  decline stays a decline. On an armed opener the normally-skipped pulse runs
  **opener-scoped** (`applyOpenerPulse` — folds ONLY `sentPhoto` + the mindNote
  refresh; no regard/meter/feeling moves, since there is no player act to react
  to — a "neutral" proposal must not clear a standing bruise). An opener send
  records an `offer` ring entry (same cooldown).
- **Render** (`flavor: "selfie"` through `queueChatScene` →
  `renderCharacterSceneImage`): ALWAYS the identity-locked reference route (ruled —
  the scene strip's t2i pick is ignored), with `SELFIE_FRAMING` replacing the
  player-POV rule (the exact inverse: her own phone camera, arm's-length or mirror,
  subject aware of the lens). Same one-live-render-per-chat dedupe as scenes;
  `meta.flavor: "selfie"` rides the asset so lifecycle is unchanged.
- **Retry-once failure policy (ruled).** A failed first attempt classifies WHY
  (`classifyImageFailure`) and retries once — a content rejection retries with a
  **sanitized plan** (exposure + intimate phrasing stripped, intimate route off), a
  transient failure retries as-is; the failed first row is dropped so one tile
  shows. A second failure stays a `failed` row rendered in the transcript as a
  **"Failed" placeholder** ("the photo never arrived"); enlarging it shows the sent
  prompt (the admin lightbox panel) for debugging. `images.selfie.retry` (info)
  records the retry in the drained scene diagnostics.
- **Display**: an anchored image message with the SMS-adjacent treatment (rounded,
  accent-bordered) in the inline moments row; also in the scene strip and Gallery.


## Scene reference anchors (current look + place images)

Chat renders used to anchor on the canonical avatar — always in the default outfit —
so every scene argued the edit model out of repainting the reference's clothes, and
settings rode a text sketch alone
([developer-notes/chat-scene-references.plan.md](../developer-notes/finished/chat-scene-references.plan.md),
owner rulings 2026-07-11):

- **Current look** (`kind: "chat_look"`): an outfit-true, identity-locked variant of
  the avatar, minted by a detached `chat_look_image` job when the archivist records
  an outfit **or appearance** change (ruled: `attributeOverlays` invalidate like a
  change of clothes) — **image-active chats only** (ruled: a chat that never rendered
  pays nothing), keep-latest-only (the prior look deletes on replacement). The cache
  pointer is the images table itself (`meta.lookKey` on the newest ready row =
  `chatLookKey(outfit, exposed, overlays)`), so a regenerate rollback can't desync
  pointer from asset — a stale key just falls back to the avatar. Scenes AND selfies
  anchor on it when fresh.
- **Place images** (`kind: "chat_place"`): the current scene-memory place's
  establishing shot, minted lazily by `chat_place_image` from its agent-written
  sketch on the **first render there** (`queueChatScene` enqueues; that render still
  ships without it), CAS-written onto `ScenePlace.imageId` exactly like the sketch.
  Once present, chat scenes render **multi-reference** (look/avatar + place);
  selfies stay single-reference (the subject is the shot).
- Both kinds are chat-keyed, Gallery-hidden, hard-deleted with the conversation
  (`deleteChatAssets`), and self-healing: any lost race, failed render (row keeps
  `meta.error`), or missing file simply re-fires on the next trigger.

