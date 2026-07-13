# Character chat

The sessionless chat lane: talk to saved library characters directly — no world,
no session, location conveyed only through narration. Since slice 3 of the standalone arc,
the unit is a **conversation** (`character_chats`): one character can host many
conversations (a main story beside a fresh alternate universe), each with its own
transcript, rolling summary, and per-participant state, and a **memory group** deciding
what carries across (see §Memory below). It began as a voice-tuning test-bed
and is now a **primary feature** (shipped — see
[developer-notes/finished/character-chat-standalone.plan.md](developer-notes/finished/character-chat-standalone.plan.md)):
it carries its own tracked state, long-term RAG memory, evolving attributes, scenario
system, a stage-driven relationship arc, in-game time, and scene images. Since 2026-07-12
a conversation can hold a **roster of up to 4 full characters**
(§Multi-character below —
[developer-notes/multi-character-chat.plan.md](developer-notes/finished/multi-character-chat.plan.md)):
narrative presence instead of locations, the one-block ensemble prompt frame, a
per-conversation relationship matrix. It remains deliberately **not** a session: no
locations, exposure mask, wardrobe state, or story threads — though wardrobe is
the first planned parity step
([developer-notes/chat-wardrobe-parity.plan.md](developer-notes/chat-wardrobe-parity.plan.md)).
**Direction (owner, 2026-07-13):** chat is the **test bed for what the
world/session model will eventually look like** — the lanes stay separate for
now, but the likely end-state deprecates the current world/session model in
favor of a successor grown from what chat proves out, with chat migrating onto
it (see `CLAUDE.md`).
Where the two lanes
share a mechanism (memory scope, the §6 reaction curve, disposition rendering, narration
shape, artifact stripping, the generate-timeout race, the draining stream Response), they
share **one implementation** — the chat lane must never re-fork session machinery.

## The exchange lifecycle

All orchestration lives in `engine/chat-pipeline.ts` (`submitChatMessage`) — the chat
analogue of the session lane's `submitTurn`. The HTTP route
(`app/api/chats/[chatId]/route.ts`) is a thin parse → auth → stream shell. One
exchange:

1. **Lock.** A per-conversation keyed lock (`engine/keyed-lock.ts`, key
   `chat_exchange:{chatId}`) — a second concurrent submit gets a 409
   `chat_busy`. Held until the stream settles, released on every path.
2. **Exchange kind** (spec §4): `send` inserts the user line with a pre-minted id — the
   guard row for the reply persist; `open` (the "Prompt character" opening beat) and
   `continue` ("go on") have no player line — the model gets a synthetic, non-persisted
   cue; `regenerate` ("another take") targets the LAST assistant reply: state rolls back
   to the pre-exchange snapshot, the old take's memory is retracted (provenance, §4.3),
   and the reply row updates in place with the old take kept browsable (`takes`, cap
   `CHAT_REPLY_TAKES_CAP`); `rerun` (re-send a player line, see below) is the atomic snip.
   A player **Stop** aborts the model stream server-side; the accumulated prefix persists
   with `meta.stopped` and the fan-out runs over it.

   **Atomic rerun** (`kind: "rerun"`, `messageId` = the target user line): the ONE path
   that reconciles with an in-flight reply instead of 409ing off it. Ordering is the whole
   fix (`chat-pipeline.ts`, data-loss-rerun): **stop → wait → acquire → transact.** Before
   touching anything it calls `stopChatReply` for the chat (settling any streaming reply,
   which releases the lock), then re-acquires the lock with a **bounded wait**
   (`acquireKeyedLockWithin`, up to `CHAT_RERUN_LOCK_WAIT_MS`, re-issuing the stop each
   poll). If the lock still can't be had it returns 409 `chat_busy` **with the transcript
   completely untouched** — nothing is ever deleted before the exchange is accepted. Under
   the lock, in one transaction, it validates the target is a `user` line in this chat
   (else 400 `invalid_rerun_target`, nothing modified) and deletes ONLY its **successors**
   — computed by ordering in SQL and slicing after the target's position, never by a
   `created_at > $date` predicate (JS `Date` truncates Postgres microseconds, which would
   re-select the target itself). The target row is **reused** as the prompt guard, never
   re-inserted; deleted assistant successors have their memory retracted
   (`reconcileMessageMemory`), and state mirrors regenerate — the pre-exchange snapshot
   rolls back when the target was the last exchange's prompt (sole successor = the newest
   reply), else it degrades to no rollback with `chat_state.rerun.no_rollback`. From there
   it streams exactly like `send`. The client (`chat-conversation.tsx`) deletes NOTHING
   and never abort-and-hopes: it optimistically snips the lines after the target and, on
   any failure, restores them (the server guarantees the transcript is byte-identical).
3. **Window + summary.** The rolling summary covers everything up to its watermark; the
   verbatim window (`CHARACTER_CHAT_HISTORY_TURNS` = 40 exchanges) is everything after it.
   When the unsummarized tail reaches the fold trigger, a detached `chat_summary` job is
   enqueued fire-and-forget (§4).
4. **State drift.** The pipeline loads the shared **scenario** once, ticks its clock
   once for the whole exchange (`CHAT_TICK_MINUTES` — ONE story timeline, never per
   member), then `driftChatState` (pure) drifts each member against it — meters decay
   toward personalized baselines (present members only; the away-freeze), conditions
   expire against the shared clock for everyone. **No time passes between visits**
   (spec §8, D8 — the wall-clock model was removed outright): the only between-scene
   lever is a player **time skip** (`POST …/time-skip`), which advances the scenario
   clock, stamps its one-shot `pending_skip_note` (worded by the primary's regard band,
   `chatSkipNote`, with a "a life meanwhile" license) and `skip_history` ring, then
   gives each PRESENT member the per-character half (condition expiry, scene-budget
   reset, feeling decay) — **meters untouched** (D14, flavor-only v1). Lazily seeds
   from the authored defaults when no row exists.
5. **RAG recall.** `retrieveChatMemory` — fused retrieval over the participant's
   **memory group** (`MemoryScope` `{kind:"chat", groupId}`, [memory.md](memory.md)
   §Memory keying): each of last turn's persisted `memoryQueries` + this input is
   embedded and retrieved separately, then RRF-fused with per-source attribution
   (`retrievedDetail` on the memory trace); pinned "remember this" facts ride ahead of
   the top-k regardless of similarity. Shared-history conversations share a group;
   fresh starts are islands. Each leg degrades with a diagnostic (facts to
   pinned-only, episodes to `[]`).
