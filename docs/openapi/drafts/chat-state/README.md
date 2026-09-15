# Chat state API split — promoted

The issue #601 chat-state split is now implemented. The former draft contracts in this directory were promoted to [`../../chat-state/`](../../chat-state/).

Use the implemented contracts there for the scenario, participant-state, wardrobe, player-state, and admin self-inspector resources. `GET /api/chats/{chatId}/state` remains as the aggregate compatibility read projection; its PATCH is deprecated and is no longer the first-party write path.
