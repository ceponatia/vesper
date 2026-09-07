# Issue 497 inventory receipt

Base: `968ef62ff00e4ea35b91ee5b516c8e6c47a0e851`

Searches refreshed at this base: `chat-state` filenames and module paths; every exported move-map symbol; all direct `./chat-state`, `@/server/engine/chat-state`, and engine-barrel imports; mocks; documentation and source comments naming the monolith, moved helpers, finalization, rollback, persistence, wardrobe, and enqueue behavior. The scoped server tree has no additional `AGENTS.md`.

## Proposed-owner census

| Census entry | Disposition |
| --- | --- |
| `chat-state/types.ts`; `chat-state/seed.ts` | **Updated** — data-only types and fresh seed factories moved to these owners; the façade explicitly re-exports them. |
| `chat-state/store.ts`; `chat-state/snapshots.ts` | **Handled by linked prerequisite #498** — load/save/persist and rollback storage remain in `chat-state.ts`. |
| `chat-state/time.ts`; `chat-state/pulse-rules.ts` | **Updated** — pure time, pulse, overlay, condition, clamp, and action rules moved to these owners. |
| `chat-state/pulse-agent.ts` | **Handled by linked prerequisite #499** — model invocation and degradation remain in `chat-state.ts`. |
| `chat-state/outfit-evidence.ts`; `chat-state/outfit-fold.ts` | **Handled by linked prerequisite #499** — evidence attribution and wardrobe folds remain in `chat-state.ts`. |
| `chat-state/finalize.ts`; `chat-state/ensemble.ts` | **Handled by linked prerequisite #500** — finalization and ensemble settlement remain in `chat-state.ts`. |
| `chat-state/edit.ts`; `chat-state/surface-transfer.ts`; `chat-state/readout.ts` | **Updated** for `readout.ts`; **handled by linked prerequisite #498** for edit and surface-transfer storage, which remain in `chat-state.ts`. |

## Documentation census

| File | Disposition |
| --- | --- |
| `docs/authoring/manual-editing.md` | **Updated** — rhythm auto-dress points to `chat-state/time.ts`. |
| `docs/character-chat/README.md` | **Updated** — the owner map separates the five pure modules from monolith IO/orchestration. Feeling, drives, ensemble, and supporting-cast references remain valid because their folds still live in the monolith pending #499/#500. |
| `docs/character-chat/agent-reasoning.md` | **Still valid** — covered model agents and telemetry remain in the monolith; #499/#500 own later extraction. |
| `docs/character-chat/api.md` | **Still valid** — `editChatState` stays in the monolith pending #498. |
| `docs/character-chat/images.md` | **Still valid** — the symbol name and opener-only fold law are unchanged; the façade remains the public entry. |
| `docs/character-chat/initiative.md` | **Still valid** — `loadMilestonesSeenAt` remains monolith IO. |
| `docs/character-chat/multi-character.md` | **Still valid** — `settleEnsembleMember` remains in the monolith pending #500. |
| `docs/character-chat/physical-legs.md` | **Still valid** — rollback storage remains in the monolith pending #498. |
| `docs/character-chat/pipeline.md` | **Still valid** — named pure behavior and ordering are unchanged, and callers continue through the stable façade; pipeline extraction belongs to #501. |
| `docs/character-chat/post-turn.md` | **Still valid** — finalization/extraction orchestration remains in the monolith pending #499/#500. |
| `docs/character-chat/prompts.md` | **Still valid** — finalization and model execution remain in the monolith pending #499/#500. |
| `docs/character-chat/scene-memory.md` | **Still valid** — `finalizeChatState` still owns the merge pending #500. |
| `docs/character-chat/state.md` | **Updated** — scenario seeding and snapshot readout point to their focused owners; load/save/edit remain correctly attributed to the monolith. |
| `docs/character-chat/supporting-cast.md` | **Still valid** — rollback/finalization remain in the monolith pending #498/#500. |
| `docs/character-chat/wardrobe.md` | **Still valid** — outfit folds/finalization remain in the monolith pending #499/#500. |
| `docs/contracts/meters.md` | **Still valid** — it names the contract-owned projection, not a physical chat-state owner. |
| `docs/images/pipelines/scene-images.md` | **Still valid** — `loadChatComposerModel` remains monolith IO. |

## Source-comment and test census

