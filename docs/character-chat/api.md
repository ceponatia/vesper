# API surface & diagnostics

The HTTP routes under `/api/chats` and the diagnostic codes the lane emits.

## API surface

All under `/api/chats` (ownership resolves through the chat row — `chats/owned.ts`
`loadOwnedChat`):

| Route | What |
| --- | --- |
| `GET /api/chats?characterId=&archived=1` · `POST /api/chats` | list conversations · create one (`memory: "shared" \| "fresh"` — the D7 choice) |
| `GET/POST/PATCH/DELETE /api/chats/:chatId` | newest transcript page (100 rows; `?before=<messageId>` keysets older pages, `hasMore`/`nextBefore` in the envelope — the UI's "Load earlier") · one exchange (`kind: send \| open \| continue \| regenerate \| rerun`; `rerun` takes `messageId` = the target user line; `send` may carry `attachmentIds` ≤4 — [images.md](images.md) §Player photos — and may be photo-only, and may carry `inputMode: "narrator"` — [supporting-cast.md](supporting-cast.md) §Narrator input; plain-text token stream; 409 `chat_archived` on an archived chat) · rename/archive/restore · hard delete |
| `POST /api/chats/:chatId/attachments` | upload ONE player photo (data URL in, `chat_upload` asset id back — [images.md](images.md) §Player photos); 409 on an archived chat, generation-rate-limited |
| `POST /api/chats/:chatId/participants` · `PATCH/DELETE …/participants/:characterId` | roster add (cap 4, D7 memory choice; seeds matrix pairs) · presence flip (through `editChatState`, 409 mid-stream) · remove (never the last; primary's heir promotes — [multi-character.md](multi-character.md) §Multi-character) |
| `GET/PUT /api/chats/:chatId/relationships` | the conversation's directed NPC↔NPC matrix + roster · upsert authored edges (band picks → live scalars; roster-validated — [multi-character.md](multi-character.md) §Multi-character) |
| `GET/PUT /api/characters/:id/relationships` | the character's library-default edges (the editor's Relationships tab; replace-set save; seeds new conversations) |
| `POST /api/chats/:chatId/stop` | cut the in-flight reply short (spec §4.2 — the prefix persists with `meta.stopped`) |
| `PATCH/DELETE /api/chats/:chatId/messages/:messageId` | edit / snip one line — both reconcile the line's extracted memory (spec §4.3) |
| `PATCH /api/chats/:chatId/messages/:messageId/take` | make a recorded take the displayed reply (display-only; spec §4.1) |
| `GET/POST /api/chat-presets` · `DELETE /api/chat-presets/:id` | scenario presets (spec §1.5); `POST /api/chats {presetId}` seeds a new conversation from one. UI: Apply/Save-as/Delete preset in `chat-scenario-modal.tsx`, "Start from preset" in `new-chat-dialog.tsx` |
| `GET/PATCH/POST /api/chats/:chatId/state` | state snapshot (drift-on-read; `?characterId=` targets any roster member — the per-character sheet, ruling 13) · author edit (`ChatStateEdit`, ONE patch surface — per-character fields to the target's row, chat-wide fields to the scenario — `premise` / `activeSocialCards` / `sceneMemory` / `supportingCast` / **`plans`** (the Plans panel's whole-list save, chat-plans-promises) / **`calendarStart`** (the clock card's "story starts on…" editor, chat-clock-calendar — rebases every derived date); `?characterId=` too) · action chip (primary). 409 `chat_busy` while a reply streams |
| `GET/POST /api/chats/:chatId/scene` | list **this chat's** scenes only (sibling chats / un-chat-keyed rows stay Gallery-only) plus `rendering` — true while a `chat_scene_image` job is live (`hasLiveChatSceneJob`), which is what keeps the client polling through the composer step *before* the pending image row exists · queue a render via `queueChatScene` (409 `scene_busy` while one is live). The render honors the chat's `sceneModel` pick (`character_chats.scene_model` — the shared scenario; saved on select from the strip's dropdown via the state PATCH, or the Scenario modal's select): `"reference"` = the identity-locked avatar edit; a t2i key = a style hot-swap rendered without the avatar ([images.md](../images.md) §Scene images) |
| `POST /api/chats/:chatId/remember` | "remember this" (spec §6.4, D15): pin an `origin:"player"` fact — confidence 1, no message anchor, force-retrieved, never superseded by extraction ([memory.md](../memory.md)) |
| `POST /api/chats/:chatId/time-skip` | `{amount: moments\|hours\|overnight\|days}` → `CHAT_SKIP_MINUTES` (now on the contract, `contracts/turns/chat-skip.ts`); the SHARED scenario clock + skip note (worded by the primary's band, naming the calendar landing) + `skip_history`, then each PRESENT member's condition expiry / scene-budget reset / feeling decay / rhythm auto-dress (real weekday via `calendar_start`); meters untouched (D14). The snapshot's `calendarStart` lets the client name the landing ("It's now Friday evening"). A qualifying skip (cumulative ≥ 1 story day since the last pass) also fires the detached **meanwhile pass** (`chat_meanwhile` job — chat-offscreen-life) |
| `GET /api/chats/:chatId/relationship` | Relationship-panel payload: both axis bands + scalars, region label, texture, history samples, milestones, story-so-far, open loops |
| `POST /api/chats/:chatId/milestones` | "mark this moment": append a `player_marked` milestone on a message (label defaults to a line excerpt) |
| `POST /api/chats/:chatId/summary/rebuild` | `rebuildChatSummary` — reset + re-fold the rolling summary from the full transcript under the summary lock (heavy-write rate limited) |
| `GET /api/chats/:chatId/export?format=md\|json&memory=1` | transcript export — title, scenario, story-so-far, transcript, opt-in memory appendix |
| `/api/admin/chat-inspector/:chatId[/…]` | memory inspector family (spec §6.1; **admin-role-gated — 404 for non-admins**, so it works on the deployed build; owner-scoped): overview (all facts incl. superseded/retracted — each labeled with its `channel`: `perceived`/`private`/`ooc`, the RAG visibility fence, [memory.md](../memory.md) §Fact channel — plus episodes + summary) · facts create/PATCH (pin/retract/restore, re-embed-on-edit) · episodes PATCH/DELETE + `score?q=` · summary PATCH · prompt preview (`previewChatPrompt` — "what reaches the narrator") |


## Diagnostics

Every leg failure below is ALSO recorded durably and tallied with a suspected cause — see
[../resilience.md](../resilience.md) §Agent-failure telemetry and the inspector's **Agent
health** panel (`GET /api/admin/chat-inspector/[chatId]/agent-failures`, admin-only). A
transport failure now emits `${leg}.api_error` (with the provider's class) instead of
mislabeling itself `${leg}.parse_failed`.

`chat_state.pulse` / `.degraded` / `.timeout` · the three extraction legs
(chat-agent-improvements slice 1b), each with its own `.extract` / `.timeout` /
`.api_error` / `.parse_failed`: `chat_memory_scribe.*` · `chat_continuity.*` · `chat_character_notes.*`
(one degraded leg costs only its own fields — see [pipeline.md](pipeline.md) §Post-turn
fan-out; `chat_archivist.degraded` still marks the demo-mode skip of all three) ·
`chat_personal_notes.*` (the ensemble's per-member pass) ·
`chat_memory.episodes_failed` / `.facts_failed` ·
`memory.queries.embed_failed` (the turn's shared query-embed batch — every leg then takes
its own degraded path) · `memory.facts.embed_failed` / `memory.episodes.embed_failed` (a
per-leg fused-retrieval embed failure — facts degrade to pinned-only, episodes to `[]`) ·
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
assert the fallback **and** the code ([testing.md](../testing.md)).

