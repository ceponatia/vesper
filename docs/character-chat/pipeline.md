# The exchange pipeline

One chat exchange from lock to settle: `engine/chat-pipeline.ts` (`submitChatMessage`),
the post-turn fan-out that follows the flushed reply, the detached jobs it enqueues,
and the persistence guards that keep a mid-stream delete from resurrecting orphans.

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
   reset, feeling decay, and **rhythm auto-dress** — a `profile.schedule` row covering
   the skipped-to clock that names an outfit preset re-dresses the member for that
   window, `rhythmOutfitPatch`; ux-improvements slice 8.4) — **meters untouched**
   (D14, flavor-only v1). Lazily seeds from the authored defaults when no row exists.
5. **RAG recall.** `retrieveChatMemory` — fused retrieval over the participant's
   **memory group** (`MemoryScope` `{kind:"chat", groupId}`, [memory.md](../memory.md)
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
   optional one-turn **memory-callback** line ([initiative.md](initiative.md) §Memory callbacks), beat
   instructions). An experimental `CHAT_PROMPT_LAYOUT=turn_context` switch (default off)
   moves the tail + fenced current input into a final user message instead — the session
   lane's shape; see [prompts.md](../prompts.md) §Character-chat prompt-cache split. The rules carry the **player-input
   perception partition** (quoted = heard, narration = seen, interiority = invisible), the
   optional **markup-notation legend** (`*…*` thought/comms, `((…))` OOC, `_…_` italics —
   sigils parsed by the shared `@/lib/message-spans.ts`, with a per-turn comms/OOC tail note
   from `chatNotationNote`, plus the narrator's own-output emphasis rule: `_underscores_`,
   never asterisk-emphasis), and the **player-POV narrator camera** (involuntary perception +
   light reflex writable, the player's agency not — and never the player's story advanced on
   the narrator's turn; when the two are in different places, the reply follows the
   character's side only, reaching the player solely through comms — rule 16). See
   [prompts.md](../prompts.md) §§Character-chat sensory cues / player-input perception /
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
   (`CHAT_STREAM_FIRST_TOKEN_MS` = 50s — deliberately under Fly's ~60s proxy idle
   timeout, which would otherwise kill the zero-bytes-so-far response first and turn an
   attributable timeout into a silent connection drop) and an **overall cap**
   (`CHAT_STREAM_OVERALL_MS` = 300s). On a trip it aborts the upstream call and settles
   through the same stop path as a player Stop (any partial persists with `meta.stopped`,
   the lock releases) — so a wedged provider can never hold the per-chat lock indefinitely
   (the incident that motivated the fix). See §Reply failures below for how a zero-token
   settle is classified and surfaced.
8. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](../resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
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
   [prompts.md](../prompts.md) §Dialogue tagging and [ui.md](../ui.md) §Chat.


## Post-turn fan-out

`finalizeChatState` runs **pulse ‖ archivist-lite** in parallel (`Promise.all`), then one
guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the §6 personality curve —
  regard/mood deltas, arousal bump for intimate concepts, mindNote refresh, and the
  optional **feeling proposal** ([state.md](state.md) §Emotional weather: label + cause only; intensity
  derives from the curve's move). Degrades to drift-only state. Skipped for
  `continue` beats and narrator-mode inputs (no player act to react to — §Narrator
  input).
- **Archivist-lite** (`runChatArchivist`): one call emitting ten fields — the episode
  summary, `FactDraft[]`, next-turn `memoryQueries`, `attributeChanges` (applied through
  the `overlaySourceMayChange` inherent-trait guard), `openLoops` (the full ≤3 list
  each time, prior loops fed back through the prompt; a **degraded** archivist keeps the
  prior loops rather than wiping them), the optional `scene` proposal merged into
  `scene_memory` ([state.md](state.md) §Scene memory), the optional `cast` proposals merged into
  `supporting_cast` ([supporting-cast.md](supporting-cast.md) §Supporting cast; roster/player names excluded), the roster-gated
  `presence` transitions ([multi-character.md](multi-character.md) §Multi-character), `driveUpdates` ([state.md](state.md) §Drives), and the optional
  `outfit` change (chat-scene-fidelity
  slice 1): a full-replacement description + `exposed` flag when the exchange dressed,
  changed, or undressed the character, folded into `state.outfit`/`outfitExposed` — which
  the wearing-line and the scene image's authoritative outfit override both read. Since
  ux-improvements slice 8.3, a proposal that **names an authored outfit preset**
  ("changes into her work clothes" → the "Work" preset — `matchOutfitPresetInText`,
  conservative: exact name or name + outfit-word) writes that preset's id-join marker
  instead of the paraphrase, so she dresses in the actual authored garments. The
  seed falls back to the character's **default outfit preset** (`profile.outfits[0]`)
  when Starting Outfit is blank — but presets hold item **ids**, and the pure
  `seedChatState` can't resolve them, so it writes them as a **marker** that every
  IO-capable consumer (exchange pipeline, prompt preview, scenario GET/PATCH/action,
  time-skip) swaps for the readable garment phrase (any preset's marker resolves)
  via `resolveSeededOutfit` → `defaultOutfitPhrase` (occlusion-filtered,
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
  back with them). One carve-out: the **supporting cast never rolls back**
  (`rollbackScenario` keeps the live list — accrete-only + author-curated between takes;
  see [supporting-cast.md](supporting-cast.md)). `loadPreExchangeState` is three-valued: a recorded `{}` is the
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


## Reply failures

A reply that never arrives is **classified and persisted, never guessed at**. The
plain-text token stream has no error frame — once the route commits its 200, the
only in-band signal the client can see is "zero bytes, clean close" — so the cause
travels out-of-band instead:

1. `streamExchange`'s catch classifies the thrown provider error
   (`classifyProviderError`, `server/ai/errors.ts`): it unwraps the AI SDK's
   `RetryError`, reads `APICallError.statusCode` + the OpenRouter error envelope in
   `responseBody`, and maps them onto the closed `ChatReplyFailureCode` vocabulary
   (`contracts/turns/chat-reply-failure.ts`) — timeout, rate_limited, no_credits,
   auth_failed, moderation_blocked, context_too_long, provider_error, network,
   empty_reply, unknown. The same call feeds the `log.warn`, so `fly logs` shows the
   class, status, and the provider's own words (previously only `error.message`).
2. `resolveReplyFailure` (pure) decides what the exchange records: only a
   **zero-text** settle records a failure (a partial that persisted is a visible
   reply); a watchdog trip outranks the stop flag it shares an AbortController with
   (`timeout`); a genuine player Stop records nothing; a clean zero-token stream is
   `empty_reply`.
3. The verdict is written to `character_chats.last_reply_failure` (cleared by any
   exchange that settles) **before the generator returns**, so the route's drain —
   and therefore the client's post-exchange refetch — strictly follows it.
4. The transcript GET returns it on the `chat` envelope; the client's
   zero-tokens-received path hands it to `replyFailureToast`
   (`components/chat/reply-failure.ts`), which maps each class to its own copy
   (quoting the provider's words where they add signal) with a 10-minute staleness
   guard. No record ⇒ honest "no cause recorded" copy.

Adding a failure class = a literal in the contract + a copy entry in the client map
(registry pattern — never a migration; unknown stored codes parse to `unknown`).

## Jobs

| Type | Path | Recovery |
| --- | --- | --- |
| `chat_summary` | engine queue (`enqueueChatSummary`), detached (`session_id` NULL); folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock` | heartbeated while running; a dead row is failed by the detached-job sweep |
| `chat_scene_sketch` | engine queue (`enqueueChatSceneSketch`), detached; expands a just-introduced place into a visual sketch on `scene_memory` ([state.md](state.md) §Scene memory step 4) — write is an optimistic CAS, never the exchange lock; one live job per chat | same detached sweep; a lost CAS or failed run simply re-fires while the place's sketch stays absent |
| `chat_look_image` | engine queue (`enqueueChatLookImage`, fired by the finalizer on an outfit/appearance change), detached; mints the outfit-true look anchor ([images.md](images.md) §Scene reference anchors) — image-active chats only, keep-latest | same sweep; a failed mint leaves renders on the avatar and the next change re-fires |
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

