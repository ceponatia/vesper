# Character chat

The sessionless 1-on-1 chat lane: talk to any saved library character directly — no world,
no session, location conveyed only through narration. Since slice 3 of the standalone arc,
the unit is a **conversation** (`character_chats`): one character can host many
conversations (a main story beside a fresh alternate universe), each with its own
transcript, rolling summary, and per-participant state, and a **memory group** deciding
what carries across (see §Memory below). It began as a voice-tuning test-bed
and is now a **primary feature** (and the current product focus — see
[developer-notes/character-chat-standalone.plan.md](developer-notes/character-chat-standalone.plan.md)):
it carries its own tracked state, long-term RAG memory, evolving attributes, scenario
system, and scene images. It is deliberately **not** a session: no locations, presence,
exposure mask, wardrobe state, story threads, or multi-character cast. Where the two lanes
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
4. **State drift.** `driftChatState` (pure): between-visit recovery toward rested +
   this exchange's within-visit tick on the chat-local clock. Lazily seeds from the
   authored defaults when no row exists.
5. **RAG recall.** `retrieveChatMemory` — cosine retrieval over the participant's
   **memory group** (`MemoryScope` `{kind:"chat", groupId}`, [memory.md](memory.md)
   §Memory keying), keyed on last turn's persisted `memoryQueries` + this input.
   Shared-history conversations share a group; fresh starts are islands. Each leg
   degrades to `[]` with a diagnostic.
6. **Prompt build.** `buildCharacterChatSystemPrompt` (pure, snapshot-tested) — see
   [prompts.md](prompts.md) §§Character-chat sensory cues / state as a narration system /
   long-term memory, plus the regex-only one-turn cue (`engine/chat-intent.ts`).
7. **Stream.** `streamCharacterChat` — the same `streamText` + `openrouter().chat()` shape
   as the session narrator, through `stripNarratorArtifactStream`. The narrator model is
   the per-character pick (`characters.chatModel`, resolved through the strict curated
   list).
8. **Settle (post-flush).** When the stream finishes — the route's shared
   `drainingStreamResponse` keeps consuming after a client disconnect
   ([resilience.md](resilience.md) §5) — the reply persists (§5) and the post-turn fan-out
   runs (§3). All of it is off the perceived-latency path.

## Tracked state

One `character_chat_state` row per **(chat, participant)** — PK `(chat_id, character_id)`: the full meter registry, affinity,
self-expiring conditions, the `mindNote`, the per-chat scenario (premise, free-text outfit
+ exposed flag, active social cards), the anti-repetition `surfacedCues` bands, the RAG
carry-overs (`memoryQueries`, persisted narrative `attributeOverlays`, `lastPulseTrace` /
`lastMemoryTrace`), and the chat-local clock. `upsertChatState` is the **one** column-list
source shared by the guarded (mid-exchange) and unguarded (author-edit) writers. State is
inspected/edited through the State-tools modal ([ui.md](ui.md) Chat tab).

## Post-turn fan-out

`finalizeChatState` runs **pulse ‖ archivist-lite** in parallel (`Promise.all`), then one
guarded state write:

- **Pulse** (`runChatPulse`): classifies the exchange onto the §6 personality curve —
  affinity/mood deltas, arousal bump for intimate concepts, mindNote refresh. Degrades to
  drift-only state. Skipped for `continue` beats (no player act to react to).
- **Archivist-lite** (`runChatArchivist`): one call emitting the episode summary,
  `FactDraft[]`, next-turn `memoryQueries`, and `attributeChanges` (applied through the
  `overlaySourceMayChange` inherent-trait guard). Its memory write is additionally fenced
  so an infra throw never costs the pulse's state. Every write is **provenance-stamped**
  (`source_message_id` on facts + episodes, spec §4.3): deleting or editing an assistant
  line retracts/re-extracts its memory (`reconcileMessageMemory` / `reextractEditedReply`),
  and "another take" rolls it back exactly.
