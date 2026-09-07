# The exchange pipeline

One chat exchange from lock to settle: `engine/chat-pipeline.ts` (`submitChatMessage`),
with reply persistence, rerun cuts and take history in `engine/chat-reply-store.ts`, and
stream draining, Stop, watchdogs and failure recording in `engine/chat-reply-stream.ts`. The
persistence guards keep a mid-stream delete from resurrecting orphans. The
fan-out that follows the flushed reply is [post-turn.md](post-turn.md); the optional
contact/permission legs that run mid-exchange are [physical-legs.md](physical-legs.md);
what a reply that never arrives records is [reply-failures.md](reply-failures.md).
Read-only inspectors live in `engine/chat-prompt-preview.ts`; they share prompt inputs
with the coordinator through `engine/chat-prompt-input.ts` and the image visual-cut
factory through `engine/chat-visual-state-cut.ts`.

The coordinator retains lock acquisition/release, reply guards, rollback anchors and the
single frozen narrator instruction source. Preparation uses explicit phase inputs and
returns the values consumed by later phases:

- `chat-turn-prepare.ts` owns recall, action/perk preparation and resolved presentation reads.
- `chat-turn-contact.ts` owns contact planning and awaited ledger/scene persistence, returning
  the updated scenario, exact coverage captures, effect proposals and observer facts.
- `chat-turn-guidance.ts` renders physical guidance and assembles visual observation from
  that updated cut; the contact observer runs after guidance and before streaming.
- `chat-turn-prompt.ts` assembles solo/ensemble narrator prompts, transport layout and
  provenance nodes. Only this narrator phase receives the source-bearing prompt input.
- `chat-turn-settle.ts` commits observer memory and settles isolated ensemble members.
  `chat-turn-types.ts` owns the exchange API types without importing the coordinator.

The coordinator visibly orders reply persistence, NPC decision launch, primary finalization,
concurrent member settlement, sequential shared garment reconciliation, the last scene writer,
permission processing and callbacks. Opening keeps its separate persistence and observer
commit path before the common NPC/permission tail and early return.

## The exchange lifecycle

The coordinator in `engine/chat-pipeline.ts` (`submitChatMessage`) owns the exchange
lock, preparation and settlement. The stream owner receives its settlement and lock-release
callbacks; it keeps one active abort registry shared with Stop and rerun. The HTTP route
(`app/api/chats/[chatId]/route.ts`) is a thin parse → auth → stream shell. One
exchange:

1. **Lock.** A per-conversation keyed lock (`engine/keyed-lock.ts`, key
   `chat_exchange:{chatId}`) — a second concurrent submit gets a 409
   `chat_busy`. Held until the stream settles, released on every path.
