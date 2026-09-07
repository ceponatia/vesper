# Character chat

The sessionless chat lane: the player talks to saved library characters directly — no
world, no session, location conveyed only through narration. The unit is a
**conversation** (`character_chats`): one character hosts many conversations (a main story
beside a fresh alternate universe), each with its own transcript, rolling summary, and
per-participant state, and a **memory group** deciding what carries across
([../memory.md](../memory.md) §Memory keying).

It is a primary feature, not a test harness: it carries its own tracked state, long-term
RAG memory, evolving attributes, a scenario system, a stage-driven relationship arc,
in-game time, structured wardrobe, and scene images. A conversation holds a **roster of up
to 4 full characters** ([multi-character.md](multi-character.md)) — narrative presence
instead of locations, one ensemble prompt frame, a per-conversation relationship matrix. It
carries **no** locations, exposure mask, or story threads.

Chat leads new interaction, state, and narration patterns; the **successor simulation
engine** ([../engine/README.md](../engine/README.md)) is the other live lane, reached
through the `/worlds` front door. Where a shared mechanism exists — memory scope, the
reaction curve, disposition rendering, narration shape, artifact stripping, the
generate-timeout race, the draining stream Response — there is **one implementation**, and
the chat lane must never re-fork it.

## Reading order

| Doc                                          | What it covers                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [pipeline.md](pipeline.md)                   | The exchange lifecycle (lock → kind → window → drift → recall → prompt → stream → settle) |
| [physical-legs.md](physical-legs.md)         | The optional contact, guidance and `romantic_touch` permission legs                       |
| [post-turn.md](post-turn.md)                 | The fan-out (pulse ‖ three extraction legs), the folds it writes, and the detached jobs   |
| [reply-failures.md](reply-failures.md)       | How a zero-token reply is classified, persisted, and surfaced                             |
| [prompts.md](prompts.md)                     | Prompt assembly: the cache split, the "Right now" digest, state-as-narration, RAG         |
| [narrator-craft.md](narrator-craft.md)       | Reply discipline, narration shape, viewpoint, dialogue tagging, output cleanup            |
| [perception-gates.md](perception-gates.md)   | The intimate gate, sensory allowance, physical consistency, the minor fence               |
| [state.md](state.md)                         | The per-character row and the chat-wide scenario, retake rollback, feeling, drives        |
| [wardrobe.md](wardrobe.md)                   | The wardrobe resolve seam, the garment store, the player's own wardrobe                   |
| [scene-memory.md](scene-memory.md)           | The narrator-imagined setting and its background sketch                                   |
| [plans.md](plans.md)                         | Commitments that come due on the story clock, whereabouts, the meanwhile pass             |
| [body-state.md](body-state.md)               | Scene environment and body surface: wetness, contact marks, deposits, transfer            |
| [affordance-cues.md](affordance-cues.md)     | The affordance read, its cue memory, and the garment domain                               |
| [visual-memory.md](visual-memory.md)         | Recognizable features and the narrator's own cue record                                   |
| [physical-guidance.md](physical-guidance.md) | Constraints and premise checks compiled from committed state                              |
| [supporting-cast.md](supporting-cast.md)     | Recurring named side characters, and the player↔narrator composer register                |
| [initiative.md](initiative.md)               | The character reaching out first, and unprompted "remember when" callbacks                |
| [multi-character.md](multi-character.md)     | The ensemble: roster, narrative presence, prompt frame, relationship matrix               |
| [images.md](images.md)                       | Player photos, character-sent selfies, and the look/place reference anchors               |
| [agent-reasoning.md](agent-reasoning.md)     | Admin-only per-chat reasoning profiles, budgets, rollback semantics, telemetry            |
| [api.md](api.md)                             | The `/api/chats` HTTP surface and the lane's diagnostic codes                             |

## Where things live

