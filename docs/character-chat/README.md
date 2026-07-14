# Character chat

The sessionless chat lane: talk to saved library characters directly — no world,
no session, location conveyed only through narration. Since slice 3 of the standalone arc,
the unit is a **conversation** (`character_chats`): one character can host many
conversations (a main story beside a fresh alternate universe), each with its own
transcript, rolling summary, and per-participant state, and a **memory group** deciding
what carries across ([../memory.md](../memory.md) §Memory keying). It began as a voice-tuning test-bed
and is now a **primary feature** (shipped — see
[developer-notes/finished/character-chat-standalone.plan.md](../developer-notes/finished/character-chat-standalone.plan.md)):
it carries its own tracked state, long-term RAG memory, evolving attributes, scenario
system, a stage-driven relationship arc, in-game time, and scene images. Since 2026-07-12
a conversation can hold a **roster of up to 4 full characters**
([multi-character.md](multi-character.md) —
[developer-notes/multi-character-chat.plan.md](../developer-notes/finished/multi-character-chat.plan.md)):
narrative presence instead of locations, the one-block ensemble prompt frame, a
per-conversation relationship matrix. It remains deliberately **not** a session: no
locations, exposure mask, or story threads — but **wardrobe** reached full session parity
as the first test-bed step (chat-wardrobe-parity, shipped 2026-07-14: structured worn
item state, computed exposure via the session classifier, an equip/unequip Character sheet
— see [state.md](state.md) §Wardrobe and
[developer-notes/chat-wardrobe-parity.plan.md](../developer-notes/chat-wardrobe-parity.plan.md)).
**Direction (owner, 2026-07-13):** chat is the **test bed for what the
world/session model will eventually look like** — the lanes stay separate for
now, but the likely end-state deprecates the current world/session model in
favor of a successor grown from what chat proves out, with chat migrating onto
it (see `CLAUDE.md`).
Where the two lanes
share a mechanism (memory scope, the §6 reaction curve, disposition rendering, narration
shape, artifact stripping, the generate-timeout race, the draining stream Response), they
share **one implementation** — the chat lane must never re-fork session machinery.

## Reading order

| Doc | What it covers |
| --- | --- |
| [pipeline.md](pipeline.md) | The exchange lifecycle (lock → kind → window → drift → recall → prompt → stream → settle → render), the post-turn fan-out (pulse ‖ archivist), jobs, persistence guards |
| [state.md](state.md) | Tracked state (the per-character row + the chat-wide scenario), scene memory, emotional weather, drives |
| [supporting-cast.md](supporting-cast.md) | Recurring named side characters the narrator may play, and the player↔narrator composer register |
| [initiative.md](initiative.md) | The character reaching out first (the reopen opener) and unprompted "remember when" callbacks |
| [multi-character.md](multi-character.md) | The ensemble: the roster, narrative presence, the one-block prompt frame, the relationship matrix |
| [images.md](images.md) | Player photos (image input), character-sent selfies, and the look/place reference anchors |
| [api.md](api.md) | The `/api/chats` HTTP surface and the lane's diagnostic codes |

## Where things live

| Concern | File |
| --- | --- |
| Exchange orchestration | `server/engine/chat-pipeline.ts` |
| Model stream | `server/engine/character-chat.ts` |
| State (drift/pulse/persist) | `server/engine/chat-state.ts` |
| RAG client (recall / the three extraction legs / write) | `server/engine/chat-memory.ts` |
| Extraction **field library** + the composed legs ([pipeline.md](pipeline.md) §Post-turn fan-out) | `server/engine/prompts/chat-extractors.ts` (pure) + the per-leg schemas / `mergeChatExtractions` in `contracts/turns/chat-archivist.ts` |
| Per-turn query-embedding cache (one embed, every leg) | `server/memory/query-embeddings.ts` |
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
| Supporting cast (schema + merge — §Supporting cast) | `contracts/turns/chat-supporting-cast.ts` (pure) + `buildSupportingCastSection` in `prompts/character-chat.ts` + the finalize merge in `chat-state.ts`; panel in `components/chat/chat-supporting-cast-panel.tsx` |
| Narrator input (§Narrator input) | `wrapNarratorInput`/`narratorInputNote` in `prompts/character-chat.ts` + `inputMode` through route/pipeline (`meta.inputMode`) + the composer toggle in `chat-conversation.tsx` |
| System prompt | `server/engine/prompts/character-chat.ts` (+ `prompts/chat-archivist.ts`, `prompts/chat-state.ts`, `prompts/chat-summary.ts`) |
| Life stage & minor fence ([prompts.md](../prompts.md) §Life stage & the minor fence) | `contracts/world/life-stage.ts` (pure registry) + the identity hint / `buildLifeStageSection` / scoped `CONTENT_FRAMING` in `prompts/character-chat.ts`; session twin in `engine/scene.ts` (canonical-facts hint + the `buildIntimateDispositionLine` fence) |
| Relationship block / band profiles | `contracts/relationships/law.ts` (`composeRelationshipLaw`, band profiles, corners) + `contracts/relationships/bands.ts` (axes) + `contracts/relationships/history.ts` (samples/milestones) |
| RRF fusion (pure) | `server/memory/fusion.ts` ([memory.md](../memory.md)) |
| Scene image | `server/images/character-scene.ts` ([images.md](../images.md) §state-aware chat scene); queue + anchor + dedupe in `app/api/chats/[chatId]/scene/queue.ts` (`queueChatScene`) |
| Admin inspector | `app/api/admin/chat-inspector/*` (role-gated routes) + `components/chat/chat-inspector-{page,facts,episodes}.tsx` behind `/chat/[chatId]/inspector` (admin-gated) |
| Retrieval eval harness | `scripts/eval/retrieval/` (`pnpm eval:retrieval` — never in `verify`; see its README) |
| UI — the conversation | `components/chat/chat-conversation.tsx` (full-screen `/chat/[chatId]`, [ui.md](../ui.md) §The conversation page) + `components/chat/` (`chat-relationship-panel`, `chat-pickup-strip`, `chat-scene-moments`) + siblings in `components/characters/` (`chat-message`, `chat-scene-strip`, `chat-status`, `chat-state-tools`, `chat-scenario-modal`) |
| UI — editor Chat tab | `components/characters/character-chat.tsx` — a summary surface only (Chat defaults + conversation list), never the transcript |


History: the feature shipped across the `character-chat*` plan family (see
`developer-notes/finished/` and the roadmap's Shipped list); the shipped standalone plan lives in
[developer-notes/finished/character-chat-standalone.plan.md](../developer-notes/finished/character-chat-standalone.plan.md).
Current direction is the relationship-model v2 and multi-character chat plans.