| File | Disposition |
| --- | --- |
| `apps/web/src/app/api/admin/chat-permissions/[chatId]/route.ts` | **Still valid** — `loadChatScenario` remains monolith IO. |
| `apps/web/src/app/api/chats/[chatId]/relationships/route.ts` | **Still valid** — `editChatState` remains pending #498. |
| `apps/web/src/app/api/chats/[chatId]/scene/queue.ts` | **Still valid** — rollback and composer-model persistence remain in the monolith. |
| `apps/web/src/app/api/chats/[chatId]/state/route.ts` | **Still valid** — `resolveSeededOutfit` remains in the monolith and routes still augment the snapshot with resolved garment labels. |
| `apps/web/src/app/api/chats/chat-state.int.test.ts` | **Still valid** — the comment concerns persisted state and rollback storage pending #498. |
| `apps/web/src/app/api/chats/route.ts` | **Still valid** — public snapshot shape and façade are stable. |
| `apps/web/src/contracts/items/garment-nouns.ts` | **Still valid** — outfit evidence/folds remain in the monolith pending #499. |
| `apps/web/src/contracts/items/outfit-change-evidence.test.ts` | **Still valid** — the higher-level validator remains in the monolith pending #499. |
| `apps/web/src/contracts/items/outfit-change-evidence.ts` | **Still valid** — `outfitChangeEvidenceValidated` remains in the monolith pending #499. |
| `apps/web/src/contracts/mood/projection.ts` | **Updated** — `applyChatAction` points to `chat-state/pulse-rules.ts`. |
| `apps/web/src/contracts/state/body-surface.ts` | **Still valid** — finalization remains in the monolith pending #500. |
| `apps/web/src/contracts/turns/chat-archivist.ts` | **Still valid** — finalization remains in the monolith pending #500. |
| `apps/web/src/contracts/turns/chat-pulse.ts` | **Updated** — the deterministic curve points to `chat-state/pulse-rules.ts`. |
| `apps/web/src/server/db/schema.ts` | **Still valid** — rollback storage remains in the monolith pending #498. |
| `apps/web/src/server/engine/chat-contact-reply.ts` | **Still valid** — finalization/persistence remain in the monolith pending #500. |
| `apps/web/src/server/engine/chat-contact.int.test.ts` | **Still valid** — it names unchanged seed behavior through the stable façade. |
| `apps/web/src/server/engine/chat-extraction-legs.int.test.ts` | **Still valid** — finalization folds remain in the monolith pending #499/#500. |
| `apps/web/src/server/engine/chat-memory-failure.int.test.ts` | **Still valid** — finalization guard behavior remains pending #500. |
| `apps/web/src/server/engine/chat-memory.ts` | **Still valid** — its comment explicitly says the downstream monolith fold is untouched; #499/#500 own it. |
| `apps/web/src/server/engine/chat-npc-scene-decision.ts` | **Still valid** — the comparison concerns the model-call recipe, which remains in the monolith pending #499. |
| `apps/web/src/server/engine/chat-pipeline.ts` | **Still valid** — storage/finalization entry points remain stable; pipeline prepare/settle extraction belongs to #501. |
| `apps/web/src/server/engine/chat-reference-enqueue.ts` | **Still valid** — the monolith finalizer still fires enqueue seams pending #500. |
| `apps/web/src/server/engine/chat-reference-images.ts` | **Still valid** — its cycle boundary is still against the monolith finalizer. |
| `apps/web/src/server/engine/chat-scene-sketch.ts` | **Still valid** — `finalizeChatState` remains in the monolith pending #500. |
| `apps/web/src/server/engine/chat-state.test.ts` | **Still valid** — the existing pure suite imports the stable façade and covers moved helpers without copied fixtures. |
| `apps/web/src/server/engine/chat-wardrobe.int.test.ts` | **Still valid** — finalization wardrobe folding remains pending #499/#500. |
| `apps/web/src/server/engine/chat-wardrobe.ts` | **Still valid** — `resolveSeededOutfit` stays in the monolith and the seed-history comment remains behaviorally true. |
| `apps/web/src/server/engine/visual-memory-store.ts` | **Still valid** — finalization guard semantics remain pending #500. |
| `apps/web/src/server/images/chat-look.ts` | **Still valid** — enqueue remains in the monolith finalizer pending #500. |
| `apps/web/src/server/test-support/chat-fixtures.ts` | **Still valid** — its deliberate relative façade import is preserved, avoiding the mocked engine barrel. |

## Refreshed dependencies and CI selection

- New leaves import only contract/lib owners, `chat-feeling.ts`, constants/prompts where required, and sibling `types.ts`; no leaf imports the `chat-state.ts` façade or engine barrel.
- `seedConditionEffects` and `clampMeters` moved with action rules but remain internal imports of the monolith edit path; they are not re-exported by the public façade.
- `chat-reference-images.test.ts` still mocks and imports monolith IO (`loadChatState`), so its mock does not move.
- Bash `case` patterns in `.github/workflows/ci.yml` match nested `chat-state/*.ts` under the `chat-*` exclusion because `*` spans `/`. Therefore these changes select the ordinary code jobs, including lint, static checks, and the pure test job that runs `chat-state.test.ts`; they do not select `engine integration` or Gate 1.
- `pnpm test:engine` does not list the legacy chat-state integration suites. A green ordinary CI run cannot prove the `app-int` suites, and no CI filter change is warranted for this pure extraction.