- The finalizer also persists the **pre-exchange snapshot**
  (`character_chat_state.pre_exchange_state`) — the rollback anchor "another take"
  restores so a regenerated exchange never double-applies drift/pulse effects. A missing
  snapshot degrades to no-rollback with `chat_state.snapshot.missing`.
- Both legs race a shared timeout (`withGenerateTimeout`, `server/ai`) and run on the
  agent model. Every degradation is a diagnostic, never a failed reply — the reply already
  streamed.

## Jobs

| Type | Path | Recovery |
| --- | --- | --- |
| `chat_summary` | engine queue (`enqueueChatSummary`), detached (`session_id` NULL); folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock` | heartbeated while running; a dead row is failed by the detached-job sweep |
| `chat_scene_image` | api-side `startJob` from `chats/[chatId]/scene/route.ts` (in-process, no heartbeat) | `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any session-less running job whose heartbeat is older than `API_JOB_STALE_MS` |

## Persistence guards

- **Reply persist** (`persistAssistantReply`): atomic `INSERT … SELECT … WHERE EXISTS`
  keyed on the prompting user line, so a Clear Chat or message delete landing mid-stream
  can't resurrect an orphan reply.
- **State write** (`saveChatState`): same guard shape, keyed on the same row.
- **Delete** (`deleteChat` — the one destructive verb; **archive** via `PATCH
  {archived:true}` is the everyday shelve/restore action): one transaction — the chat
  row's FK cascades take transcript + summary + participants + state; the scene-image
  prompt scrub runs (assets survive); the memory group is purged only when no other
  conversation references it.

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
| `GET/PATCH/POST /api/chats/:chatId/state` | state snapshot (drift-on-read) · author edit · action chip |
| `GET/POST /api/chats/:chatId/scene` | list chat scenes · queue a `chat_scene_image` render |

## Diagnostics

`chat_state.pulse` / `.degraded` / `.timeout` · `chat_archivist.extract` / `.degraded` /
`.timeout` · `chat_memory.episodes_failed` / `.facts_failed` ·
`chat_state.memory.write_failed` · `chat_state.attribute.unknown` /
`.inherent_change_rejected` · `chat_summary.fold` / `.degraded` / `.empty` · `chat_state.snapshot.missing` ·
`chat_memory.reconciled` — plus route
errors `chat_busy` (409), `chat_archived` (409), `rate_limited` (429), `not_found` (404). Degradation tests
assert the fallback **and** the code ([testing.md](testing.md)).

## Where things live

| Concern | File |
| --- | --- |
| Exchange orchestration | `server/engine/chat-pipeline.ts` |
| Model stream | `server/engine/character-chat.ts` |
| State (drift/pulse/persist) | `server/engine/chat-state.ts` |
| RAG client (recall/archivist/write) | `server/engine/chat-memory.ts` |
| Rolling summary + fold job | `server/engine/chat-summary.ts` |
| One-turn cue regex | `server/engine/chat-intent.ts` |
| System prompt | `server/engine/prompts/character-chat.ts` (+ `prompts/chat-archivist.ts`, `prompts/chat-state.ts`, `prompts/chat-summary.ts`) |
| Scene image | `server/images/character-scene.ts` ([images.md](images.md) §state-aware chat scene) |
| UI — the conversation | `components/chat/chat-conversation.tsx` (full-screen `/chat/[chatId]`, [ui.md](ui.md) §The conversation page) + siblings in `components/characters/` (`chat-message`, `chat-scene-strip`, `chat-status`, `chat-state-tools`, `chat-scenario-modal`) |
| UI — editor Chat tab | `components/characters/character-chat.tsx` — a summary surface only (Chat defaults + conversation list), never the transcript |

History: the feature shipped across the `character-chat*` plan family (see
`developer-notes/finished/` and the roadmap's Shipped list); current direction lives in
[developer-notes/character-chat-standalone.plan.md](developer-notes/character-chat-standalone.plan.md).