- **Exchange orchestration** — `server/engine/chat-pipeline.ts`; reply streaming, Stop, and watchdogs live in `server/engine/chat-reply-stream.ts`
- **Reply persistence, rerun cuts and take history** — `server/engine/chat-reply-store.ts`
- **Model stream** — `server/engine/character-chat.ts`
- **State types, seeds, time, pulse rules, and readout** — `server/engine/chat-state/{types,seed,time,pulse-rules,readout}.ts`; **state persistence, rollback, edits, and atomic surface settlement** — `server/engine/chat-state/{store,snapshots,edit,surface-transfer}.ts`; **pulse and finalization orchestration** — `server/engine/chat-state.ts`
- **RAG client (recall / the three extraction legs / write)** — `server/engine/chat-memory.ts`
- **Extraction field library + the composed legs** ([post-turn.md](post-turn.md)) — `server/engine/prompts/chat-extractors.ts` (pure) + the per-leg schemas / `mergeChatExtractions` in `contracts/turns/chat-archivist.ts`
- **Per-turn query-embedding cache (one embed, every leg)** — `server/memory/query-embeddings.ts`
- **Rolling summary + fold job + rebuild** — `server/engine/chat-summary.ts`
- **One-turn player-input reads (cue / scene movement / sensory focus / reply gates)** — `server/engine/chat-intent.ts`
- **Memory callbacks (gate / selection / ring)** — `server/engine/chat-callback.ts` (pure cue) + `retrieveChatCallback` in `chat-memory.ts` + `chatCallbackLine` in `prompts/character-chat/turn-notes.ts`
- **Emotional weather (feeling / momentum / bruise)** — `server/engine/chat-feeling.ts` (pure) + wiring in `chat-state.ts`; pacing in `lib/chat-pacing.ts`
- **Player photos (upload / claim / vision)** — `server/images/upload.ts` (`uploadChatAttachment`) + `asset-chat-files.ts` (`claimChatAttachments`/`deleteChatUploads`) + `server/engine/chat-vision.ts`; composer prep in `components/chat/attachment-file.ts`
- **Selfies (triggers / gates / retry)** — `server/engine/chat-selfie.ts` (pure) + pulse `sentPhoto` + `chatSelfieLine` in `prompts/character-chat/turn-notes.ts` + the selfie branch in `images/character-scene.ts`; "Failed" placeholder in `components/chat/chat-scene-moments.tsx`
- **Scene reference anchors (look / place)** — `server/images/chat-look.ts` (key + renders) + `server/engine/chat-reference-enqueue.ts` / `chat-reference-images.ts` (jobs) + consumption in `images/character-scene.ts` and `scene/queue.ts`
- **Drives (schemas / gate / updates)** — `contracts/personality/drives.ts` (pure registry) + `buildDrivesSection` in `prompts/character-chat/state-sections.ts` + the finalize fold in `chat-state.ts`
- **Initiative (the reopen opener)** — `server/engine/chat-initiative.ts` (pure cue) + the `initiative` flag through route/pipeline + the pickup-strip button
- **Multi-character (roster / ensemble / matrix)** — `app/api/chats/[chatId]/participants/*` + `…/relationships/route.ts` + `app/api/characters/[id]/relationships/route.ts`; `server/engine/chat-relationships.ts` (seed/load/upsert); roster selection in `prompts/character-chat.ts` and ensemble composition in `prompts/character-chat/ensemble.ts`; `mentionsCharacter`/`spokeInReply` in `chat-intent.ts`; the per-member personal pass (`runChatPersonalNotes` in `chat-memory.ts` + `prompts/chat-personal-notes.ts`) + `settleEnsembleMember` in `chat-state.ts`; UI in `components/chat/chat-roster-panel.tsx` + `chat-relationships-editor.tsx` + `components/characters/relationships-editor.tsx`
- **Scene memory (schema + merge + movement switch)** — `contracts/turns/chat-scene-memory.ts`
- **Supporting cast (schema + merge)** — `contracts/turns/chat-supporting-cast.ts` (pure) + `buildSupportingCastSection` in `prompts/character-chat/state-sections.ts` + the finalize merge in `chat-state.ts`; panel in `components/chat/chat-supporting-cast-panel.tsx`
- **Narrator input** — `wrapNarratorInput`/`narratorInputNote` in `prompts/character-chat/turn-notes.ts` + `inputMode` through route/pipeline (`meta.inputMode`) + the composer toggle in `chat-composer.tsx`
- **World beats (successor lane)** — a durable transcript trace of travel / time-skip / scene-ended events, `meta.worldBeat = { kind }` on an ordinary `role: "assistant"` row (no migration), the phrased line on `content`. Phrasing `apps/web/src/lib/simulation/world-beat.ts` (pure, `formatSimLanding` stamp — it stays in the app because the stamp bridges the story clock onto the chat lane's calendar); writer `writeWorldBeat` in `server/engine/sim-beats.ts` (fires from the sim-command route + admitted-NL-move seam); excluded from the narrator tail (`isWorldBeatMeta`); `MessageBubble` renders a muted system line
- **System prompt** — the public roster-selecting entry `server/engine/prompts/character-chat.ts` + its `character-chat/` composition and section owners (+ `prompts/chat-archivist.ts`, `prompts/chat-state.ts`, `prompts/chat-summary.ts`)
- **Life stage & minor fence** ([perception-gates.md](perception-gates.md)) — `contracts/world/life-stage.ts` (pure registry) + the identity hint and scoped `CONTENT_FRAMING` in `prompts/character-chat/single.ts` and `ensemble.ts`
- **Relationship block / band profiles** — `contracts/relationships/law.ts` (`composeRelationshipLaw`, band profiles, corners) + `contracts/relationships/bands.ts` (axes) + `contracts/relationships/history.ts` (samples/milestones)
- **RRF fusion (pure)** — `server/memory/fusion.ts` ([memory.md](../memory.md))
- **Scene image** — `server/images/character-scene.ts` ([images/pipelines/scene-images.md](../images/pipelines/scene-images.md)); queue + anchor + dedupe in `app/api/chats/[chatId]/scene/queue.ts` (`queueChatScene`)
- **Admin agent-reasoning experiment** — `lib/agent-reasoning.ts` + `server/ai/agent-reasoning.ts`; owner-admin API in `app/api/admin/agent-reasoning/[chatId]/route.ts`; selector in `components/chat/agent-reasoning-select.tsx`; attribution in `components/chat/chat-inspector-agent-health.tsx` ([agent-reasoning.md](agent-reasoning.md))
- **Admin inspector** — `app/api/admin/chat-inspector/*` (role-gated routes) + `components/chat/chat-inspector-{page,facts,episodes}.tsx` behind `/chat/[chatId]/inspector` (admin-gated)
- **Retrieval eval harness** — `scripts/eval/retrieval/` (`pnpm eval:retrieval` — never in `verify`; see its README)
- **UI — the conversation** — `components/chat/chat-conversation.tsx` (full-screen `/chat/[chatId]`, [ui/conversation.md](../ui/conversation.md)) + `components/chat/` (`chat-relationship-panel`, `chat-pickup-strip`, `chat-scene-moments`) + siblings in `components/characters/` (`chat-message`, `chat-scene-strip`, `chat-status`, `chat-state-tools`, `chat-scenario-modal`)
- **UI — editor Chat tab** — `components/characters/character-chat.tsx` — a summary surface only (Chat defaults + conversation list), never the transcript
