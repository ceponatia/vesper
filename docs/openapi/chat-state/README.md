# Focused chat-state HTTP resources

Status: **implemented** by issue #601.

The character-chat persistence model remains split between per-character `ChatState` and chat-wide `ChatScenario`; these HTTP resources now reflect those ownership boundaries instead of exposing one general mutation object.

| Contract | Resource | Authority |
| --- | --- | --- |
| `scenario.yaml` | `/api/chats/{chatId}/scenario` | chat-wide authoring state |
| `participant-state.yaml` | `/api/chats/{chatId}/participants/{characterId}/state` | ordinary per-character live state |
| `wardrobe.yaml` | participant + player wardrobe routes | garment-store-backed wardrobe state |
| `player-state.yaml` | `/api/chats/{chatId}/player-state` | selected player persona |
| `inspector-state.yaml` | `/api/admin/self/chat-inspector/{chatId}/participants/{characterId}/state` | admin/debug state |

`GET /api/chats/{chatId}/state` remains the aggregate UI/read projection during migration. Its PATCH is deprecated compatibility only: first-party writes are dispatched to the focused resources, inspector fields return `410 inspector_state_moved`, and successor-world-owned values cannot be shadow-written.

Presence remains on `PATCH /api/chats/{chatId}/participants/{characterId}`. The relationship matrix routes remain separate.

## Shared write rules

- Focused PATCHes retain the existing `409 chat_busy` guard.
- A scenario-only write never seeds a `character_chat_state` row.
- A participant-state write never saves `ChatScenario`.
- Persona changes reset the player wardrobe on the server only when the selected persona actually changes.
- Garment instances remain the single wardrobe authority; worn ids are projections and rejected operations are returned as diagnostics.
- Successor-routed primary meters, relationship scalars, wardrobe, and calendar authority cannot be changed through character-chat compatibility fields.
- Retake/regenerate snapshot and rollback persistence is unchanged; the refactor does not introduce a new storage model.
