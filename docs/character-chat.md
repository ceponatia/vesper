# Character chat

The sessionless 1-on-1 chat lane: talk to any saved library character directly — no world,
no session, location conveyed only through narration. Since slice 3 of the standalone arc,
the unit is a **conversation** (`character_chats`): one character can host many
conversations (a main story beside a fresh alternate universe), each with its own
transcript, rolling summary, and per-participant state, and a **memory group** deciding
what carries across (see §Memory below). It began as a voice-tuning test-bed
and is now a **primary feature** (shipped — see
[developer-notes/finished/character-chat-standalone.plan.md](developer-notes/finished/character-chat-standalone.plan.md);
current direction is the relationship-model v2 and multi-character chat work):
it carries its own tracked state, long-term RAG memory, evolving attributes, scenario
system, a stage-driven relationship arc, in-game time, and scene images. It is deliberately **not** a session: no locations, presence,
exposure mask, wardrobe state, story threads, or multi-character cast. (One seam has
opened toward that last point: a conversation can now be **created** with a roster of up
to 4 characters — `POST /api/chats` takes `characterIds`, `chat_participants` holds one
row per character, `sort 0` is the primary — but the exchange pipeline still runs 1-on-1
against the primary; the extra participants are inert groundwork for the multi-character
substrate in
[developer-notes/multi-character-chat.plan.md](developer-notes/multi-character-chat.plan.md).)
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
   `CHAT_REPLY_TAKES_CAP`). A player **Stop** aborts the model stream server-side; the
   accumulated prefix persists with `meta.stopped` and the fan-out runs over it.
3. **Window + summary.** The rolling summary covers everything up to its watermark; the
   verbatim window (`CHARACTER_CHAT_HISTORY_TURNS` = 40 exchanges) is everything after it.
   When the unsummarized tail reaches the fold trigger, a detached `chat_summary` job is
   enqueued fire-and-forget (§4).
4. **State drift.** `driftChatState` (pure): this exchange's within-visit tick on the
   chat-local clock (`CHAT_TICK_MINUTES`) — meters decay toward personalized baselines,
   clock-expired conditions drop. **No time passes between visits** (spec §8, D8 — the
   wall-clock model was removed outright): the only between-scene lever is a player
   **time skip** (`POST …/time-skip`), which advances the clock, expires conditions
   through the same filter, stamps a one-shot `pending_skip_note` (worded by regard band,
   `chatSkipNote`, with a "a life meanwhile" license), and records itself into the
   `skip_history` ring — **meters untouched** (D14, flavor-only v1). Lazily seeds from
   the authored defaults when no row exists.
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
   cue invite, beat instructions). The rules carry the **player-input perception
   partition** (quoted = heard, narration = seen, interiority = invisible) and the
   **player-POV narrator camera** (involuntary perception + light reflex writable, the
   player's agency not; attention-gated visual detail). See [prompts.md](prompts.md)
   §§Character-chat sensory cues / player-input perception / player-POV narration /
   state as a narration system / long-term memory, plus the regex-only one-turn
   cue (`engine/chat-intent.ts`).
7. **Stream.** `streamCharacterChat` — the same `streamText` + `openrouter().chat()` shape
   as the session narrator, through `stripNarratorArtifactStream`. The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list) — a headless POST without a `model` defaults to it too
   (`resolveChatModelId`), so API and UI agree.
8. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
   runs (§3). All of it is off the perceived-latency path.

## Tracked state

One `character_chat_state` row per **(chat, participant)** — PK `(chat_id, character_id)`: the full meter registry, the two
relationship axes (relationship-model v2: `regard` −100..100, the volatile feeling axis
that was `affinity`; `familiarity` 0..100, the moments+time ratchet with its
`familiarity_scene_gain` budget — trickle capped at `acquainted`, archivist facts push
past it, reset on a time skip) plus the authored `relationship_record` texture
(kind/history/`presented` mask/looming — `contracts/relationships/record.ts`),
self-expiring conditions, the `mindNote`, the per-chat scenario (premise, free-text outfit
+ exposed flag, active social cards), the anti-repetition `surfacedCues` bands, the RAG
carry-overs (`memoryQueries`, `open_loops` — the archivist's ≤3 "unfinished business"
phrases, re-emitted in full each exchange so resolved loops fall off; persisted narrative
`attributeOverlays`; `lastPulseTrace` / `lastMemoryTrace`), the relationship arc
(`relationship_history` — a ≤200 sample ring `{at, clockMinutes, regard, band, familiarity}`
appended when either axis moved; `milestones` — ≤100 of
`first_exchange` / `stage_up` / `stage_down` / `familiarity_up` / `strong_reaction` / `player_marked`),
the time model (`clock_minutes` — the **only** clock, D3/D8; `skip_history` ring ≤50;
one-shot `pending_skip_note`), and `scene_auto` (`"off" | "milestones"`, the slice-9
auto-scene toggle — text with headroom, never a boolean). `upsertChatState` is the
**one** column-list source shared by the guarded (mid-exchange) and unguarded
(author-edit) writers; `ChatStateEdit` covers every stored column (inspector-grade —
open loops, memory queries, surfaced cues, attribute overlays included). State is
inspected/edited through the State-tools modal ([ui.md](ui.md) §The conversation page).

