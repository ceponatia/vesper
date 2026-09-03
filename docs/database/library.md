# Identity and library tables

The owner-scoped definition rows: who the account is, and the reusable entities they author.

- **`users`** — `email` unique, `name`, `role` (`user`/`admin`), `email_verified`, `image?`,
  `banned?` / `ban_reason?` / `ban_expires?` (admin plugin) — Better Auth, see
  [../auth/README.md](../auth/README.md); plus `default_persona_id`, a soft pointer (no FK) to
  the `personas` row new chats start as, the middle rung of `resolveChatPersona`'s ladder.
- **`auth_sessions` / `accounts` / `verifications`** — Better Auth's
  `session` / `account` / `verification` models, renamed to avoid the game-`sessions` collision:
  signed session tokens, credential and OAuth links, one-time tokens. Owned by the library and
  authored by hand in `schema.ts`, never via Better Auth's own CLI
  ([../auth/README.md](../auth/README.md)).
- **`characters`** — `owner_id`, `name`, `profile` JSONB (`CharacterProfile`: bio, personality,
  voice, speciesId, bodyPlanId, `attributes` (`AttributeValue[]`), aliases, defaultOutfit item
  ids, schedule), `tags` JSONB, `avatar_image_id` (the portrait **candidate**),
  `accepted_avatar_image_id` + `accepted_at` (the **identity source** every identity-bearing render
  derives from, moved only by portrait acceptance —
  [../images/identity-packs.md](../images/identity-packs.md)), `chat_model` (persisted character-chat
  narrator-model override; empty ⇒ default), **`visibility` (`private`/`public`) — the
  cross-account share scope ([../auth/README.md](../auth/README.md))**, `cloned_from_id?` (soft
  remix provenance), `search_embedding` vector.
- **`personas`** — `owner_id`, **`title` — UNIQUE per owner (`personas_owner_title_unique`)**,
  `name`, `profile` JSONB (`PersonaProfile`: bio, voice, intimacy, species/heritage/bodyPlan,
  `intimateRegions`, `bodyFeatures`, `attributes`, `outfits`), `tags` JSONB, `avatar_image_id`,
  `search_embedding` vector.
  - **The player as a library entity** — who *you* are in a chat, with a body and a wardrobe.
  - `title` is the library label whose per-owner uniqueness lets `name` repeat across personas
    ("Brian, 22" and "Brian, 40" are both named Brian). It is a database and UX concern only and
    never reaches a prompt; [../auth/player.md](../auth/player.md) §`PlayerPersona` carries no
    `title` owns why. `id` stays the PK so a rename cannot orphan FKs.
  - **No `visibility` / `cloned_from_id`** — a persona is *you*, so there is no public tier.
    Every read is owner-strict; `searchLibraryIds` is called with `scope: "owned"`, the one scope
    that does not reference `visibility`. It is deliberately not a row in `characters`: a "self"
    character would clutter every library list and need a `kind` discriminator plus filtering
    everywhere.
- **`locations`** — `owner_id`, `name`, `description`, `ambient` JSONB (sensory), `scale`
  (`intimate`/`room`/`hall`/`open`/`expanse`), `area?` (map-grouping label), `affordances` JSONB,
  `tags` JSONB, `image_id`, `visibility`, `cloned_from_id?`, `search_embedding` vector.
- **`location_links`** — `owner_id`, `from_location_id`, `to_location_id` (FK-cascade),
  `travel_minutes` — undirected library connections between locations, one row per pair.
  `travel_minutes` is defaulted and unread, reserved for authored travel durations; retain and
  annotate it rather than dropping and recreating the column.
- **`items`** — `owner_id`, `kind` (`clothing`/`object`/`container`), `name`, `description`,
  `definition` JSONB (`ItemDefinition` extras: coverage, layer, opacity, sensory, fields), `tags`
  JSONB, `image_id`, `visibility`, `cloned_from_id?`, `search_embedding` vector.
- **`social_cards`** — `owner_id`, `name`, `description`, `definition` JSONB
  (`SocialReactionCard` extras: kind, triggers, severity, defaultReaction, reactionOverrides),
  `tags` JSONB, `visibility`, `cloned_from_id?`, `search_embedding` vector. The reusable **card
  library**: full CRUD at `/api/social-cards` (plus `/clone`, owner-or-public reads, semantic
  search via the shared `searchLibraryIds` `scope`), the `/social-cards` page and builder, and the
  All/Public/Owned discovery gallery. A character's selected cards live **inline** as snapshot
  copies on `characters.profile.socialCards` — no join or instance table; import snapshots a
  library row into that array, and save-to-library is the reverse.
