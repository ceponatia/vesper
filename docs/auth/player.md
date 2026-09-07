# Who the player is

The player is a **library entity** — a `personas` row with a body, a wardrobe and a bio
([../database/library.md](../database/library.md)). `users.default_persona_id` is a soft pointer
(no FK) naming which one new chats start as; `PATCH /api/users/me` and the `/settings` page set it,
and the persona editor authors the persona itself.

## One resolver

Every consumer reads through **one resolver**, `resolveChatPersona({ownerId, chatId})`
(`apps/web/src/server/players/`). It is a three-rung ladder, each rung degrading rather than
throwing, so a chat turn always has someone to address
([../resilience.md](../resilience.md)):

1. the **chat's** own pick (`character_chats.player_state.personaId`);
2. the owner's **default** persona (`users.default_persona_id`);
3. the **account name**, then `FALLBACK_PLAYER_NAME`.

Every lookup is owner-strict, so a dangling or foreign id simply misses and falls through — which
is also why deleting a persona needs no write fan-out across chats. `chatId` is optional: omit it
for an account-level read (rungs 2–3 only), though every caller in the codebase has a conversation
in scope and passes it.

## `PlayerPersona` carries no `title`

The persona's per-owner-unique library label is a database and UX concern that must never reach a
model. Since every prompt consumer reads this one resolved type, **the absence of `title` on it —
not a rule anyone has to remember — is what enforces that.**

The character-chat prompt threads the rest in as the addressee
(`apps/web/src/server/engine/prompts/character-chat/types.ts`): name, bio, what they are wearing, how
their voice sounds, and what they respond to once things turn intimate.