6. **Prompt build.** `buildCharacterChatPromptParts` (pure, snapshot-tested) — split
   for provider prefix caching (spec §9) into a **stable prefix** (identity → persona →
   scenario → background → regard-colored disposition → the composed **Relationship** block → cards →
   attributes → sensory cues → rules; byte-identical across turns, re-rendering only on
   a band crossing on either relationship axis — asserted by a prefix-byte-stability test) and a **volatile tail**
   (recap, memory, state, skip note, disinhibition + transient-appearance overrides,
   the per-turn **sensory allowance** line, continue-beat cue, notation note, the
   optional one-turn **memory-callback** line (§Memory callbacks), beat
   instructions). An experimental `CHAT_PROMPT_LAYOUT=turn_context` switch (default off)
   moves the tail + fenced current input into a final user message instead — the session
   lane's shape; see [prompts.md](prompts.md) §Character-chat prompt-cache split. The rules carry the **player-input
   perception partition** (quoted = heard, narration = seen, interiority = invisible), the
   optional **markup-notation legend** (`*…*` thought/comms, `((…))` OOC, `_…_` italics —
   sigils parsed by the shared `@/lib/message-spans.ts`, with a per-turn comms/OOC tail note
   from `chatNotationNote`, plus the narrator's own-output emphasis rule: `_underscores_`,
   never asterisk-emphasis), and the **player-POV narrator camera** (involuntary perception +
   light reflex writable, the player's agency not — and never the player's story advanced on
   the narrator's turn; when the two are in different places, the reply follows the
   character's side only, reaching the player solely through comms — rule 16). See
   [prompts.md](prompts.md) §§Character-chat sensory cues / player-input perception /
   player-POV narration / state as a narration system / long-term memory, plus the
   regex-only one-turn cue (`engine/chat-intent.ts`).
7. **Stream.** `streamCharacterChat` — the same `streamText` + `openrouter().chat()` shape
   as the session narrator, through `stripNarratorArtifactStream` and then
   `collapseRepeatedBlocksStream` (server/ai/narrator-repeats.ts — drops Aion
   tandem-repeat blocks, a verbatim re-emit of the reply's own trailing paragraphs,
   before they reach the live feed or the persisted accumulated reply). The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list) — a headless POST without a `model` defaults to it too
   (`resolveChatModelId`), so API and UI agree. The stream is wrapped by two watchdogs
   (`withStreamTimeouts`, data-loss-rerun): a **first-token timeout**
   (`CHAT_STREAM_FIRST_TOKEN_MS` = 60s) and an **overall cap** (`CHAT_STREAM_OVERALL_MS` =
   300s). On a trip it aborts the upstream call and settles through the same stop path as a
   player Stop (any partial persists with `meta.stopped`, the lock releases, a `log.warn`
   records it) — so a wedged provider can never hold the per-chat lock indefinitely (the
   incident that motivated the fix). A first-token trip has **zero tokens**, so nothing
   persists — the client detects the clean-but-empty settle (no delta ever arrived) and
   surfaces a "didn't reply" error toast instead of letting the pending bubble silently
   vanish ([ui.md](ui.md) §Transcript).
8. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
   runs (§3). All of it is off the perceived-latency path.