2. **Exchange kind**: `send` inserts the user line with a pre-minted id — the
   guard row for the reply persist; `open` (the "Prompt character" opening beat) and
   `continue` ("go on") have no player line — the model gets a synthetic, non-persisted
   cue; `action_beat` (a tapped action chip, see below) is the same beat shape carrying a
   chip id; `regenerate` ("another take") targets the LAST assistant reply: state rolls back
   to the pre-exchange snapshot, the old take's memory is retracted (provenance),
   and the reply row updates in place with the old take kept browsable (`takes`, cap
   `CHAT_REPLY_TAKES_CAP`); `rerun` (re-send a player line, see below) is the atomic snip.
   A player **Stop** aborts the model stream server-side; the accumulated prefix persists
   with `meta.stopped` and the fan-out runs over it.

   **Action beats** (`kind: "action_beat"`, `action` = the chip id):
   the four status-strip chips ("Offer a drink / Freshen up / Take a breather / Heat things
   up") are not silent state pokes — a tap is a **narrated one-beat exchange**. No
   player line is persisted; the server builds a **register-aware synthetic cue** from the
   chip id (`engine/chat-action-beat.ts` `buildActionBeatCue` — apart ⇒ answer as a text,
   co-present ⇒ in-scene, the apart/co-present read is the last reply's comms spans, the
   same signal the selfie offer uses) and applies the chip's **deterministic effect**
   (`applyChatAction`, intoxication↑ / hygiene refresh / energy↑ / arousal↑ + flushed) to
   the drifted state **pre-narration**, so the reply reflects the shift. The pulse is
   skipped (no player act, like `continue`); the archivist runs. The effect is rollback-safe
   via the pre-exchange snapshot (the anchor is the PRE-effect state), and the chip id rides
   the reply's `meta.actionBeat` so **"another take"** on the beat reproduces both the cue
   and the effect (rolled back first, so it re-applies exactly once — never doubles). The
   beat targets the **primary** — the roster member whose status strip hosts the chips; in a
   group the other members neither pulse nor take the effect.

   **Atomic rerun** (`kind: "rerun"`, `messageId` = the target user line): the ONE path
   that reconciles with an in-flight reply instead of 409ing off it. Ordering is the whole
   contract: **stop → wait → acquire → transact.** Before
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
   (`reconcileMessageMemory`), and state mirrors regenerate. Only the **latest
   exchange's prompt** is eligible for in-place rerun: sole successor = the newest
   reply, **or zero successors** — the reply never persisted (stream failure/timeout,
   empty reply, pre-text stop), the retry path behind the failure popup. A zero-successor
   rerun skips the snapshot rollback: the failed exchange never settled, so live state
   is the correct starting point (the stored anchor belongs to the previous exchange).
   An older target returns 400 `rerun_requires_branch` before deleting anything: the
   one-exchange snapshot cannot restore an arbitrary discarded suffix, so the honest
   operation is a future conversation branch, not a false rollback. From there an accepted
   rerun streams exactly like `send`. The client (`use-chat-exchange.ts`) deletes NOTHING
   and never abort-and-hopes: it optimistically snips the lines after the target and, on
   any failure, restores them (the server guarantees the transcript is byte-identical).
3. **Window + summary.** The rolling summary covers everything up to its watermark; the
   verbatim window (`CHARACTER_CHAT_HISTORY_TURNS` = 40 exchanges) is everything after it.
   When the unsummarized tail reaches the fold trigger, a detached `chat_summary` job is
   enqueued fire-and-forget.
4. **State drift.** The pipeline loads the shared **scenario** once, ticks its clock
   once for the whole exchange (`CHAT_TICK_MINUTES` = 1 story minute —
   ONE story timeline, never per member), then `driftChatState`
   (pure) drifts each member against it — meters decay toward personalized baselines
   by `CHAT_METER_DRIFT_MINUTES` (= 4; meter pacing is exchange-keyed, deliberately
   decoupled from the 1-minute clock tick) for present members only (the away-freeze);
   conditions expire against the shared clock for everyone. **No time passes between visits**
   — there is no wall-clock model, and the only between-scene
   lever is a player **time skip** (`POST …/time-skip`), which advances the scenario
   clock, stamps its one-shot `pending_skip_note` (worded by the primary's regard band,
   `chatSkipNote`, with a "a life meanwhile" license **and the calendar landing** —
   "It is now Friday evening") and `skip_history` ring, then
   gives each PRESENT member the per-character half (condition expiry, scene-budget
   reset, feeling decay, and **rhythm auto-dress** — a `profile.schedule` row covering
   the skipped-to clock that names an outfit preset re-dresses the member for that
   window, `rhythmOutfitPatch`) — **meters untouched**
   (a skip is flavor, not a meter mover). Lazily seeds from the authored defaults when no
   row exists.
   A qualifying skip (cumulative ≥ one story day since the last pass) also fires the
   detached **meanwhile pass** (`chat_meanwhile` job): one call proposing the
   cast's off-screen developments, folded into facts / drives / cast / plans /
   whereabouts + the one-shot meanwhile note. Fire-and-forget: the next exchange
   proceeds on grounded improvisation if it hasn't landed.
5. **RAG recall.** `retrieveChatMemory` — fused retrieval over the participant's
   **memory group** (`MemoryScope` `{kind:"chat", groupId}`, [memory.md](../memory.md)
   §Memory keying): each of last turn's persisted `memoryQueries` + this input is
   embedded and retrieved separately, then RRF-fused with per-source attribution
   (`retrievedDetail` on the memory trace); pinned "remember this" facts ride ahead of
   the top-k regardless of similarity. Shared-history conversations share a group;
   fresh starts are islands. Each leg degrades with a diagnostic (facts to
   pinned-only, episodes to `[]`).

   **One embed per turn**: the pipeline embeds the
   whole turn's query set ONCE — the player's input plus every participant's persisted
   `memoryQueries` — through `QueryEmbeddings.embed` (`server/memory/query-embeddings.ts`;
   trimmed + deduped) and hands that cache to every consumer: the fact leg, the episode leg,
   each ensemble member's pair of legs, and the memory-callback picker (whose anti-echo
   anchor IS the player's input). Embedding per consumer would cost 2–3 round-trips for one
   text set, and unlike every other agent cost this one sits
   on the **pre-reply** path the player actually waits on. A failed embed degrades each leg
   exactly as its own would (facts → pinned-only, episodes → `[]`, callback → none). A
   caller that passes no cache still embeds internally, unchanged (the eval harness).
6. **Physical legs.** The optional contact, constraint-guidance and romantic-permission
   legs run here, between recall and the prompt build — each behind its own flag, and
   none of them ever writing another's state. [physical-legs.md](physical-legs.md).
7. **Prompt build.** `buildCharacterChatPromptParts` (pure, snapshot-tested) — split
   for provider prefix caching into a **stable prefix** (identity → persona →
   scenario → background → regard-colored disposition → the composed **Relationship** block → cards →
   attributes → sensory cues → rules; byte-identical across turns, re-rendering only on
   a band crossing on either relationship axis — asserted by a prefix-byte-stability test) and a **volatile tail**
   (recap, memory, voice ring, state, drives, scene, cast, disinhibition +
   transient-appearance overrides — then the **"Right now" digest**, then the voice
   re-anchor + response-shape line). The digest is the
   tail's one-turn directives gathered under a single heading that states their authority
   and **ordered by tier** — **binding** (storyteller-narration note, notation/comms
   routing, attached photos, time passed, first-scene establish) → **gate** (sensory focus,
   the sensory-allowance ceiling, the reply-discipline gates, a voice-slip correction) →
   **license** (the continue/initiative cue, the selfie license) → **flavor** (the
   memory-callback line). Deferral for a crowded turn is deliberately NOT done at render
   time — see §The one-turn notes below.
   An experimental `CHAT_PROMPT_LAYOUT=turn_context` switch (default `system_tail`)
   moves the tail + fenced current input into a final user message instead; see
   [prompts.md](prompts.md) §Character-chat prompt-cache split. The rules carry the **player-input
   perception partition** (quoted = heard, narration = seen, interiority = invisible), the
   optional **markup-notation legend** (`*…*` thought/comms, `((…))` OOC, `_…_` italics —
   sigils parsed by the shared `@/lib/message-spans.ts`, with a per-turn comms/OOC tail note
   from `chatNotationNote`, plus the narrator's own-output emphasis rule: `_underscores_`,
   never asterisk-emphasis), and the **player-POV narrator camera** (involuntary perception +
   light reflex writable, the player's agency not — and never the player's story advanced on
   the narrator's turn; when the two are in different places, the reply follows the
   character's side only, reaching the player solely through comms — rule 15). See
   [perception-gates.md](perception-gates.md) — the sensory cues, the player-input
   perception partition, and the player-POV camera — and
   [prompts.md](prompts.md) §Character-chat state as a narration system, plus the
   regex-only one-turn cue (`engine/chat-intent.ts`). The cue, movement, sensory-focus,
   and contact reads share the channel/sentence and contraction primitives in
   `lib/chat-input-evidence.ts`, then apply detector-specific evidence policies; there is
   no universal eligibility gate because a visual accent, a prompt premise, a
   scene-memory mutation, and a durable contact have different false-positive costs.
8. **Stream.** `streamCharacterChat` — a `streamText` + `openrouter().chat()` shape,
   through `stripNarratorArtifactStream`, then `stripMisplacedSpeakerTagStream`
   (server/ai/narrator-speaker-tags.ts — de-brackets a known name written outside a
   line-opening tag position, e.g. `"Nice to see you, [Brian]."`; the roster comes in as
   `speakers`, the player + supporting cast as `plain`), then
   `collapseRepeatedBlocksStream` (server/ai/narrator-repeats.ts — drops Aion
   tandem-repeat blocks, a verbatim re-emit of the reply's own trailing paragraphs,
   before they reach the live feed or the persisted accumulated reply). The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list) — a headless POST without a `model` defaults to it too
   (`resolveChatModelId`), so API and UI agree. Resolution ends server-side in
   `chatNarrativeModelId`, which adds a second gate to curation: a pick whose provider
   has no configured key falls back to the lane default rather than spending the turn
   on a certain 401. `textModel` then points the id at whichever upstream serves it —
   the narrator list is the only model list in the app that may name a provider other
   than OpenRouter. The stream is wrapped by two watchdogs
   (`withStreamTimeouts`): a **first-token timeout**
   (`CHAT_STREAM_FIRST_TOKEN_MS` = 50s — deliberately under Fly's ~60s proxy idle
   timeout, which would otherwise kill the zero-bytes-so-far response first and turn an
   attributable timeout into a silent connection drop) and an **overall cap**
   (`CHAT_STREAM_OVERALL_MS` = 300s). On a trip it aborts the upstream call and settles
   through the same stop path as a player Stop (any partial persists with `meta.stopped`,
   the lock releases) — so a wedged provider can never hold the per-chat lock
   indefinitely. [reply-failures.md](reply-failures.md) covers how a zero-token
   settle is classified and surfaced.
9. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](../resilience.md) §5) — the reply persists and the post-turn fan-out
   runs ([post-turn.md](post-turn.md)). All of it is off the perceived-latency path.
