# API surface & diagnostics

The HTTP routes under `/api/chats` and the diagnostic codes the lane emits.

## API surface

All under `/api/chats` (ownership resolves through the chat row — `chats/owned.ts`
`loadOwnedChat`):

| Route | What |
| --- | --- |
| `GET /api/chats?characterId=&archived=1` · `POST /api/chats` | list conversations · create one (`memory: "shared" \| "fresh"` — the D7 choice) |
| `GET/POST/PATCH/DELETE /api/chats/:chatId` | newest transcript page (100 rows; `?before=<messageId>` keysets older pages, `hasMore`/`nextBefore` in the envelope — the UI's "Load earlier") · one exchange (`kind: send \| open \| continue \| regenerate \| rerun`; `rerun` takes `messageId` = the latest exchange's user line; older targets return `rerun_requires_branch` without mutation; `send` may carry `attachmentIds` ≤4 — [images.md](images.md) §Player photos — and may be photo-only, and may carry `inputMode: "narrator"` — [supporting-cast.md](supporting-cast.md) §Narrator input; plain-text token stream; 409 `chat_archived` on an archived chat) · rename/archive/restore · hard delete |
| `POST /api/chats/:chatId/attachments` | upload ONE player photo (data URL in, `chat_upload` asset id back — [images.md](images.md) §Player photos); 409 on an archived chat, generation-rate-limited |
| `POST /api/chats/:chatId/participants` · `PATCH/DELETE …/participants/:characterId` | roster add (cap 4, D7 memory choice; seeds matrix pairs) · presence flip (through `editChatState`, 409 mid-stream) · remove (never the last; primary's heir promotes — [multi-character.md](multi-character.md) §Multi-character) |
| `GET/PUT /api/chats/:chatId/relationships` | the conversation's directed NPC↔NPC matrix + roster · upsert authored edges (band picks → live scalars; roster-validated — [multi-character.md](multi-character.md) §Multi-character) |
| `GET/PUT /api/characters/:id/relationships` | the character's library-default edges (the editor's Relationships tab; replace-set save; seeds new conversations) |
| `POST /api/chats/:chatId/stop` | cut the in-flight reply short (spec §4.2 — the prefix persists with `meta.stopped`) |
| `PATCH/DELETE /api/chats/:chatId/messages/:messageId` | edit / snip one line — both reconcile the line's extracted memory (spec §4.3) |
| `PATCH /api/chats/:chatId/messages/:messageId/take` | make a recorded take the displayed reply (display-only; spec §4.1) |
| `GET/POST /api/chat-presets` · `DELETE /api/chat-presets/:id` | scenario presets (spec §1.5); `POST /api/chats {presetId}` seeds a new conversation from one. UI: Apply/Save-as/Delete preset in `chat-scenario-modal.tsx`, "Start from preset" in `new-chat-dialog.tsx` |
| `GET/PATCH/POST /api/chats/:chatId/state` | state snapshot (drift-on-read; `?characterId=` targets any roster member — the per-character sheet, ruling 13) · author edit (`ChatStateEdit`, ONE patch surface — per-character fields to the target's row, chat-wide fields to the scenario — `premise` / `activeSocialCards` / `sceneMemory` / `supportingCast` / **`plans`** (the Plans panel's whole-list save, chat-plans-promises) / **`calendarStart`** (the clock card's "story starts on…" editor, chat-clock-calendar — rebases every derived date); `?characterId=` too) · action chip (primary). 409 `chat_busy` while a reply streams |
| `GET/POST /api/chats/:chatId/scene` | list **this chat's** scenes only (sibling chats / un-chat-keyed rows stay Gallery-only) plus `rendering` — true while a `chat_scene_image` job is live (`hasLiveChatSceneJob`), which is what keeps the client polling through the composer step *before* the pending image row exists · queue a render via `queueChatScene` (409 `scene_busy` while one is live). The chat's `sceneModel` pick (`character_chats.scene_model` — the shared scenario; saved on select from the strip's dropdown via the state PATCH, or the Scenario modal's select) is **reference-only since 2026-07-29** — the t2i style-swap keys left `chatSceneModels` (stored picks parse back to `reference`); every render is the identity-locked avatar edit ([images.md](../images.md) §Scene images) |
| `POST /api/chats/:chatId/remember` | "remember this" (spec §6.4, D15): pin an `origin:"player"` fact — confidence 1, no message anchor, force-retrieved, never superseded by extraction ([memory.md](../memory.md)) |
| `POST /api/chats/:chatId/time-skip` | `{amount: moments\|hours\|overnight\|days}` → `CHAT_SKIP_MINUTES` (now on the contract, `contracts/turns/chat-skip.ts`); the SHARED scenario clock + skip note (worded by the primary's band, naming the calendar landing) + `skip_history`, then each PRESENT member's condition expiry / scene-budget reset / feeling decay / rhythm auto-dress (real weekday via `calendar_start`); meters untouched (D14). The snapshot's `calendarStart` lets the client name the landing ("It's now Friday evening"). A qualifying skip (cumulative ≥ 1 story day since the last pass) also fires the detached **meanwhile pass** (`chat_meanwhile` job — chat-offscreen-life) |
| `GET /api/chats/:chatId/relationship` | Relationship-panel payload: both axis bands + scalars, region label, texture, history samples, milestones, story-so-far, open loops |
| `POST /api/chats/:chatId/milestones` | "mark this moment": append a `player_marked` milestone on a message (label defaults to a line excerpt) |
| `POST /api/chats/:chatId/summary/rebuild` | `rebuildChatSummary` — reset + re-fold the rolling summary from the full transcript under the summary lock (heavy-write rate limited) |
| `GET /api/chats/:chatId/export?format=md\|json&memory=1` | transcript export — title, scenario, story-so-far, transcript, opt-in memory appendix |
| `/api/admin/chat-inspector/:chatId[/…]` | memory inspector family (spec §6.1; **admin-role-gated — 404 for non-admins**, so it works on the deployed build; owner-scoped): overview (all facts incl. superseded/retracted — each labeled with its `channel`: `perceived`/`private`/`ooc`, the RAG visibility fence, [memory.md](../memory.md) §Fact channel — plus episodes + summary) · facts create/PATCH (pin/retract/restore, re-embed-on-edit) · episodes PATCH/DELETE + `score?q=` · summary PATCH · prompt preview (`previewChatPrompt` — "what reaches the narrator"; it re-derives the flag-gated legs from the stored cut so the bytes match a live turn's, contact leg included, and it OBEYS every flag because it is showing prompt bytes) · **affordance preview** (`previewChatAffordances` — the staged read: source inputs → structural profile → mechanics → observations or suppression reason → perception filtering → selected cue, per domain; READ-ONLY, computes on demand and stores nothing, and reports the `CHAT_AFFORDANCE_CUES` flag rather than obeying it) · **physical-guidance preview** (`previewChatPhysicalGuidance` — the constraint/premise staircase: input authority → committed state and per-owner availability → relevance → candidates with their disclosure, now including the **contact leg's resolved act** → what the gate and the budget kept → the rendered instruction; same READ-ONLY shape, reports `CHAT_PHYSICAL_CONSTRAINTS` **and** `CHAT_CONTACT_ACTIONS` rather than obeying either, and stores nothing — guidance is never persisted, and the contact leg's plan runs while its ledger append and scene fold deliberately do not, see [pipeline.md](pipeline.md) §Physical legs) |

**The `/self/` mirror.** The handlers live at `/api/admin/chat-inspector/:chatId/…`
but the inspector client (`src/lib/api-inspector.ts`) requests every panel through
`/api/admin/self/chat-inspector/:chatId/…`. Each mirrored path is a one-line
re-export twin (`export { GET } from "@/app/api/admin/chat-inspector/[chatId]/<name>/route"`)
under `src/app/api/admin/self/chat-inspector/[chatId]/`, so authorization lives in
exactly one place — the canonical handler's `withSelfOwnedChat`. **A new inspector
panel needs both files**: the canonical route alone type-checks, lints, and passes
its own tests while 404ing in the running app, which is how the physical-guidance
panel first shipped. `src/app/api/admin/self/chat-inspector/parity.test.ts` walks
both trees and fails on a canonical route without a twin, a twin without a
canonical route, or a twin that re-exports fewer verbs than the handler declares.


## Sim-routed dispatch (`POST /api/chats/:chatId`)

When a chat is routed to the successor engine (its `engine_authority` is past the
view threshold, branch-linked, and actor-mapped — the GET envelope's
`chat.simRouted` flag), the POST fork resolves authority **once, before kind
dispatch**: every operation has successor semantics or is refused, and the legacy
pipeline (`submitChatMessage`) is unreachable for it (presentation-charter.plan.md
§4; engine.spec.operations.md §39 rulings 18-19). The successor turn streams in the
same plain-text/heartbeat shape as a legacy reply and the client's post-exchange
transcript refetch reconciles the persisted rows.

| POST kind | Sim behavior | Response |
| --------- | ------------ | -------- |
| `send` | `runSimChatExchange` — land the player line, run input admission, advance the span, render a fresh cut, persist a new reply | heartbeat stream, prose |
| `continue` | Real turn with **no player utterance** (ruling 19): no user row, no admission, span still advances (time moves), render omits the player-turn block | heartbeat stream, prose |
| `open` | As `continue`, plus `simOpening` on the reply's `meta` (the opening-directive flag a later prompt slice reads) | heartbeat stream, prose |
| `regenerate` / `rerun` | **Re-render the SAME committed cut** (ruling 18): resolve the cut id from the last reply's `meta.cutId` (fallback `latestCutIdForEngagement`), re-render fresh prose, replace the reply row in place (content + browsable `takes` + meta). NO time advance, NO admission, NO new rows | heartbeat stream, prose |
| `action_beat`, or any kind with `action` set | **Refused** — legacy action chips have no successor semantics yet | 409 `sim_unsupported_operation` |
| any kind with `attachmentIds` | **Refused** — vision reads aren't wired to the sim lane yet | 409 `sim_unsupported_operation` |

The UI hides the attachment control and action chips for a sim-routed chat (a
hidden control beats a dead one that 409s); Continue / Regenerate / Go on / Prompt
stay visible and now run the successor semantics above. The kind→mode decision is
the pure `decideSimOperation` (`app/api/chats/[chatId]/sim-routing.ts`).


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
`chat_memory.reconciled` — plus route
errors `chat_busy` (409), `chat_archived` (409), `invalid_rerun_target` (400),
`rerun_requires_branch` (400; an older line cannot be safely rewritten through a
one-exchange state snapshot), `sim_unsupported_operation` (409; an attachment or
legacy action chip on a sim-routed chat — see §Sim-routed dispatch),
`scene_busy` (409), `rate_limited` (429), `not_found` (404). A failed `queueChatScene` (auto or manual) log-warns
(`chat_scene` scope) and returns null — never a failed exchange. Degradation tests
assert the fallback **and** the code ([testing.md](../testing.md)).