9. **Render (dialogue-attribution).** The transcript owns dialogue presentation, so chat rule 3
   makes the `[Name]` tag **conditionally optional** (dialogue stays quoted; other people —
   flavor NPCs and named side characters alike — speak in narration prose with plain
   attribution, never with a bracketed tag and never as a bare quoted paragraph). The contract
   is mechanical (tightened 2026-07-10, and 2026-07-11 for side NPCs): a whole-line quote
   auto-attributes **only in a reply with no tags at all**; a line mixing the character's speech
   with narration/action beats must open with the tag or split into separate quote/prose lines,
   and a reply that tags anywhere must tag every character line — its untagged quotes render as
   narrator prose (a side NPC's own quoted paragraph, the Amanda report). The reply renders as
   in-bubble per-speaker segments
   (`components/characters/chat-segments.ts` over the shared pure `lib/segmenter`, with
   standalone-quote attribution ON since chat is one-on-one): the tag is hidden behind a small
   speaker label and, in a tag-free reply, a bare whole-line quote attributes to the character. Segment content still
   flows through the `MessageContent` span renderer, where each span body also passes through
   `parseEmphasisRuns` (`lib/message-spans`) so a `_…_` pair nested inside quoted speech
   ("it's _perfect_!") renders italic instead of literal underscores (outermost-sigil rule —
   the quote stays one atomic speech span). Stored transcripts stay byte-verbatim. See
   [prompts.md](prompts.md) §Dialogue tagging and [ui.md](ui.md) §Chat.

## Tracked state

Tracked state is **split in two** (followups rulings 8–9, 2026-07-12): what belongs to
ONE character lives on their state row; what belongs to the CONVERSATION lives on the
chat row as the shared **scenario**.

**Per character** — one `character_chat_state` row per **(chat, participant)**, PK
`(chat_id, character_id)`: the full meter registry, the two relationship axes
(relationship-model v2: `regard` −100..100, the volatile feeling axis that was
`affinity`; `familiarity` 0..100, the moments+time ratchet with its
`familiarity_scene_gain` budget — trickle capped at `acquainted`, archivist facts push
past it, reset on a time skip) plus the authored `relationship_record` texture
(kind/history/`presented` mask/looming — `contracts/relationships/record.ts`),
self-expiring conditions, the `mindNote`, the free-text outfit + exposed flag, the
anti-repetition `surfacedCues` bands, the RAG carry-overs (`memoryQueries`,
`open_loops` — the archivist's ≤3 "unfinished business" phrases, re-emitted in full each
exchange so resolved loops fall off; persisted narrative `attributeOverlays`;
`lastPulseTrace` / `lastMemoryTrace`), the relationship arc (`relationship_history` — a
≤200 sample ring `{at, clockMinutes, regard, band, familiarity}` appended when either
axis moved; `milestones` — ≤100 of
`first_exchange` / `stage_up` / `stage_down` / `familiarity_up` / `strong_reaction` / `player_marked`),
`callback_history` (the memory-callback anti-repeat ring ≤20 — see §Memory callbacks),
`feeling` (the persistent feeling + bruise — see §Emotional weather), `selfie_history`
(the selfie-send ring ≤20 behind the offer cooldown — see §Selfies), `drives` (the
runtime desires & secrets — see §Drives), and `presence`/`quiet_exchanges`
(§Multi-character).

**Chat-wide** — the **scenario** on `character_chats` (`ChatScenario`;
`loadChatScenario`/`saveChatScenario`/`seedChatScenario` in `engine/chat-state.ts`,
seeded at creation from the PRIMARY's profile — premise from `playerRelationship.note`,
house rules from their own cards — then preset-overlaid and author-owned): the
`premise`, the SETTING-wide `active_social_cards` (one rule set for every member —
per-character divergence rides character **tags** flipping the reaction, never
per-character rule lists), `scene_auto` (`"off" | "milestones"` — text with headroom,
never a boolean), `scene_model`, `scene_memory` (the accumulating narrator-imagined
setting — see §Scene memory), the time model (`clock_minutes` — **one** story timeline
for the whole roster, D3/D8; away members skip meter decay, never fork the clock;
`skip_history` ring ≤50; one-shot `pending_skip_note`), and `pre_exchange_scenario`
(the rollback anchor's chat-wide half). Beside the scenario the chat row also
carries `milestones_seen_at` (migration 0043) — the §Initiative marker-v2
seen-cursor, stamped on conversation open, deliberately outside `ChatScenario`
(it is a UI cursor, not fiction state — never snapshot/rolled back).

`upsertChatState` is the **one** state-row column-list source shared by the guarded
(mid-exchange) and unguarded (author-edit) writers; `editChatState` is ONE patch surface
over both stores (`ChatStateEdit` — per-character fields write the target's row,
chat-wide fields write the scenario) and `chatStateSnapshot(state, scenario)` merges
them back into the client's back-compat snapshot shape. State is inspected/edited
through the per-character **Character sheet** and the chat-wide **Scenario** modal
([ui.md](ui.md) §The conversation page).

## Scene memory

Chat locations are **narrator-imagined** (not world entities — the lane has no locations,
presence, or wardrobe state), so nothing kept an established setting consistent. `scene_memory`
(one jsonb column on the CHAT row — the shared scenario, one imagined setting for the whole
roster; `contracts/turns/chat-scene-memory.ts` `ChatSceneMemory`) is an accumulating,
forward-compatible memory: `{ current?, timeOfDay?, places: [{ name, details[], connections[] }] }`
with hard caps (≤12 places, ≤8 details/place, ≤6 connections, length caps) and a `parseOr`
degraded default (empty memory) at the load boundary. It is maintained **deterministic-first**,
then reconciled by the archivist:

1. **Pre-prompt (movement).** `detectSceneMovement` (`engine/chat-intent.ts`, regex-first) reads a
   movement/arrival in the player's input ("I follow her to the kitchen", "we head outside") and
   the route calls `switchScenePlace` to switch `current` (minting a stub place on first mention)
   **before** the prompt builds, so this turn's Scene injection is right. "Just changed" = a new
   current place this turn, or a pending time skip.
2. **Injection.** The prompt builder renders the compact **Scene** block in the volatile tail
   (current place + details + time of day + connections + a directive that flips on "just changed"
   — see [prompts.md](prompts.md) §Character-chat reply discipline & scene memory). On the
   conversation's **first exchange** (no assistant reply yet, not an opening beat) the memory is
   empty and "just changed" can't fire, so the tail instead renders a one-turn **first-exchange
   scene directive** (`firstExchange`, 2026-07-10): establish the scene once, narration-forward
   (sight plus one other sense), drawn from the scenario and the player's message — the movement
   path's own directive wins when a first-message move minted a place.
3. **Post-turn (reconcile).** The archivist's optional `scene` field (current-place confirmation,
   time-of-day hint, new place details/connections — ONLY what the fiction established, lenient
   parse) is merged onto the pre-turn memory in `finalizeChatState` via `mergeSceneMemory` (dedupe
   + caps, oldest-out; the current place is never evicted). A degraded/empty proposal is a no-op —
   the memory only ever accretes what the fiction established.
4. **Background sketch (chat-scene-fidelity slice 2b).** After the state write, a current place
   without a `sketch` enqueues a detached `chat_scene_sketch` job (`chat-scene-sketch.ts`, deduped
   per chat like the summary fold): a small agent (`prompts/chat-scene-sketch.ts`) expands the
   place into a 2–4 sentence visual sketch — every established detail incorporated, only
   compatible texture invented — written back onto `ScenePlace.sketch` via an optimistic CAS on
   the raw `scene_memory` jsonb (deliberately NOT the exchange lock, so it can never 409 a send;
   a lost race re-fires while the sketch stays absent). Consumed by the narrator's Scene block
   (`- Setting (fixed reference): …`) and the scene image's `room` (below).

**Reset.** Scene memory rides the ordinary chat resets: the row is on `character_chat_state`, whose
`(chat_id)` FK cascades on `deleteChat` (the one destructive verb), so a hard delete clears it with
the transcript/summary/memory; **archive** leaves it intact by design; and "another take"
(regenerate) rolls it back with the rest of the state via the `pre_exchange_state` snapshot
(`scene_memory` is in `storedChatStateSchema`), so a regenerated exchange never double-accretes.

## Memory callbacks

Fused recall is input-relevance-only, so shared history never resurfaced on its own —
the character could never say "remember when…" unprompted. The memory-callback cue
([developer-notes/memory-callbacks.plan.md](developer-notes/finished/memory-callbacks.plan.md))
fixes that with one low-frequency, one-turn tail line:

- **Gate first, cost second** (`chat-callback.ts` `chatCallbackEligible`, pure): real
  player turns only, at most once per `CHAT_CALLBACK_MIN_GAP_MINUTES` of chat clock
  (10 exchanges of ticks — a time skip naturally re-opens eligibility), and only on a
  **lull**: suppressed by a first exchange, a pending skip note, a scene change, an
  intimate beat (cue or arousal floor), a sensory-focus block, or a character question
  the player is mid-answering. No regard-band gate (owner ruling 2026-07-11) — the
  band picks the wording, not the eligibility.
- **Selection** (`chat-memory.ts` `retrieveChatCallback` → pure `selectChatCallback`):
  one embedding of the input + one query over episodes ≥8 exchanges old
  (`callbackEpisodeCandidates`, each carrying its similarity to the input). Scoring
  prefers **old**, **milestone-marked** (joined by `source_message_id` — an exchange
  that minted a `player_marked`/`strong_reaction`/band-crossing milestone is a
  *moment*), and **topic-distant** — candidates at/above the echo ceiling are dropped
  outright (recall would surface them anyway; a callback is a tangent). Used refs
  never repeat (`callback_history`, burned at offer time so "another take" rolls the
  burn back with the snapshot and the retake gets the same opportunity).
- **Render** (`chatCallbackLine`, volatile tail, lowest priority): one optional aside
  worded by regard band — warm bands get nostalgia, the middle a plain remembering,
  cold bands a pointed edge ("a point to make, a wound … never warmth you don't
  feel"). Always droppable: the scene in motion outranks the memory.
- **Degradation**: any retrieval/embedding failure ⇒ no line +
  `chat_memory.callback.failed` (warn) — an ordinary turn, never a failed reply.

## Emotional weather

Emotions used to be meter-derived and reactive-only — a strong beat's deltas started
decaying on the next tick, and regard moved on a flat ±5/turn clamp with no history.
Emotional weather ([developer-notes/emotional-weather.plan.md](developer-notes/finished/emotional-weather.plan.md),
owner rulings 2026-07-11) adds three layers, all in the pure `engine/chat-feeling.ts`:

- **Persistent `feeling`** (`character_chat_state.feeling` jsonb): the pulse proposes a
  label (the locked 11-label `EmotionLabel`) + cause when an exchange lands a beat that
  should persist; intensity derives deterministically from the curve's move (the model
  never numbers, same contract as `playerAct`). It decays **per exchange** (≈6–7
  exchanges from full), softens more slowly over time skips (`CHAT_FEELING_SKIP_STEPS` —
  moments barely dent it, days clear it), and a `"neutral"` proposal explicitly clears
  it (the pulse sees the standing feeling in its prompt, so resolution is informed). In
  the prompt it **composes** with the meter mood descriptor (ruled: baseline weather +
  the front passing through — "subdued and withdrawn right now — and deeply sad about
  the broken promise") on the Current-state line and the response-shape mood pin.
- **Regard momentum**: `scaleRegardDelta` modifies the curve's move — the standing
  feeling biases magnitude (ruled: damped, valence × intensity × ±10% max, amplifying
  deltas that agree with the feeling and damping those that fight it — hard-capped so
  hurt→worse-reads→more-hurt can't spiral); a **warmth streak** (consecutive rising
  samples in `relationship_history`) compounds gains up to ×1.5; a **bruise** — a
  strong drop landing at warm-or-better regard — halves gains for ~10 exchanges
  (ruled). A classified **`apologize`** act (new interaction concept, a registry data
  edit — distinct from `reassure`: comfort is not repair) that isn't disliked halves
  the bruise's remaining life. A scaled nonzero delta never rounds to zero, the ±5
  clamp is re-applied last, and the trace records `regardScale` + the applied feeling
  for the state tools.
- **Reply pacing** (UI-only, `lib/chat-pacing.ts` + `chat-conversation.tsx`): the
  client holds the "…" bubble before revealing streamed tokens — cold regard ≈700ms,
  the middle ≈250ms, warm none; a standing dark feeling adds ≈500ms, a bright one
  trims; capped at 1.2s and purely presentational (tokens buffer, nothing is lost;
  any held text flushes on settle/stop/failure). The snapshot carries `feeling` to
  the client for this.

Rollback-safe like everything else: `feeling` rides `storedChatStateSchema`, so
"another take" restores the pre-exchange weather exactly.

## Player photos (image input)

The player can attach up to **4 photos per message** (owner ruling 2026-07-11 —
multi-image from the start) and the character genuinely sees them
([developer-notes/chat-image-input.plan.md](developer-notes/finished/chat-image-input.plan.md)):

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
  static **rule 17** (owner ruling): react in character to what the photo shows, never
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
([developer-notes/chat-selfies.plan.md](developer-notes/finished/chat-selfies.plan.md), owner
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
([developer-notes/chat-scene-references.plan.md](developer-notes/finished/chat-scene-references.plan.md),
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
  Once present, chat scenes render **multi-reference** (look/avatar + place — the
  rung sessions always had, now live in this lane); selfies stay single-reference
  (the subject is the shot).
- Both kinds are chat-keyed, Gallery-hidden, hard-deleted with the conversation
  (`deleteChatAssets`), and self-healing: any lost race, failed render (row keeps
  `meta.error`), or missing file simply re-fires on the next trigger.

## Drives (desires & secrets)

The character's motive force
([developer-notes/character-drives.plan.md](developer-notes/character-drives.plan.md),
owner rulings 2026-07-11): ≤3 authored wants on `profile.drives`
(`contracts/personality/drives.ts` — `want`/`why`/`secrecy: open|guarded|secret` +
an optional `revealBand`), seeded into `character_chat_state.drives` (migration
0035) with runtime `progress`/`revealed`/`resolved`.

- **Prompt law** (`buildDrivesSection`, volatile tail): open drives steer; `guarded`
  never volunteers (comes out only if asked/earned); a `secret` below its reveal
  band is **protected with a full lie license** (ruled) — scoped hard: "the lying is
  for THIS secret only; in everything else you are as honest as you ever are". The
  default gate for an unbanded secret is **familiarity ≥ familiar** (ruled); at/above
  the gate the block flips to an invited reveal ("a big beat — don't force it").
- **Archivist 8th field** `driveUpdates`: progress/reveal/resolve on existing drives,
  matched by exact `want` (the prompt lists them, secrets marked); a degraded
  archivist keeps prior drives. A newly-revealed secret lands a **`secret_shared`
  milestone** (new kind — panel glyph ❖, and a prime memory-callback boost); the
  spoken reveal files as an ordinary extracted fact (ruled — no special wiring).
- **Panel** (ruled): the Relationship panel's "What they want" lists open wants +
  revealed secrets only; guarded/unrevealed drives stay invisible until play
  surfaces them. State tools/`ChatStateEdit` expose the full set (inspector-grade).
- **Authoring** (shipped 2026-07-12): the character forge's profile leg drafts
  drives (concept-led, **≤1 secret** — ruled; `groundDrives` validates reveal
  bands against the band vocabulary and demotes extra secrets to `guarded`); the
  editor's Disposition tab carries the **"Desires & secrets" card**
  (`components/characters/drives-editor.tsx` — want/why/secrecy + a reveal-gate
  picker on secrets). Forge-the-rest fills drives **additively up to the 3-cap**
  (ruled — authored drives never change); a Disposition re-draft re-derives them
  wholesale ([authoring.md](authoring.md) §Character sheet forge).

## Initiative (the character reaches out first)

The reopen opener ([developer-notes/chat-initiative.plan.md](developer-notes/chat-initiative.plan.md)):
the pickup strip gains **"Let {who} start ✦"**, which runs a `continue`-kind
exchange with `initiative: true` — the server builds the cue
(`buildInitiativeCue`, `engine/chat-initiative.ts`): reach out FIRST, with her
own material (top open loops + unresolved non-secret wants — withheld secrets
never leak into the cue; the drives tail law owns them — plus, since the
remainder pass, the **unseen shift** and the **daily rhythm** below), the **"a
life meanwhile" license** folded in (build decision: instead of a separate
life-event agent, the cue invites ONE small concrete thing from her life since,
skip-aware — zero extra model calls, exactly as grounded as the narrator
already is), the **comms-when-apart register** (`*Name: …*` texted opener when
the fiction has them apart), and a restraint clause (one beat, end on something
answerable, never narrate the player). Standing rulings hold: **D3** —
generation stays player-tapped, never background, and the marker never reads
the wall clock (re-ruled 2026-07-12: loops + milestones only); **D8** — what
the gap meant comes from the pending skip note, never real time. The opener is
an ordinary continue exchange: clock ticks, archivist off (opening path),
lock/guard semantics unchanged; the pulse is skipped **except** when the
opener-selfie license armed, where it runs **opener-scoped** (below).

The remainder slices (shipped 2026-07-12):

- **Marker v2 — the unseen-milestone seen-cursor** (spec §8.4 v2). The hub's
  "has something to say" derivation (`GET /api/chats`) stays read-time-pure:
  the top open loop leads, and with no loops the reason is the **newest
  milestone unseen since the player last opened the conversation**
  (`unseenMilestoneReason`, `contracts/relationships/history.ts` —
  `first_exchange` never fires it). "Seen" is the `character_chats.
  milestones_seen_at` cursor (migration 0043), stamped **only on conversation
  open** (`PATCH …/:chatId {seen: true}`, fired by the page's mount effect) —
  deliberately not by the transcript GET, which refetches after every exchange
  and would mark each milestone seen the instant it lands. So a milestone
  landing mid-visit lights the hub marker on the next visit and clears on the
  next open (the unread-badge pattern). The `?say=1` banner no longer requires
  open loops: a loop-less tap runs the full initiative opener, and the opener
  cue itself names the unseen shift as material ("what just shifted between
  you") via a one-column `loadMilestonesSeenAt` read on initiative beats.
- **Daily rhythm** (`profile.schedule` authoring — see
  [authoring.md](authoring.md) §Daily rhythm). The cue renders the schedule as
  one compact line (`formatScheduleRhythm` — "mornings: waiting tables at the
  Dockside Café; evenings: sketching at the pier") grounding the life-meanwhile
  license, so "just got off shift" beats draw on authored routine instead of
  invention. Chat-side consumption only; the session movement engine already
  walks the same rows.
- **Opener selfie** — see §Selfies (the opener arm).

## Multi-character (the ensemble)

A conversation holds up to **4 full characters**
([developer-notes/multi-character-chat.plan.md](developer-notes/finished/multi-character-chat.plan.md) +
the matrix slice of
[developer-notes/relationship-model.plan.md](developer-notes/finished/relationship-model.plan.md),
both shipped 2026-07-12). A roster of one is byte-identical to the classic 1-on-1
(asserted in `prompts/character-chat.test.ts`); everything below arms only at roster > 1.

- **Roster** (`chat_participants`, sort 0 = primary): created multi-select or grown later —
  `POST /api/chats/:id/participants` (cap 4, D7 memory choice per joiner),
  `DELETE …/participants/:characterId` (never the last member; a removed primary's heir
  promotes via sort renumber — state + memory stay), `PATCH …/participants/:characterId`
  `{presence}`. The roster panel (`chat-roster-panel.tsx`, desktop aside + the menu's
  Roster sheet) is the manual present/away override and add/remove surface.
- **Presence, not location** (`character_chat_state.presence`): *present* shares the
  player's scene, *away* is offstage living their life — meters **freeze** (presence gates
  the drift tick; no catch-up), no memory legs, reachable by text/call, never teleported
  in. The archivist's roster-gated 9th field confirms transitions the fiction actually
  played; `quiet_exchanges` counts activity recency (deterministic stamping —
  `mentionsCharacter`/`spokeInReply` in `chat-intent.ts` — reset by a name/alias mention
  or a tagged spoken line), and for away members it doubles as the tier-3 salience window.
- **Ensemble prompt** (`buildChatPromptPartsForRoster` → `buildEnsembleChatPromptParts`):
  one continuous narrative, the narrator omniscient over the roster; THIRD-person member
  sheets (full / quiet-compressed at `ENSEMBLE_QUIET_EXCHANGES` / away-dropped while
  anyone is present, cutaway sheets when nobody is), `ENSEMBLE_CHAT_RULES` (universal
  `[Name]` tag discipline — nothing auto-attributes in a group; characters alive to each
  other; presence law), and the ruling-3 authority block: the player is never written, and
  with no character present the reply is a **cutaway**. The §9 prefix/tail cache split
  survives (sheets re-render on roster/presence/tier/band change).
- **Scoped dynamics**: the reaction pulse runs **referenced-only** (members the player's
  turn names; the primary as anchor fallback when nobody is), resolving reactions against
  the SCENARIO's setting-wide card set (ruling 9); tier-1 **memory legs** run per
  present + recently-active member against their OWN group with per-leg k tightened by
  the active count; the ONE archivist extraction files to **every present witness's**
  group.
- **Per-member note-takers + folds** (rulings 10–11): the shared archivist keeps the
  scene-level reads (episode, facts, queries, scene, presence); every PRESENT member gets
  a small **personal pass** (`runChatPersonalNotes`, `prompts/chat-personal-notes.ts` —
  openLoops / outfit / attributeChanges / driveUpdates) folded into their own row, and
  everyone who **pulsed** gets the deterministic folds (relationship-arc samples,
  milestones, weather via the pulse) through the pure `settleEnsembleMember`. The classic
  1-on-1 keeps the single combined archivist call — no cost regression.
- **Group perks** (ruling 12): a selfie request routes to the member the message
  **addresses by name** (unaddressed falls to the lead; offers stay lead-gated) — their
  ring burns, their identity renders; the remember-when **callback** draws from ONE
  member's own group (addressed else most-recently-active present), gated on their ring
  and toned by their regard; **sensory focus** aims at the member the message studies;
  disinhibition + condition-driven transient appearance render **per present member** in
  the ensemble tail. The `turn_context` layout stays 1-on-1-only.
- **Per-character sheets** (ruling 13): tapping a roster member opens THEIR Character
  sheet (axes/texture toward the player, meters, conditions, mind note, loops, outfit +
  exposure, presence toggle); the state routes take `?characterId=` targeting. The
  Scenario modal holds only the chat-wide fields (premise, presets, house rules,
  auto-scene + scene model).
- **Relationship matrix** (`character_chat_relationships`, directed rows): per-conversation
  NPC↔NPC records seeded at creation/join from the library defaults
  (`character_relationships` — the character editor's **Relationships tab**), edited
  per-pair in the Roster sheet (`chat-relationships-editor.tsx`: kind/history shared-cell,
  stances mirrored behind an Asymmetric toggle). Injection follows the presence × salience
  tiers: present×present pairs render prefix law lines; a **salient** away member
  (mentioned in-window or edge-flagged *looming*) gets a volatile conditional block under
  the don't-teleport guard; silent away members render nothing. NPC↔NPC records are static
  authored texture in v2 — lived shifts reach the narrator through archivist relationship
  facts.

## Post-turn fan-out

`finalizeChatState` runs **pulse ‖ archivist-lite** in parallel (`Promise.all`), then one
guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the §6 personality curve —
  regard/mood deltas, arousal bump for intimate concepts, mindNote refresh, and the
  optional **feeling proposal** (§Emotional weather: label + cause only; intensity
  derives from the curve's move). Degrades to drift-only state. Skipped for
  `continue` beats (no player act to react to).
- **Archivist-lite** (`runChatArchivist`): one call emitting eight fields — the episode
  summary, `FactDraft[]`, next-turn `memoryQueries`, `attributeChanges` (applied through
  the `overlaySourceMayChange` inherent-trait guard), `openLoops` (the full ≤3 list
  each time, prior loops fed back through the prompt; a **degraded** archivist keeps the
  prior loops rather than wiping them), the optional `scene` proposal merged into
  `scene_memory` (§Scene memory), and the optional `outfit` change (chat-scene-fidelity
  slice 1): a full-replacement description + `exposed` flag when the exchange dressed,
  changed, or undressed the character, folded into `state.outfit`/`outfitExposed` — which
  the wearing-line and the scene image's authoritative outfit override both read. The
  seed falls back to the character form's `defaultOutfit` when Starting Outfit is blank —
  but `defaultOutfit` holds item **ids**, and the pure `seedChatState` can't resolve them,
  so it writes them as a **marker** that every IO-capable consumer (exchange pipeline,
  prompt preview, scenario GET/PATCH/action, time-skip) swaps for the readable garment
  phrase via `resolveSeededOutfit` → `defaultOutfitPhrase` (occlusion-filtered,
  description-primary, subtype-led, sensory appearance in parens — the same
  `formatGarment` phrasing as image prompts). Stored rows from before the 2026-07-11 fix
  persisted the raw ids; the same exact-marker match self-heals them on load. A failed
  item lookup degrades to `""` (composer inference) — ids never reach the narrator or
  the scenario modal.
  Its memory write is additionally fenced
  so an infra throw never costs the pulse's state. Every write is **provenance-stamped**
  (`source_message_id` on facts + episodes, spec §4.3): deleting or editing an assistant
  line retracts/re-extracts its memory (`reconcileMessageMemory` / `reextractEditedReply`),
  and "another take" rolls it back exactly.
- The finalizer also appends the **relationship arc** (`appendRelationshipSample` /
  `deriveExchangeMilestones`, `contracts/relationships/history.ts`), persists the
  **scenario** beside the state (the merged scene memory, the clock the pipeline ticked
  once for the whole exchange, the one-shot skip-note clear — same prompting-message
  guard), and returns `{bigMoment}` — true on a regard-band crossing or strong reaction —
  which the route uses to queue an **auto scene** anchored to the reply when the chat's
  `scene_auto` is `"milestones"` (`queueChatScene`, deduped against live renders,
  fire-and-forget; a failed queue log-warns and never touches the settled reply). Caveat:
  a scene stays anchored to the message id it was queued for, so if "another take" later
  replaces that reply, the inline moment illustrates the superseded beat — acceptable.
- The finalizer also persists the **pre-exchange snapshots** — the state half
  (`character_chat_state.pre_exchange_state`) and the scenario half
  (`character_chats.pre_exchange_scenario`) — the rollback anchors "another take"
  restores so a regenerated exchange never double-applies drift/pulse effects (the
  relationship samples/milestones AND the clock tick / scene merge / callback burn roll
  back with them). `loadPreExchangeState` is three-valued: a recorded `{}` is the
  **first-exchange sentinel** (no prior state → the regenerate re-seeds from the
  authored defaults, exactly as the live first exchange did), a real state rolls back to
  it, and a **missing** row degrades to no-rollback with `chat_state.snapshot.missing`
  (followups F3); `loadPreExchangeScenario` treats `{}` the same way (keep the live
  scenario). Both are written under the **same prompting-message guard** as the paired
  state save, so a mid-stream delete can't split the halves (F5). "First exchange" (the arc baseline + `first_exchange` milestone) keys on an
  empty relationship history, not a null snapshot, so a state row that pre-exists the first
  send — a premise Save, an opening beat, a pickup skip — still records it (F4).
- **State mutations 409 while a reply streams** (followups F1): the exchange holds the
  `chat_exchange:{chatId}` lock across the whole settle and the finalizer rewrites the full
  state row, so time skip / mark moment / state-tools PATCH / action chips first check
  `chatBusyResponse` and return **409 `chat_busy`** rather than be clobbered by the pending
  finalize.
- Both legs race a shared timeout (`withGenerateTimeout`, `server/ai`) and run on the
  agent model. Every degradation is a diagnostic, never a failed reply — the reply already
  streamed.

## Jobs

| Type | Path | Recovery |
| --- | --- | --- |
| `chat_summary` | engine queue (`enqueueChatSummary`), detached (`session_id` NULL); folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock` | heartbeated while running; a dead row is failed by the detached-job sweep |
| `chat_scene_sketch` | engine queue (`enqueueChatSceneSketch`), detached; expands a just-introduced place into a visual sketch on `scene_memory` (§Scene memory step 4) — write is an optimistic CAS, never the exchange lock; one live job per chat | same detached sweep; a lost CAS or failed run simply re-fires while the place's sketch stays absent |
| `chat_look_image` | engine queue (`enqueueChatLookImage`, fired by the finalizer on an outfit/appearance change), detached; mints the outfit-true look anchor (§Scene reference anchors) — image-active chats only, keep-latest | same sweep; a failed mint leaves renders on the avatar and the next change re-fires |
| `chat_place_image` | engine queue (`enqueueChatPlaceImage`, fired lazily by `queueChatScene` on the first render in a sketched place), detached; CAS-writes `ScenePlace.imageId` | same sweep; a lost CAS / failed render re-fires on the next render there |
| `chat_scene_image` | api-side `startJob` via the shared `queueChatScene` (`chats/[chatId]/scene/queue.ts`) — manual POST **and** the auto big-moment hook; one live render per chat (check-then-insert dedupe); anchored at queue time (manual = newest assistant line, auto = the exchange's reply) | `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any session-less running job whose heartbeat is older than `API_JOB_STALE_MS` |

## Persistence guards

- **Reply persist** (`persistAssistantReply`): atomic `INSERT … SELECT … WHERE EXISTS`
  keyed on the prompting user line, so a Clear Chat or message delete landing mid-stream
  can't resurrect an orphan reply.
- **State write** (`saveChatState`): same guard shape, keyed on the same row.
- **Delete** (`deleteChat` — the one destructive verb; **archive** via `PATCH
  {archived:true}` is the everyday shelve/restore action): one transaction — the chat
  row's FK cascades take transcript + summary + participants + state; the scene-image
  prompt scrub runs **per conversation** for chat-keyed rows (sibling chats keep
  theirs), plus the legacy character-wide scrub for pre-slice-9 null-`chatId` rows —
  assets survive either way (`images.chat_id` is SET NULL); the memory group is purged
  only when no other conversation references it. **Character deletion routes through
  this too** (deletion-leak audit, 2026-07-10): `DELETE /api/characters/:id` runs every
  chat the character participates in through `deleteChat` BEFORE deleting the character
  row — deleting the character alone cascaded `chat_participants`/`character_chat_state`
  away and stranded the chat row, transcript, and memory group (invisible in the hub,
  which inner-joins participants, but fully stored). Ordering matters: the participant
  rows are the only map from chat to memory group, so the purge must run while they
  still exist.

## API surface

All under `/api/chats` (ownership resolves through the chat row — `chats/owned.ts`
`loadOwnedChat`):

| Route | What |
| --- | --- |
| `GET /api/chats?characterId=&archived=1` · `POST /api/chats` | list conversations · create one (`memory: "shared" \| "fresh"` — the D7 choice) |
| `GET/POST/PATCH/DELETE /api/chats/:chatId` | newest transcript page (100 rows; `?before=<messageId>` keysets older pages, `hasMore`/`nextBefore` in the envelope — the UI's "Load earlier") · one exchange (`kind: send \| open \| continue \| regenerate \| rerun`; `rerun` takes `messageId` = the target user line; `send` may carry `attachmentIds` ≤4 — §Player photos — and may be photo-only; plain-text token stream; 409 `chat_archived` on an archived chat) · rename/archive/restore · hard delete |
| `POST /api/chats/:chatId/attachments` | upload ONE player photo (data URL in, `chat_upload` asset id back — §Player photos); 409 on an archived chat, generation-rate-limited |
| `POST /api/chats/:chatId/participants` · `PATCH/DELETE …/participants/:characterId` | roster add (cap 4, D7 memory choice; seeds matrix pairs) · presence flip (through `editChatState`, 409 mid-stream) · remove (never the last; primary's heir promotes — §Multi-character) |
| `GET/PUT /api/chats/:chatId/relationships` | the conversation's directed NPC↔NPC matrix + roster · upsert authored edges (band picks → live scalars; roster-validated — §Multi-character) |
| `GET/PUT /api/characters/:id/relationships` | the character's library-default edges (the editor's Relationships tab; replace-set save; seeds new conversations) |
| `POST /api/chats/:chatId/stop` | cut the in-flight reply short (spec §4.2 — the prefix persists with `meta.stopped`) |
| `PATCH/DELETE /api/chats/:chatId/messages/:messageId` | edit / snip one line — both reconcile the line's extracted memory (spec §4.3) |
| `PATCH /api/chats/:chatId/messages/:messageId/take` | make a recorded take the displayed reply (display-only; spec §4.1) |
| `GET/POST /api/chat-presets` · `DELETE /api/chat-presets/:id` | scenario presets (spec §1.5); `POST /api/chats {presetId}` seeds a new conversation from one. UI: Apply/Save-as/Delete preset in `chat-scenario-modal.tsx`, "Start from preset" in `new-chat-dialog.tsx` |
| `GET/PATCH/POST /api/chats/:chatId/state` | state snapshot (drift-on-read; `?characterId=` targets any roster member — the per-character sheet, ruling 13) · author edit (`ChatStateEdit`, ONE patch surface — per-character fields to the target's row, chat-wide fields to the scenario; `?characterId=` too) · action chip (primary) |
| `GET/POST /api/chats/:chatId/scene` | list **this chat's** scenes only (sibling chats / un-chat-keyed rows stay Gallery-only) plus `rendering` — true while a `chat_scene_image` job is live (`hasLiveChatSceneJob`), which is what keeps the client polling through the composer step *before* the pending image row exists · queue a render via `queueChatScene` (409 `scene_busy` while one is live). The render honors the chat's `sceneModel` pick (`character_chats.scene_model` — the shared scenario; saved on select from the strip's dropdown via the state PATCH, or the Scenario modal's select): `"reference"` = the identity-locked avatar edit; a t2i key = a style hot-swap rendered without the avatar ([images.md](images.md) §Scene images) |
| `POST /api/chats/:chatId/remember` | "remember this" (spec §6.4, D15): pin an `origin:"player"` fact — confidence 1, no message anchor, force-retrieved, never superseded by extraction ([memory.md](memory.md)) |
| `POST /api/chats/:chatId/time-skip` | `{amount: moments\|hours\|overnight\|days}` → `CHAT_SKIP_MINUTES`; the SHARED scenario clock + skip note (worded by the primary's band) + `skip_history`, then each PRESENT member's condition expiry / scene-budget reset / feeling decay; meters untouched (D14) |
| `GET /api/chats/:chatId/relationship` | Relationship-panel payload: both axis bands + scalars, region label, texture, history samples, milestones, story-so-far, open loops |
| `POST /api/chats/:chatId/milestones` | "mark this moment": append a `player_marked` milestone on a message (label defaults to a line excerpt) |
| `POST /api/chats/:chatId/summary/rebuild` | `rebuildChatSummary` — reset + re-fold the rolling summary from the full transcript under the summary lock (heavy-write rate limited) |
| `GET /api/chats/:chatId/export?format=md\|json&memory=1` | transcript export — title, scenario, story-so-far, transcript, opt-in memory appendix |
| `/api/admin/chat-inspector/:chatId[/…]` | memory inspector family (spec §6.1; **admin-role-gated — 404 for non-admins**, so it works on the deployed build; owner-scoped): overview (all facts incl. superseded/retracted — each labeled with its `channel`: `perceived`/`private`/`ooc`, the RAG visibility fence, [memory.md](memory.md) §Fact channel — plus episodes + summary) · facts create/PATCH (pin/retract/restore, re-embed-on-edit) · episodes PATCH/DELETE + `score?q=` · summary PATCH · prompt preview (`previewChatPrompt` — "what reaches the narrator") |

## Diagnostics

`chat_state.pulse` / `.degraded` / `.timeout` · `chat_archivist.extract` / `.degraded` /
`.timeout` · `chat_memory.episodes_failed` / `.facts_failed` ·
`memory.facts.embed_failed` / `memory.episodes.embed_failed` (a fused-retrieval
query-embedding failure — facts degrade to pinned-only, episodes to `[]`) ·
`chat_memory.callback.failed` (a degraded memory-callback retrieval — the turn just
carries no callback line) ·
`chat_vision.describe_failed` (a degraded photo read — the character sees "a photo
you can't quite make out"; a non-degraded later retake retries) ·
`chat_state.memory.write_failed` · `chat_state.attribute.unknown` /
`.inherent_change_rejected` · `chat_summary.fold` / `.degraded` / `.empty` · `chat_state.snapshot.missing` ·
`chat_state.rerun.no_rollback` (a rerun target that is not the last exchange's prompt —
regenerating without state rollback) ·
`chat_memory.reconciled` — plus route
errors `chat_busy` (409), `chat_archived` (409), `invalid_rerun_target` (400), `scene_busy` (409), `rate_limited` (429),
`not_found` (404). A failed `queueChatScene` (auto or manual) log-warns
(`chat_scene` scope) and returns null — never a failed exchange. Degradation tests
assert the fallback **and** the code ([testing.md](testing.md)).

## Where things live

| Concern | File |
| --- | --- |
| Exchange orchestration | `server/engine/chat-pipeline.ts` |
| Model stream | `server/engine/character-chat.ts` |
| State (drift/pulse/persist) | `server/engine/chat-state.ts` |
| RAG client (recall/archivist/write) | `server/engine/chat-memory.ts` |
| Rolling summary + fold job + rebuild | `server/engine/chat-summary.ts` |
| One-turn player-input reads (cue / scene movement / sensory focus / reply gates) | `server/engine/chat-intent.ts` |
| Memory callbacks (gate / selection / ring — §Memory callbacks) | `server/engine/chat-callback.ts` (pure) + `retrieveChatCallback` in `chat-memory.ts` + `chatCallbackLine` in `prompts/character-chat.ts` |
| Emotional weather (feeling / momentum / bruise — §Emotional weather) | `server/engine/chat-feeling.ts` (pure) + wiring in `chat-state.ts`; pacing in `lib/chat-pacing.ts` |
| Player photos (upload / claim / vision — §Player photos) | `server/images/upload.ts` (`uploadChatAttachment`) + `assets.ts` (`claimChatAttachments`/`deleteChatUploads`) + `server/engine/chat-vision.ts`; composer prep in `components/chat/attachment-file.ts` |
| Selfies (triggers / gates / retry — §Selfies) | `server/engine/chat-selfie.ts` (pure) + pulse `sentPhoto` + `chatSelfieLine` in `prompts/character-chat.ts` + the selfie branch in `images/character-scene.ts`; "Failed" placeholder in `components/chat/chat-scene-moments.tsx` |
| Scene reference anchors (look / place — §Scene reference anchors) | `server/images/chat-look.ts` (key + renders) + `server/engine/chat-reference-enqueue.ts` / `chat-reference-images.ts` (jobs) + consumption in `images/character-scene.ts` and `scene/queue.ts` |
| Drives (schemas / gate / updates — §Drives) | `contracts/personality/drives.ts` (pure) + `buildDrivesSection` in `prompts/character-chat.ts` + the finalize fold in `chat-state.ts` |
| Initiative (the reopen opener — §Initiative) | `server/engine/chat-initiative.ts` (pure cue) + the `initiative` flag through route/pipeline + the pickup-strip button |
| Multi-character (roster / ensemble / matrix — §Multi-character) | `app/api/chats/[chatId]/participants/*` + `…/relationships/route.ts` + `app/api/characters/[id]/relationships/route.ts`; `server/engine/chat-relationships.ts` (seed/load/upsert); the ensemble builders + `ENSEMBLE_CHAT_RULES` in `prompts/character-chat.ts`; `mentionsCharacter`/`spokeInReply` in `chat-intent.ts`; the per-member personal pass (`runChatPersonalNotes` in `chat-memory.ts` + `prompts/chat-personal-notes.ts`) + `settleEnsembleMember` in `chat-state.ts`; UI in `components/chat/chat-roster-panel.tsx` + `chat-relationships-editor.tsx` + `components/characters/relationships-editor.tsx` |
| Scene memory (schema + merge + movement switch) | `contracts/turns/chat-scene-memory.ts` |
| System prompt | `server/engine/prompts/character-chat.ts` (+ `prompts/chat-archivist.ts`, `prompts/chat-state.ts`, `prompts/chat-summary.ts`) |
| Relationship block / band profiles | `contracts/relationships/law.ts` (`composeRelationshipLaw`, band profiles, corners) + `contracts/relationships/bands.ts` (axes) + `contracts/relationships/history.ts` (samples/milestones) |
| RRF fusion (pure) | `server/memory/fusion.ts` ([memory.md](memory.md)) |
| Scene image | `server/images/character-scene.ts` ([images.md](images.md) §state-aware chat scene); queue + anchor + dedupe in `app/api/chats/[chatId]/scene/queue.ts` (`queueChatScene`) |
| Admin inspector | `app/api/admin/chat-inspector/*` (role-gated routes) + `components/chat/chat-inspector-{page,facts,episodes}.tsx` behind `/chat/[chatId]/inspector` (admin-gated) |
| Retrieval eval harness | `scripts/eval/retrieval/` (`pnpm eval:retrieval` — never in `verify`; see its README) |
| UI — the conversation | `components/chat/chat-conversation.tsx` (full-screen `/chat/[chatId]`, [ui.md](ui.md) §The conversation page) + `components/chat/` (`chat-relationship-panel`, `chat-pickup-strip`, `chat-scene-moments`) + siblings in `components/characters/` (`chat-message`, `chat-scene-strip`, `chat-status`, `chat-state-tools`, `chat-scenario-modal`) |
| UI — editor Chat tab | `components/characters/character-chat.tsx` — a summary surface only (Chat defaults + conversation list), never the transcript |

History: the feature shipped across the `character-chat*` plan family (see
`developer-notes/finished/` and the roadmap's Shipped list); the shipped standalone plan lives in
[developer-notes/finished/character-chat-standalone.plan.md](developer-notes/finished/character-chat-standalone.plan.md).
Current direction is the relationship-model v2 and multi-character chat plans.