10. **Render (dialogue-attribution).** The transcript owns dialogue presentation, so chat rule 3
   makes the `[Name]` tag **conditionally optional** (dialogue stays quoted; other people —
   flavor NPCs and named side characters alike — speak in narration prose with plain
   attribution, never with a bracketed tag and never as a bare quoted paragraph). The contract
   is mechanical: a whole-line quote
   auto-attributes **only in a reply with no tags at all**; a line mixing the character's speech
   with narration/action beats must open with the tag or split into separate quote/prose lines,
   and a reply that tags anywhere must tag every character line — its untagged quotes render as
   narrator prose (a side NPC's own quoted paragraph). The reply renders as
   in-bubble per-speaker segments
   (`components/characters/chat-segments.ts` over the shared pure `lib/segmenter`, with
   standalone-quote attribution ON since chat is one-on-one): the tag is hidden behind a small
   speaker label and, in a tag-free reply, a bare whole-line quote attributes to the character. Segment content still
   flows through the `MessageContent` span renderer, where each span body also passes through
   `parseEmphasisRuns` (`lib/message-spans`) so a `_…_` pair nested inside quoted speech
   ("it's _perfect_!") renders italic instead of literal underscores (outermost-sigil rule —
   the quote stays one atomic speech span). Stored transcripts stay byte-verbatim. See
   [narrator-craft.md](narrator-craft.md) §Dialogue tagging and [ui/transcript.md](../ui/transcript.md).

## The one-turn notes (and why deferral happens pre-burn)

The volatile tail's per-turn directives render through one ordered digest (§The exchange
lifecycle, step 7). Where a turn is **crowded** — several one-turn notes competing for the
same beat — the low-priority ones are dropped, but that decision is made **upstream in the
pipeline, not at render time**, for a hard reason: an offered **memory callback burns its
anti-repeat ring entry the moment it is chosen** (`appendCallbackEntry`, riding this
exchange's ordinary state write). A callback dropped later by a render-time cap would be
*spent without ever reaching the page*, and that episode could never be offered again.

So `chatCallbackEligible` (`engine/chat-callback.ts`, pure) is the tail's soft cap: it runs
**before** a single token or embedding is paid for, and yields the flavor slot to anything
that outranks it — a first exchange, a pending skip note, a scene change, an intimate beat, a
sensory-focus block, an unanswered question, **attached photos**, **storyteller-narration
input**, or an **armed photo beat** (a selfie request, an unprompted offer, or the opener's
photo license). The prompt builder
then renders exactly what survived the gate; it never silently drops a note.

## Persistence guards

- **Reply persist** (`chat-reply-store.ts` `persistAssistantReply`): atomic `INSERT … SELECT … WHERE EXISTS`
  keyed on the prompting user line, so a Clear Chat or message delete landing mid-stream
  can't resurrect an orphan reply.
- **State write** (`saveChatState`): same guard shape, keyed on the same row.
- **Delete** (`chat-delete.ts` `deleteChat` — the one destructive verb; **archive** via `PATCH
  {archived:true}` is the everyday shelve/restore action): one transaction — the chat
  row's FK cascades take transcript + summary + participants + state; the scene-image
  prompt scrub runs **per conversation** for chat-keyed rows (sibling chats keep
  theirs), plus a legacy character-wide scrub for rows predating per-conversation scene
  keying (null `chatId`) — assets survive either way (`images.chat_id` is SET NULL); the
  memory group is purged
  only when no other conversation references it. **Character deletion routes through
  this too**: `DELETE /api/characters/:id` runs every
  chat the character participates in through `deleteChat` BEFORE deleting the character
  row — deleting the character alone would cascade `chat_participants`/`character_chat_state`
  away and strand the chat row, transcript, and memory group (invisible in the hub,
  which inner-joins participants, but fully stored). Ordering matters: the participant
  rows are the only map from chat to memory group, so the purge must run while they
  still exist. **Ownership is proved inside `deleteChat(chatId, ownerId)`**, not taken
  from the caller: it re-reads the chat under
  `id + owner_id` and no-ops with a `chat.delete_denied` warn when nothing matches, and
  the character traversal is itself owner-scoped — a cross-owner participant row is
  skipped, and that chat survives. **A successor chat's world dies with it**: when the chat row carries a `sim_branch_id`,
  the world resolves through `sim_branches` and its `sim_worlds` row is deleted in
  the same transaction — cascades take the branch and every branch-scoped row. A
  set-but-dangling branch id degrades
  (`chat.delete_sim_branch_missing` warn, chat still deletes); the leaked world is
  reclaimed by the admin orphan sweeper. Character deletion inherits this through
  the same traversal.