## Post-turn fan-out

`finalizeChatState` runs **pulse ‖ archivist-lite** in parallel (`Promise.all`), then one
guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the §6 personality curve —
  regard/mood deltas, arousal bump for intimate concepts, mindNote refresh. Degrades to
  drift-only state. Skipped for `continue` beats (no player act to react to).
- **Archivist-lite** (`runChatArchivist`): one call emitting five fields — the episode
  summary, `FactDraft[]`, next-turn `memoryQueries`, `attributeChanges` (applied through
  the `overlaySourceMayChange` inherent-trait guard), and `openLoops` (the full ≤3 list
  each time, prior loops fed back through the prompt; a **degraded** archivist keeps the
  prior loops rather than wiping them). Its memory write is additionally fenced
  so an infra throw never costs the pulse's state. Every write is **provenance-stamped**
  (`source_message_id` on facts + episodes, spec §4.3): deleting or editing an assistant
  line retracts/re-extracts its memory (`reconcileMessageMemory` / `reextractEditedReply`),
  and "another take" rolls it back exactly.
- The finalizer also appends the **relationship arc** (`appendRelationshipSample` /
  `deriveExchangeMilestones`, `contracts/relationships/history.ts`), clears the one-shot
  skip note, and returns `{bigMoment}` — true on a regard-band crossing or strong reaction —
  which the route uses to queue an **auto scene** anchored to the reply when the chat's
  `scene_auto` is `"milestones"` (`queueChatScene`, deduped against live renders,
  fire-and-forget; a failed queue log-warns and never touches the settled reply). Caveat:
  a scene stays anchored to the message id it was queued for, so if "another take" later
  replaces that reply, the inline moment illustrates the superseded beat — acceptable.
- The finalizer also persists the **pre-exchange snapshot**
  (`character_chat_state.pre_exchange_state`) — the rollback anchor "another take"
  restores so a regenerated exchange never double-applies drift/pulse effects (the
  relationship samples/milestones it recorded roll back with it). `loadPreExchangeState`
  is three-valued: a recorded `{}` is the **first-exchange sentinel** (no prior state →
  the regenerate re-seeds from the authored defaults, exactly as the live first exchange
  did), a real state rolls back to it, and a **missing** row degrades to no-rollback with
  `chat_state.snapshot.missing` (followups F3). It is written under the **same
  prompting-message guard** as the paired state save, so a mid-stream delete can't split
  the two (F5). "First exchange" (the arc baseline + `first_exchange` milestone) keys on an
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
  only when no other conversation references it.

## API surface

All under `/api/chats` (ownership resolves through the chat row — `chats/owned.ts`
`loadOwnedChat`):

