# Character chat

The sessionless 1-on-1 chat lane: talk to any saved library character directly — no world,
no session, location conveyed only through narration. It began as a voice-tuning test-bed
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
(`app/api/characters/[id]/chat/route.ts`) is a thin parse → auth → stream shell. One
exchange:

1. **Lock.** A per-chat keyed lock (`engine/keyed-lock.ts`, key
   `chat_exchange:{owner}:{character}`) — a second concurrent submit gets a 409
   `chat_busy`. Held until the stream settles, released on every path.
2. **User line insert** with a pre-minted id — the guard row for the reply persist (§5).
   The opening beat (`open: true`, the "Prompt character" button) skips this; the model
   gets a synthetic, non-persisted cue instead.
3. **Window + summary.** The rolling summary covers everything up to its watermark; the
   verbatim window (`CHARACTER_CHAT_HISTORY_TURNS` = 40 exchanges) is everything after it.
   When the unsummarized tail reaches the fold trigger, a detached `chat_summary` job is
   enqueued fire-and-forget (§4).
4. **State drift.** `driftChatState` (pure): between-visit recovery toward rested +
   this exchange's within-visit tick on the chat-local clock. Lazily seeds from the
   authored defaults when no row exists.
5. **RAG recall.** `retrieveChatMemory` — cosine retrieval over the chat's own facts +
   episodes (`MemoryScope` `chat`, [memory.md](memory.md) §Memory keying), keyed on last
   turn's persisted `memoryQueries` + this input. Each leg degrades to `[]` with a
   diagnostic.
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

One `character_chat_state` row per (owner, character): the full meter registry, affinity,
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
  drift-only state.
- **Archivist-lite** (`runChatArchivist`): one call emitting the episode summary,
  `FactDraft[]`, next-turn `memoryQueries`, and `attributeChanges` (applied through the
  `overlaySourceMayChange` inherent-trait guard). Its memory write is additionally fenced
  so an infra throw never costs the pulse's state.
- Both legs race a shared timeout (`withGenerateTimeout`, `server/ai`) and run on the
  agent model. Every degradation is a diagnostic, never a failed reply — the reply already
  streamed.

## Jobs

| Type | Path | Recovery |
| --- | --- | --- |
| `chat_summary` | engine queue (`enqueueChatSummary`), detached (`session_id` NULL); folds the oldest verbatim exchanges into the rolling summary, serialized per chat via `withKeyedLock` | heartbeated while running; a dead row is failed by the detached-job sweep |
| `chat_scene_image` | api-side `startJob` from `chat/scene/route.ts` (in-process, no heartbeat) | `sweepDetachedApiJobs` (`engine/recovery.ts`) fails any session-less running job whose heartbeat is older than `API_JOB_STALE_MS` |

## Persistence guards

- **Reply persist** (`persistAssistantReply`): atomic `INSERT … SELECT … WHERE EXISTS`
  keyed on the prompting user line, so a Clear Chat or message delete landing mid-stream
  can't resurrect an orphan reply.
- **State write** (`saveChatState`): same guard shape, keyed on the same row.
- **Clear Chat** (`clearCharacterChat`): one transaction deleting transcript + summary +
  state + chat-scoped facts/episodes + the scene-image prompt scrub (assets survive).

## API surface

All under `/api/characters/:id/chat` (owner-scoped via `loadOwnedCharacter`):

| Route | What |
| --- | --- |
| `GET /chat` · `POST /chat` · `DELETE /chat` | transcript · one exchange (plain-text token stream; `open` = opening beat) · Clear Chat |
| `PATCH/DELETE /chat/:messageId` | edit / snip one line (the poisoned-window recovery levers) |
| `GET/PATCH/POST /chat/state` | state snapshot (drift-on-read) · author edit · action chip |
| `GET/POST /chat/scene` | list chat scenes · queue a `chat_scene_image` render |

## Diagnostics

`chat_state.pulse` / `.degraded` / `.timeout` · `chat_archivist.extract` / `.degraded` /
`.timeout` · `chat_memory.episodes_failed` / `.facts_failed` ·
`chat_state.memory.write_failed` · `chat_state.attribute.unknown` /
`.inherent_change_rejected` · `chat_summary.fold` / `.degraded` / `.empty` — plus route
errors `chat_busy` (409), `rate_limited` (429), `not_found` (404). Degradation tests
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
| UI | `components/characters/character-chat.tsx` + siblings ([ui.md](ui.md) Chat tab) |

History: the feature shipped across the `character-chat*` plan family (see
`developer-notes/finished/` and the roadmap's Shipped list); current direction lives in
[developer-notes/character-chat-standalone.plan.md](developer-notes/character-chat-standalone.plan.md).
