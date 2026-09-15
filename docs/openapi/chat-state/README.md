# Focused chat-state HTTP resources

**Status: implemented by issue #601.**

These OpenAPI 3.1 contracts describe the focused mutation resources that replace first-party use of the historical mixed `PATCH /api/chats/{chatId}/state` endpoint.

The aggregate `GET /api/chats/{chatId}/state` remains as a compatibility read model for the conversation UI. Its PATCH operation is deprecated and is not used by first-party authoring surfaces. Engine/debug mutation is available only through the admin/self-inspector resource.

## Authority map

| Resource | Route | Owns |
| --- | --- | --- |
| Scenario | `/api/chats/{chatId}/scenario` | premise, active social cards, scene image settings, supporting cast, plans, calendar anchor |
| Participant state | `/api/chats/{chatId}/participants/{characterId}/state` | regard/familiarity, relationship texture, meters, conditions, mind note, whereabouts |
| Participant wardrobe | `/api/chats/{chatId}/participants/{characterId}/wardrobe` | character wardrobe projection + shared garment-store operations |
| Player wardrobe | `/api/chats/{chatId}/player/wardrobe` | player wardrobe projection + shared garment-store operations |
| Player state | `/api/chats/{chatId}/player-state` | persona selection; persona changes perform the wardrobe reset server-side |
| Inspector state | `/api/admin/chat-inspector/{chatId}/participants/{characterId}/state` | engine/debug carry-over and recovery fields; mirrored under `/api/admin/self/chat-inspector/...` |

## Invariants

- Scenario-only writes do not load, seed, or persist a participant state row.
- Participant-state writes do not rewrite scenario state.
- Participant wardrobe projection and the shared garment store commit together; garment operations remain ordered.
- Player persona switching owns its reset semantics on the server (`seeded=false`, empty worn list, cleared preset/overlay, old player garment instances retired).
- Successor-world-owned primary relationship scalars/meters, calendar state, and material wardrobe reject shadow writes with stable 409 codes.
- The existing `ChatState` / `ChatScenario` persistence and pre-exchange rollback model remains unchanged.
- All focused authoring routes preserve the existing `chat_busy` conflict behavior while a reply is in flight.