| Route | What |
| --- | --- |
| `GET /api/chats?characterId=&archived=1` · `POST /api/chats` | list conversations · create one (`memory: "shared" \| "fresh"` — the D7 choice) |
| `GET/POST/PATCH/DELETE /api/chats/:chatId` | transcript · one exchange (`kind: send \| open \| continue \| regenerate`; plain-text token stream; 409 `chat_archived` on an archived chat) · rename/archive/restore · hard delete |
| `POST /api/chats/:chatId/stop` | cut the in-flight reply short (spec §4.2 — the prefix persists with `meta.stopped`) |
| `PATCH/DELETE /api/chats/:chatId/messages/:messageId` | edit / snip one line — both reconcile the line's extracted memory (spec §4.3) |
| `PATCH /api/chats/:chatId/messages/:messageId/take` | make a recorded take the displayed reply (display-only; spec §4.1) |
| `GET/POST /api/chat-presets` · `DELETE /api/chat-presets/:id` | scenario presets (spec §1.5); `POST /api/chats {presetId}` seeds a new conversation from one. UI: Apply/Save-as/Delete preset in `chat-scenario-modal.tsx`, "Start from preset" in `new-chat-dialog.tsx` |
| `GET/PATCH/POST /api/chats/:chatId/state` | state snapshot (drift-on-read) · author edit (`ChatStateEdit`, every stored column) · action chip |
| `GET/POST /api/chats/:chatId/scene` | list **this chat's** scenes only (sibling chats / un-chat-keyed rows stay Gallery-only) · queue a `chat_scene_image` render via `queueChatScene` (409 `scene_busy` while one is live) |
| `POST /api/chats/:chatId/remember` | "remember this" (spec §6.4, D15): pin an `origin:"player"` fact — confidence 1, no message anchor, force-retrieved, never superseded by extraction ([memory.md](memory.md)) |
| `POST /api/chats/:chatId/time-skip` | `{amount: moments\|hours\|overnight\|days}` → `CHAT_SKIP_MINUTES`; clock + condition expiry + one-shot skip note + `skip_history`; meters untouched (D14) |
| `GET /api/chats/:chatId/relationship` | Relationship-panel payload: both axis bands + scalars, region label, texture, history samples, milestones, story-so-far, open loops |
| `POST /api/chats/:chatId/milestones` | "mark this moment": append a `player_marked` milestone on a message (label defaults to a line excerpt) |
| `POST /api/chats/:chatId/summary/rebuild` | `rebuildChatSummary` — reset + re-fold the rolling summary from the full transcript under the summary lock (heavy-write rate limited) |
| `GET /api/chats/:chatId/export?format=md\|json&memory=1` | transcript export — title, scenario, story-so-far, transcript, opt-in memory appendix |
| `/api/dev/chat-inspector/:chatId[/…]` | dev memory inspector family (spec §6.1; **404 in production**, owner-scoped): overview (all facts incl. superseded/retracted + episodes + summary) · facts create/PATCH (pin/retract/restore, re-embed-on-edit) · episodes PATCH/DELETE + `score?q=` · summary PATCH · prompt preview (`previewChatPrompt` — "what reaches the narrator") |

## Diagnostics

`chat_state.pulse` / `.degraded` / `.timeout` · `chat_archivist.extract` / `.degraded` /
`.timeout` · `chat_memory.episodes_failed` / `.facts_failed` ·
`memory.facts.embed_failed` / `memory.episodes.embed_failed` (a fused-retrieval
query-embedding failure — facts degrade to pinned-only, episodes to `[]`) ·
`chat_state.memory.write_failed` · `chat_state.attribute.unknown` /
`.inherent_change_rejected` · `chat_summary.fold` / `.degraded` / `.empty` · `chat_state.snapshot.missing` ·
`chat_memory.reconciled` — plus route
errors `chat_busy` (409), `chat_archived` (409), `scene_busy` (409), `rate_limited` (429),
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
| One-turn cue regex | `server/engine/chat-intent.ts` |
| System prompt | `server/engine/prompts/character-chat.ts` (+ `prompts/chat-archivist.ts`, `prompts/chat-state.ts`, `prompts/chat-summary.ts`) |
| Relationship block / band profiles | `contracts/relationships/law.ts` (`composeRelationshipLaw`, band profiles, corners) + `contracts/relationships/bands.ts` (axes) + `contracts/relationships/history.ts` (samples/milestones) |
| RRF fusion (pure) | `server/memory/fusion.ts` ([memory.md](memory.md)) |
| Scene image | `server/images/character-scene.ts` ([images.md](images.md) §state-aware chat scene); queue + anchor + dedupe in `app/api/chats/[chatId]/scene/queue.ts` (`queueChatScene`) |
| Dev inspector | `app/api/dev/chat-inspector/*` (routes) + `components/chat/chat-inspector-{page,facts,episodes}.tsx` behind `/chat/[chatId]/inspector` (admin-gated) |
| Retrieval eval harness | `scripts/eval/retrieval/` (`pnpm eval:retrieval` — never in `verify`; see its README) |
| UI — the conversation | `components/chat/chat-conversation.tsx` (full-screen `/chat/[chatId]`, [ui.md](ui.md) §The conversation page) + `components/chat/` (`chat-relationship-panel`, `chat-pickup-strip`, `chat-scene-moments`) + siblings in `components/characters/` (`chat-message`, `chat-scene-strip`, `chat-status`, `chat-state-tools`, `chat-scenario-modal`) |
| UI — editor Chat tab | `components/characters/character-chat.tsx` — a summary surface only (Chat defaults + conversation list), never the transcript |

History: the feature shipped across the `character-chat*` plan family (see
`developer-notes/finished/` and the roadmap's Shipped list); the shipped standalone plan lives in
[developer-notes/finished/character-chat-standalone.plan.md](developer-notes/finished/character-chat-standalone.plan.md).
Current direction is the relationship-model v2 and multi-character chat plans.
