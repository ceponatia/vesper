# Images in chat

Everything visual the lane exchanges: photos the player attaches, selfies the
character sends back, and the cached reference anchors renders are built from. This page
owns the lane's **triggers, gates, cooldowns and lifecycle**; the render mechanics behind
each kind — framing rules, reference routing, prompt programs, retry classification — are
owned by [images/pipelines/](../images/pipelines/README.md).

## Pipeline scope

Character chat and the successor/simulation pipeline are separate live pipelines; character
chat is not a "legacy" system. The persisted authority value for a character-chat-routed
conversation is `legacy_chat`, but documentation uses the pipeline's actual name.

A successor-routed conversation gets its primary character's wardrobe from
simulation-world material truth, while this image pipeline resolves wardrobe from
character-chat state plus the chat garment store. While the successor side exposes no
structured visual wardrobe projection with coverage/presentation data, those sources must
not be mixed: `POST /api/chats/:chatId/scene` refuses successor-routed chats with
`scene_visual_authority_unavailable`. Existing scene rows remain readable. This is a
fail-closed compatibility boundary, not a statement that successor images should use the
character-chat wardrobe as a fallback; doing that could make the narrator describe one
outfit while the image model paints another.

## Player photos (image input)

The player can attach up to **4 photos per message** (owner ruling 2026-07-11)
and the character genuinely sees them:

- **Upload** (`POST /api/chats/:chatId/attachments`, one photo per call): the composer
  downscales client-side (canvas, ≤1600px → JPEG), the server re-decodes with the
  avatar-upload bomb guards and fits inside 1280px as a `kind: "chat_upload"` asset —
  chat-keyed, Gallery-hidden, **input-only**: never an identity anchor or edit
  reference.
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

The character can send photos back (owner rulings 2026-07-11):

- **Three triggers, one queue decision.** A player **request** (`detectSelfieRequest`,
  regex — any register: handing a photo over face-to-face is the player's call), an
  unprompted **offer** — gated **apart-only** (ruled: a selfie simulates texting, so
  the comms register — a `*Name: …*` span in the player's message or the last reply —
  is the deterministic "not in the same place" signal), warm-or-better regard, and a
  ~15-exchange cooldown (`selfie_history` ring, migration 0034, rollback-safe) —
  or the **opener** arm: a warm initiative opener may
  attach the "thinking of you" photo (`chatSelfieOpenerEligible` — warm +
  cooldown; no comms-span requirement since a reopen has no fresh exchange to
  read, so the license line is register-CONDITIONAL — "if your opening lands as
  a text" — and the fiction enforces apartness: an in-scene opener never
  "sends", so nothing queues). Each arms a one-turn tail **license**
  (`chatSelfieLine` — a request makes declining first-class; an offer is
  "entirely optional, never forced").
- **The pulse decides.** The render queues only when the pulse
  read the reply as actually sending one (`sentPhoto`) AND a gate armed it — a
  hallucinated "sending you a pic" on an unarmed turn stays fiction, and a
  decline stays a decline. On an armed opener the normally-skipped pulse runs
  **opener-scoped** (`applyOpenerPulse` — folds ONLY `sentPhoto` + the mindNote
  refresh; no regard/meter/feeling moves, since there is no player act to react
  to — a "neutral" proposal must not clear a standing bruise). An opener send
  records an `offer` ring entry (same cooldown).
- **Render**: `flavor: "selfie"` through `queueChatScene` →
  `renderCharacterSceneImage`. The framing, reference routing and the retry-once
  failure policy are [images/pipelines/chat-images.md](../images/pipelines/chat-images.md);
  the lane's own rules
  are that the render shares the one-live-render-per-chat dedupe with scenes,
  `meta.flavor: "selfie"` rides the asset so lifecycle is unchanged, and a
  twice-failed render stays a `failed` row rendered in the transcript as a **"Failed"
  placeholder** ("the photo never arrived") whose sent prompt opens in the admin
  lightbox panel.
- **Display**: an anchored image message with the SMS-adjacent treatment (rounded,
  accent-bordered) in the inline moments row; also in the scene strip and Gallery.

## Scene reference anchors (current look + place images)

A conversation caches two render anchors so scenes stop arguing the edit model out of the
canonical avatar's default outfit, and so a setting is more than a text sketch (owner
rulings 2026-07-11). What each anchor's prompt contains is
[images/pipelines/chat-images.md](../images/pipelines/chat-images.md); the lane owns when they mint and when they
die.

- **Current look** (`kind: "chat_look"`): an outfit-true, identity-locked variant of
  the avatar, minted by a detached `chat_look_image` job when the archivist records
  an outfit **or appearance** change (ruled: `attributeOverlays` invalidate like a
  change of clothes) — **image-active chats only** (ruled: a chat that never rendered
  pays nothing), keep-latest-only per character (the prior look deletes on replacement).
  The cache pointer is the images table itself (`meta.lookKey` on the newest ready row),
  so a regenerate rollback cannot desync pointer from asset — a stale key just falls back
  to the avatar. Scenes AND selfies anchor on it when fresh. The job skips a wardrobe
  resolve marked `unreliable`
  (a failed or coverage-unreadable load — warn `images.chat_look.wardrobe_unreliable`):
  minting from the degraded stand-in would cache a wrongly-dressed look under its key
  and the keep-latest purge would delete the correct anchor, so nothing renders and the
  next outfit/appearance change retries. The job drains its own diagnostics into the
  process log (`images.chat_look_image`).
- **Place images** (`kind: "chat_place"`): the current scene-memory place's
  establishing shot, minted lazily by `chat_place_image` from its agent-written
  sketch on the **first render there** (`queueChatScene` enqueues; that render still
  ships without it), CAS-written onto `ScenePlace.imageId` exactly like the sketch.
  Once present, chat scenes render multi-reference (look/avatar + place);
  selfies stay single-reference (the subject is the shot).
- Both kinds are chat-keyed, Gallery-hidden, hard-deleted with the conversation
  (`deleteChatAssets`), and self-healing: any lost race, failed render (row keeps
  `meta.error`), or missing file simply re-fires on the next trigger.
