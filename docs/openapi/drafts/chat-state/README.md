# Chat state API split — draft target

> **Status: proposed design, not the currently implemented HTTP contract.**
>
> The YAML files in this directory are implementation targets for refactoring the existing
> `GET/PATCH /api/chats/:chatId/state` surface. The implemented API remains documented in
> `../../chats.yaml` until the code has migrated.

## Why split this surface

The persistence model is already divided correctly:

- `ChatState` is per roster character and persists on `character_chat_state`.
- `ChatScenario` is chat-wide and persists on `character_chats`.
- garment instances are chat-wide scenario truth, with per-character/player worn ids as projections.

The current state route flattens those owners into one PATCH contract. A request can therefore
mutate participant psychology, relationship state, wardrobe, scenario authoring, player identity,
and engine/inspector bookkeeping at once. `editChatState` then loads and writes both stores even
when a caller only intended to edit one side.

These draft contracts split **write authority and intent** while deliberately preserving the
existing storage model, rollback anchors, and engine semantics.

## Proposed documents

| Draft | Proposed resource | Owns |
| --- | --- | --- |
| `scenario.yaml` | `/api/chats/{chatId}/scenario` | premise, chat-wide social cards, scene-render preferences, supporting cast, plans, legacy calendar anchor |
| `participant-state.yaml` | `/api/chats/{chatId}/participants/{characterId}/state` | live per-character relationship override, meters, conditions, mind note, whereabouts |
| `wardrobe.yaml` | participant + player wardrobe resources | worn sets, preset selection, free-text overlay, garment operations/readouts |
| `player-state.yaml` | `/api/chats/{chatId}/player-state` | the selected player persona; persona changes reset that player's wardrobe atomically |
| `inspector-state.yaml` | admin self-inspector participant state | engine-owned/debug fields that should not be part of an ordinary player mutation contract |

`PATCH /api/chats/{chatId}/participants/{characterId}` remains the presence toggle. The existing
`GET/PUT /api/chats/{chatId}/relationships` matrix remains the authored roster-relationship
surface. The participant-state draft keeps the Character Sheet's current exact live scalar
(`regard`/`familiarity`) override; a later relationship-specific cleanup can consolidate that
without blocking this split.

## Current field → target owner

| Current `/state` edit field | Target |
| --- | --- |
| `premise` | scenario |
| `activeSocialCards` | scenario |
| `sceneAuto`, `sceneModel` | scenario |
| `supportingCast`, `plans` | scenario |
| `calendarStart` | scenario for the legacy chat clock; successor-world calendar authority remains world-owned |
| `regard`, `familiarity`, `relationship` | participant state (exact live override) |
| `mindNote`, `meters`, `conditions`, `whereabouts` | participant state |
| `wornItemIds`, `outfitPresetId`, `outfit`, `outfitExposed`, `garmentOperations` | participant wardrobe |
| `playerState.personaId` | player state |
| `playerState.wornItemIds`, `playerState.seeded`, `playerState.outfitPresetId`, `playerState.overlay` | player wardrobe; callers no longer replace the raw `playerState` object |
| `openLoops`, `memoryQueries`, `surfacedCues`, `attributeOverlays` | inspector state |
| `callbackHistory`, `feeling`, `selfieHistory`, `drives` | inspector state unless/until a dedicated feature API owns them |
| `presence` (`editChatState` internal caller) | existing participant PATCH |
| `sceneMemory`, `traitOverlays`, `voiceExemplars` (`editChatState` supports them but public `/state` does not) | engine/internal or inspector only |

## Design rules carried by all drafts

1. **Focused writes must not write unrelated stores.** A scenario-only PATCH must not seed or
   persist a participant row. A participant-state PATCH must not rewrite the scenario.
2. **Keep the aggregate read model during migration.** `GET /api/chats/{chatId}/state` is useful
   to the current UI and may remain temporarily as a read-only compatibility projection while
   writes move to focused resources. Removing the giant PATCH is the first goal; forcing the UI
   into many reads is not.
3. **Preserve chat-busy protection.** Existing finalizers save full stored objects, so author
   edits continue to return `409 chat_busy` while an exchange can clobber them. A later
   persistence refactor may replace this with field-level/versioned concurrency.
4. **Respect successor authority instead of accepting no-op writes.** World-owned primary
   meters/relationship scalars and wardrobe must either dispatch to a real world command or be
   rejected explicitly. The drafts choose explicit `409` responses where no world authoring
   command exists.
5. **Wardrobe remains one material truth.** Garment-store reconciliation and ordered garment
   operations stay one service transaction; the API split must not create a second wardrobe
   authority.
6. **Debug mutation is not ordinary gameplay API.** Engine carry-over fields move behind the
   existing admin/self inspector authorization model instead of remaining writable on a normal
   owner route.
7. **No storage migration is required merely to split these routes.** The first implementation
   can delegate to narrower service functions over the same `ChatState`/`ChatScenario` stores.

## Suggested implementation order

1. Extract focused server services from `editChatState`: scenario edit, participant-state edit,
   participant/player wardrobe edit, and player-persona edit. Keep `editChatState` as a legacy
   adapter while callers migrate.
2. Add the proposed routes and integration tests, including `chat_busy`, roster ownership,
   seed-on-write, rollback preservation, and successor-authority cases.
3. Move Scenario modal + calendar + scene-profile callers to `scenario` and `player-state`.
4. Move Character Sheet core fields to `participant-state`; move its wardrobe controls to
   `wardrobe`; keep presence on the existing participant route.
5. Move admin-only engine fields/readouts to the self-inspector resource.
6. Make legacy `PATCH /state` a compatibility adapter/deprecated surface, then remove it when no
   callers remain. Keep or retire aggregate `GET /state` separately based on read-performance/UI
   needs.
7. Promote these contracts out of `drafts/`, update `chats.yaml`, and add OpenAPI validation in CI.

## Source seams to preserve

- `apps/web/src/app/api/chats/[chatId]/state/route.ts`
- `apps/web/src/server/engine/chat-state/edit.ts`
- `apps/web/src/server/engine/chat-state/types.ts`
- `apps/web/src/server/engine/chat-state/store.ts`
- `apps/web/src/contracts/players/chat-player-state.ts`
- `apps/web/src/components/characters/chat-state-tools.tsx`
- `apps/web/src/components/characters/chat-scenario-modal.tsx`
