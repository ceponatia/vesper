import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import type { AuthoredRelationship } from "@/contracts";
import { sceneReferenceSources, sceneVisualReferenceKinds } from "@/contracts";
import { newId } from "@/lib/ids";

const id = () => text("id").primaryKey().$defaultFn(newId);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const embedding = () => vector("embedding", { dimensions: 1536 });

// ---------------------------------------------------------------------------
// Identity & library
// ---------------------------------------------------------------------------

/**
 * Accounts (auth.plan.md). Owns its core columns for Better Auth's Drizzle
 * adapter (`user` model → this table); the adapter maps by Drizzle **property
 * key**, so the keys below must match Better Auth's field names exactly
 * (`emailVerified`, `createdAt`, `updatedAt`) — the SQL column names are free.
 * `role`/`banned`/`banReason`/`banExpires` are read by the admin plugin.
 */
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  /** Better Auth: set true once an email is verified (magic-link/OAuth). */
  emailVerified: boolean("email_verified").notNull().default(false),
  /** Better Auth profile image URL (OAuth avatar); null for password sign-ups. */
  image: text("image"),
  /**
   * The default player character (player-character.plan.md): a light persona
   * (StoredPlayerPersona — name + short bio) the player is represented by in
   * character chat. `{}` ⇒ none set; read back via `resolvePlayerPersona`, which
   * `parseOr`s it. JSONB so growing the persona never needs a migration.
   */
  playerPersona: jsonb("player_persona").notNull().default({}),
  /** Admin plugin ban fields — null/false ⇒ not banned. */
  banned: boolean("banned"),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Better Auth session tokens (auth.plan.md). Named `auth_sessions` to avoid the
 * collision with the game `sessions` table; mapped via the adapter's `schema`
 * option (`session` model → this table). `impersonatedBy` is the admin plugin's
 * column, set when a dev/admin session is impersonating another user.
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    impersonatedBy: text("impersonated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

/** Better Auth credential + OAuth links (`account` model → this table). */
export const accounts = pgTable(
  "accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Hashed password for the `credential` provider; null for OAuth links. */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

/** Better Auth one-time tokens — email verification, magic links (`verification` model). */
export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const characters = pgTable(
  "characters",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    /** CharacterProfile (contracts/world/profile.ts) */
    profile: jsonb("profile").notNull().default({}),
    tags: jsonb("tags").notNull().default([]),
    avatarImageId: text("avatar_image_id"),
    /**
     * Cross-account **share scope** (auth.plan.md). `private` ⇒ owner-only;
     * `public` ⇒ discoverable + copyable by anyone (copy-on-use, no live
     * cross-owner reference). Distinct from `lore_chunks.visibility` (in-world
     * secrecy) and `world_links.access` (in-world traversal). Headroom for an
     * `unlisted` tier later without a migration.
     */
    visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
    /** Soft provenance for a library→library clone of a public source — no FK (remix attribution). */
    clonedFromId: text("cloned_from_id"),
    /**
     * The narrator model the owner last picked in the character-chat tab's dropdown
     * (a curated `NARRATIVE_MODELS` id), persisted so the choice survives leaving the
     * tab. Mirrors `worlds.narrativeModel`: a per-entity scalar, not part of the
     * resettable `character_chat_state` row (so chat resets never clear it) and not in
     * the `profile` jsonb the editor's SaveBar rewrites (so an immediate save can't be
     * clobbered). Empty ⇒ the chat default (`DEFAULT_CHARACTER_CHAT_MODEL_ID`).
     */
    chatModel: text("chat_model").notNull().default(""),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("characters_owner_idx").on(t.ownerId)],
);

/**
 * A conversation (docs/character-chat.md; character-chat-standalone.spec.md §1):
 * the chat lane's first-class record — the transcript, rolling summary, and
 * per-participant state hang off `chat_id`, so one character can host many
 * stories (a long-running main thread beside a fresh alternate-universe
 * scenario). Built with multi-character headroom: membership is the
 * `chat_participants` join table (a roster of up to 4, sort 0 = the primary
 * participant; the exchange pipeline is still 1-on-1 with the primary until the
 * multi-character substrate ships — multi-character-chat.plan.md).
 * `archived_at` shelves a conversation read-only (restorable);
 * hard delete cascades transcript + summary + state (memory-group purge is
 * app-level — see `deleteChat`).
 */
export const characterChats = pgTable(
  "character_chats",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    /** User-editable; "" renders as an auto-title (the character's name). */
    title: text("title").notNull().default(""),
    createdAt: createdAt(),
    /** Recency anchor for the Chats list; bumped on every exchange. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("character_chats_owner_recency_idx").on(t.ownerId, t.lastMessageAt)],
);

/**
 * Chat membership (character-chat-standalone.spec.md §1.1). `memory_group_id`
 * keys this participant's facts/episodes scope (memory groups — D7):
 * "continue our shared history" chats reuse the character's existing group,
 * "fresh start / AU" chats mint a new one — every AU is its own island, and a
 * future group chat keeps each character's memory their own.
 */
export const chatParticipants = pgTable(
  "chat_participants",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    memoryGroupId: text("memory_group_id").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.characterId] }),
    index("chat_participants_character_idx").on(t.characterId),
  ],
);

/**
 * Reusable scenario setups (character-chat-standalone.spec.md §1.5): a nameable
 * premise/outfit/cards/starting-stage bundle, seeded into a new conversation's
 * state exactly the way the scenario modal writes those fields. A small owned
 * table now; `LibraryKind` graduation (sharing/cloning) later if wanted.
 */
export const chatScenarioPresets = pgTable(
  "chat_scenario_presets",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    premise: text("premise").notNull().default(""),
    outfit: text("outfit").notNull().default(""),
    outfitExposed: boolean("outfit_exposed").notNull().default(false),
    /** SocialReactionCard[] — same shape as `character_chat_state.active_social_cards`. */
    socialCards: jsonb("social_cards").notNull().default([]),
    startingStage: text("starting_stage").notNull().default("stranger"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_scenario_presets_owner_idx").on(t.ownerId)],
);

/**
 * The character-chat transcript (docs/character-chat.md). A flat message log per
 * conversation — deliberately isolated from sessions (no turns). Clearing (hard
 * delete) removes the chat row and these cascade; the generated scene images
 * (kind="scene") survive, but their chat-derived prompt text is scrubbed.
 */
export const characterChatMessages = pgTable(
  "character_chat_messages",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    /** Which participant spoke an assistant line (multi-character headroom; null on user lines). */
    speakerCharacterId: text("speaker_character_id").references(() => characters.id, { onDelete: "set null" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /**
     * Alternate takes on an assistant reply (character-chat-standalone.spec.md §4.1):
     * `{ takes: [{id, content, createdAt}], activeId }`, cap TAKES_CAP. `content`
     * above always mirrors the active take, so transcript reads stay one-column.
     */
    takes: jsonb("takes").notNull().default({}),
    /** Reply metadata (e.g. `{ stopped: true }` when the player cut the stream short). */
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("character_chat_messages_chat_idx").on(t.chatId, t.createdAt)],
);

/**
 * Rolling background summary for one character chat
 * (docs/developer-notes/character-chat-summary.plan.md). One row per
 * (ownerId, characterId): a running prose recap of the transcript OLDER than the
 * verbatim window, plus a **watermark** — the (createdAt, id) of the newest
 * message already folded into `summary`. The chat prompt sends `summary` +
 * every message after the watermark, so memory reaches past the 40-turn window.
 * A detached `chat_summary` job advances the watermark. No row (or a null
 * watermark) ⇒ the chat behaves exactly as before (last-40 verbatim window).
 * Clearing the chat deletes this row alongside the messages.
 */
export const characterChatSummaries = pgTable(
  "character_chat_summaries",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    summary: text("summary").notNull().default(""),
    /** (watermarkAt, watermarkId) = the newest message folded into `summary`; both null until the first fold. */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    watermarkId: text("watermark_id"),
    /** Exchanges represented by `summary` — telemetry/debug only, never a correctness input. */
    coveredExchanges: integer("covered_exchanges").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.chatId] })],
);

/**
 * Character-chat state (docs/character-chat.md; origin:
 * docs/developer-notes/finished/character-chat-state.spec.md). One row per
 * (ownerId, characterId): the chat's tracked state beside the message window,
 * the rolling summary, and the chat-scoped facts/episodes — the full meter
 * registry, an affinity scalar, optional self-expiring conditions, a dynamic
 * "what's on their mind" note, a player-set per-chat premise, scenario fields
 * (outfit/cards), the RAG carry-overs (memory queries, attribute overlays,
 * traces), the chat-local game clock, and a wall-clock anchor for between-visit
 * recovery. A pure CREATE (not an extension of character_chat_summaries) so the
 * migration never hits drizzle's rename prompt and the pulse stays independent
 * of the summary fold. No row ⇒ a fresh stateless chat; the first POST lazily
 * seeds one. Lifecycle: the single **Clear Chat** (`clearCharacterChat`) deletes
 * this row with the transcript + summary + chat memory
 * (character-chat-primary.spec.md §4, D4 — supersedes the old three-scope reset).
 */
export const characterChatState = pgTable(
  "character_chat_state",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    /**
     * Snapshot of the ChatState as it stood BEFORE the last exchange's drift +
     * fan-out applied (character-chat-standalone.spec.md §4.1) — the rollback
     * target for "another take". Overwritten each exchange; `{}` ⇒ none.
     */
    preExchangeState: jsonb("pre_exchange_state").notNull().default({}),
    /** Record<string,number> — the full meter registry, carried verbatim (seeded from initialMeters()). */
    meters: jsonb("meters").notNull().default({}),
    /**
     * −100…100, the FEELING axis toward the player persona (relationship-model.plan.md;
     * was `affinity`) — volatile, moved by the reaction pulse. Seeded from the authored
     * `playerRelationship` record at band midpoints.
     */
    regard: integer("regard").notNull().default(0),
    /** 0…100, the KNOWLEDGE axis — a slow ratchet (moments + time), never down. */
    familiarity: integer("familiarity").notNull().default(0),
    /** Familiarity gained this scene (the ratchet's per-scene budget); resets on a time skip. */
    familiaritySceneGain: integer("familiarity_scene_gain").notNull().default(0),
    /**
     * RelationshipTexture (contracts/relationships/record.ts) — the authored
     * kind/history/mask/looming texture beside the two scalar columns; together
     * they form the directed relationship record.
     */
    relationshipRecord: jsonb("relationship_record").notNull().default({}),
    /** ActiveCondition[] — optional light texture, self-expiring on clockMinutes. */
    conditions: jsonb("conditions").notNull().default([]),
    /** 1–3 sentences: "what's on their mind" — the cheap dynamic continuity note (pulse-written). */
    mindNote: text("mind_note").notNull().default(""),
    /** ChatPulseTrace — last-exchange debug trace for the state-tools modal; parsed defensively. */
    lastPulseTrace: jsonb("last_pulse_trace").notNull().default({}),
    /**
     * Record<string,string> — the meter bands last surfaced as a "just shifted" beat
     * (character-chat-state-narration.spec.md §5), `{ meterId: band }`. The anti-repetition
     * gate diffs current bands against this so an unchanged state never re-fires a beat.
     */
    surfacedCues: jsonb("surfaced_cues").notNull().default({}),
    /**
     * Player-set scenario framing for THIS chat ("it's the night before she moves
     * away…"). Chat-only by construction — no session ever reads it (spec §1.2).
     * Pre-filled from the authored `playerRelationship.note`, then player-owned.
     */
    premise: text("premise").notNull().default(""),
    /**
     * Free-text starting outfit for THIS chat (character-chat-scenario.plan.md). Drives the
     * chat scene-image prompt instead of structured clothing items, which chat can't equip.
     */
    outfit: text("outfit").notNull().default(""),
    /** Gate for intimate-anatomy reveal in chat scene images (no structured wardrobe to derive it). */
    outfitExposed: boolean("outfit_exposed").notNull().default(false),
    /**
     * SocialReactionCard[] snapshot — the cards live in THIS chat (seeded from the character's
     * own `profile.socialCards`, then author-editable in the Scenario modal). The pulse resolves
     * reactions against this set so taboos/rules are testable without a world/session.
     */
    activeSocialCards: jsonb("active_social_cards").notNull().default([]),
    /**
     * string[] — the chat archivist's memory-retrieval queries for the NEXT turn
     * (character-chat-primary.spec.md §2), mirroring the session director's `memoryQueries`.
     * Produced post-turn, consumed at the next prompt build to seed RAG recall.
     */
    memoryQueries: jsonb("memory_queries").notNull().default([]),
    /**
     * AttributeValue[] — persisted narrative attribute overlays that EVOLVE over a chat
     * (character-chat-primary.spec.md §3): the attribute proposer merges `source:"narrative"`
     * overlays here (inherent traits guarded), and the prompt builder resolves them on top of
     * the authored base. Distinct from the transient condition overlays (render-time only).
     */
    attributeOverlays: jsonb("attribute_overlays").notNull().default([]),
    /**
     * ChatMemoryTrace — last-turn RAG debug (character-chat-primary.spec.md §5): what was
     * retrieved + extracted this exchange, for the dev inspector. Parsed defensively.
     */
    lastMemoryTrace: jsonb("last_memory_trace").notNull().default({}),
    /**
     * string[] — the character's unfinished business (character-chat-standalone.spec.md
     * §6.2): ≤3 short phrases the archivist re-emits in full each exchange (resolved loops
     * fall off naturally). Rendered as an "Unfinished business" state line, shown in the
     * relationship panel, and read by the "has something to say" derivation (§8.4).
     */
    openLoops: jsonb("open_loops").notNull().default([]),
    /**
     * RelationshipSample[] ring (spec §7.2, cap ~200): `{at, clockMinutes, affinity, stage}`
     * appended by the finalizer when affinity moved or the stage crossed — the sparkline.
     */
    relationshipHistory: jsonb("relationship_history").notNull().default([]),
    /**
     * Milestone[] (spec §7.2, append-only, capped): first exchange, stage changes (both
     * directions), strong card-driven reactions, player-marked moments — each
     * `{at, kind, label, messageId?}`.
     */
    milestones: jsonb("milestones").notNull().default([]),
    /**
     * SkipRecord[] ring (spec §8.1, cap ~50): `{at, clockMinutes, amount}` per player time
     * skip — the future time-effects system's data, recorded now so it needs no migration.
     */
    skipHistory: jsonb("skip_history").notNull().default([]),
    /**
     * One-shot skip note (spec §8.1): stamped by a time skip, rendered as a volatile
     * one-turn prompt line ("The next morning — acknowledge the gap naturally, once"),
     * cleared when the exchange that rendered it persists. "" ⇒ none pending.
     */
    pendingSkipNote: text("pending_skip_note").notNull().default(""),
    /**
     * Auto scene-generation mode (plan area 8, slice 9): "off" (default — generation
     * stays player-triggered) or "milestones" (queue a scene when an exchange lands a
     * stage crossing / strong reaction). Text with headroom for future modes
     * (e.g. an interval), never a boolean.
     */
    sceneAuto: text("scene_auto").notNull().default("off"),
    /**
     * Scene-image model pick (contracts/images chatSceneModels, owner request
     * 2026-07-11): "reference" (default — identity-locked avatar edit) or a Venice
     * t2i model key for a style hot-swap. Saved on select from the scene strip's
     * dropdown; validated at the trust boundary (parseChatSceneModel), never here.
     */
    sceneModel: text("scene_model").notNull().default("reference"),
    /**
     * Chat-local game clock (within-visit tick + condition expiry + player time skips).
     * The ONLY time model (D3/D8): real-world elapsed time never touches state — the
     * wall-clock anchor and its between-visit recovery were removed outright.
     */
    clockMinutes: integer("clock_minutes").notNull().default(0),
    /**
     * ChatSceneMemory (contracts/turns/chat-scene-memory.ts) — the accumulating memory of
     * the narrator-imagined setting: current place, time of day, and a bounded set of named
     * places with durable details + connections. Maintained deterministic-first (movement
     * switches `current`) then reconciled from the archivist's `scene` proposal. One jsonb
     * blob so field additions are never migrations; parsed defensively at the boundary.
     */
    sceneMemory: jsonb("scene_memory").notNull().default({}),
    /**
     * CallbackEntry[] ring (memory-callbacks.plan.md): episode refs already offered as
     * an unprompted "remember when" cue, plus the chat-clock minute each fired — the
     * anti-repeat memory behind the cadence gate. Capped (CHAT_CALLBACK_HISTORY_CAP);
     * rolls back with the pre-exchange snapshot like the rest of the state.
     */
    callbackHistory: jsonb("callback_history").notNull().default([]),
    /**
     * ChatFeelingState (engine/chat-feeling.ts, emotional-weather.plan.md): the
     * persistent feeling (label + derived intensity + cause, exchange-decayed) and
     * the bruise (damped positive regard gains after a betrayal at high regard).
     * One jsonb blob so shape growth is never a migration; parsed defensively.
     */
    feeling: jsonb("feeling").notNull().default({}),
    /**
     * SelfieEntry[] ring (chat-selfies.plan.md): recorded selfie sends (request/offer
     * + chat-clock minute) — the unprompted-offer cooldown's memory. Capped; rolls
     * back with the pre-exchange snapshot like the rest of the state.
     */
    selfieHistory: jsonb("selfie_history").notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.characterId] })],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** { scent?, sound?, light? } */
    ambient: jsonb("ambient").notNull().default({}),
    /** Spatial size class; gates conversation distance, entry proximity, crossing time. */
    scale: text("scale", { enum: ["intimate", "room", "hall", "open", "expanse"] }).notNull().default("room"),
    /** Map-grouping label (mirrors world_locations.overrides.area); drives default link travel times. */
    area: text("area"),
    /** Affordance[] (contracts) — things characters can plausibly do here. */
    affordances: jsonb("affordances").notNull().default([]),
    tags: jsonb("tags").notNull().default([]),
    imageId: text("image_id"),
    /** Cross-account share scope (auth.plan.md) — see characters.visibility. */
    visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
    /** Soft provenance for a library→library clone of a public source — no FK. */
    clonedFromId: text("cloned_from_id"),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("locations_owner_idx").on(t.ownerId)],
);

/**
 * Undirected connections between library locations (one row per pair). The
 * library counterpart of world_links: a location set designed with linked
 * nodes keeps those connections, and importing the set into a world recreates
 * them as world_links (docs/world.md). FK-cascade so deleting either endpoint
 * drops the link.
 */
export const locationLinks = pgTable(
  "location_links",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    fromLocationId: text("from_location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
    toLocationId: text("to_location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
    travelMinutes: integer("travel_minutes").notNull().default(1),
  },
  (t) => [index("location_links_owner_idx").on(t.ownerId), index("location_links_from_idx").on(t.fromLocationId)],
);

export const items = pgTable(
  "items",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    kind: text("kind", { enum: ["clothing", "object", "container"] }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** ItemDefinition extras (contracts/items/item.ts): coverage, layer, opacity, sensory, fields */
    definition: jsonb("definition").notNull().default({}),
    tags: jsonb("tags").notNull().default([]),
    imageId: text("image_id"),
    /** Cross-account share scope (auth.plan.md) — see characters.visibility. */
    visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
    /** Soft provenance for a library→library clone of a public source — no FK. */
    clonedFromId: text("cloned_from_id"),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("items_owner_idx").on(t.ownerId), index("items_kind_idx").on(t.kind)],
);

export const socialCards = pgTable(
  "social_cards",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** SocialReactionCard extras (contracts/personality/cards.ts): kind, triggers, severity, defaultReaction, reactionOverrides */
    definition: jsonb("definition").notNull().default({}),
    tags: jsonb("tags").notNull().default([]),
    /** Cross-account share scope (auth.plan.md) — see items.visibility. */
    visibility: text("visibility", { enum: ["private", "public"] }).notNull().default("private"),
    /** Soft provenance for a library→library clone of a public source — no FK. */
    clonedFromId: text("cloned_from_id"),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("social_cards_owner_idx").on(t.ownerId)],
);

// ---------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------

export const worlds = pgTable(
  "worlds",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** WorldStyle (contracts/world/profile.ts) */
    style: jsonb("style").notNull().default({}),
    /** WorldLore (contracts/world/profile.ts) */
    lore: jsonb("lore").notNull().default({}),
    narrativeModel: text("narrative_model").notNull().default(""),
    /** Per-world override for the in-session agent models (intake + post-turn); "" ⇒ default. */
    agentModel: text("agent_model").notNull().default(""),
    imageId: text("image_id"),
    /** Character the player embodies by default in this world; a changeable default the session wizard pre-fills. null ⇒ observer default (UX-audit §1a). */
    playerCharacterId: text("player_character_id").references(() => characters.id, { onDelete: "set null" }),
    /** Where the player starts; unset ⇒ legacy anchor-to-companion behavior. No FK (cycle with world_locations). */
    playerStartWorldLocationId: text("player_start_world_location_id"),
    duplicatedFromWorldId: text("duplicated_from_world_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("worlds_owner_idx").on(t.ownerId)],
);

export const worldLocations = pgTable(
  "world_locations",
  {
    id: id(),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    /** Soft pointer to the library location this was copied from — provenance only
     * (world-instances.plan.md). No FK: the source may be edited or deleted; this row
     * is self-sufficient via `snapshot`. */
    sourceLocationId: text("source_location_id"),
    /** Source `updated_at` at copy time — the diff baseline for future opt-in propagation. */
    sourceStampedAt: timestamp("source_stamped_at", { withTimezone: true }),
    /** LocationSnapshot (contracts/world/location): the world's own full copy of the
     * effective location — name/description/ambient/scale/area/affordances/tags. */
    snapshot: jsonb("snapshot").notNull().default({}),
    /** Authored map order (editor reordering); written as the array index on every save. */
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("world_locations_world_idx").on(t.worldId)],
);

export const worldLinks = pgTable(
  "world_links",
  {
    id: id(),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    fromWorldLocationId: text("from_world_location_id").notNull().references(() => worldLocations.id, { onDelete: "cascade" }),
    toWorldLocationId: text("to_world_location_id").notNull().references(() => worldLocations.id, { onDelete: "cascade" }),
    label: text("label"),
    travelMinutes: integer("travel_minutes").notNull().default(1),
    /** Reserved for the sound channel (decision 11); unused in v1. */
    audibility: text("audibility"),
    /** LinkAccess (contracts) — { kind: "public" | "private" | "locked" | "timeWindow", ... } */
    access: jsonb("access").notNull().default({ kind: "public" }),
    /** Library item id of the door bound to this link. No FK (soft reference, like imageId). */
    doorItemId: text("door_item_id"),
  },
  (t) => [index("world_links_world_idx").on(t.worldId)],
);

export const worldCast = pgTable(
  "world_cast",
  {
    id: id(),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    /** Soft pointer to the source library character — provenance only, no FK (see worldLocations). */
    sourceCharacterId: text("source_character_id"),
    sourceStampedAt: timestamp("source_stamped_at", { withTimezone: true }),
    /** Display name copied from the source character at materialize time. */
    name: text("name").notNull().default(""),
    /** CharacterProfile (contracts/world/profile) — the world's own copy. */
    snapshot: jsonb("snapshot").notNull().default({}),
    /** Avatar image id; a soft ref to a shared owner-asset, kept fresh by the world image backfill. */
    avatarImageId: text("avatar_image_id"),
    role: text("role", { enum: ["companion", "npc"] }).notNull().default("npc"),
    /** Simulation/narration depth ceiling (cast-tiers-and-affinity-spec). */
    tier: text("tier", { enum: ["major", "minor", "extra"] }).notNull().default("minor"),
    startWorldLocationId: text("start_world_location_id").references(() => worldLocations.id, { onDelete: "set null" }),
    /** AuthoredRelationship[] (contracts/relationships/authored.ts) — directed edges toward cast names or "player"; spawn seeds participant_relationships at stage midpoints. */
    relationships: jsonb("relationships").$type<AuthoredRelationship[]>().notNull().default([]),
  },
  (t) => [index("world_cast_world_idx").on(t.worldId)],
);

export const worldItems = pgTable(
  "world_items",
  {
    id: id(),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    /** Soft pointer to the source library item — provenance only, no FK (see worldLocations). */
    sourceItemId: text("source_item_id"),
    sourceStampedAt: timestamp("source_stamped_at", { withTimezone: true }),
    /** Display name copied from the source item at materialize time. */
    name: text("name").notNull().default(""),
    /** ItemDefinition (contracts/items/item) — the world's own full copy. */
    snapshot: jsonb("snapshot").notNull().default({}),
    /** Placement: a location, a cast member (worn/carried), or inside another world item. */
    worldLocationId: text("world_location_id").references(() => worldLocations.id, { onDelete: "cascade" }),
    castId: text("cast_id").references(() => worldCast.id, { onDelete: "cascade" }),
    worn: boolean("worn").notNull().default(false),
    containerWorldItemId: text("container_world_item_id"),
    quantity: integer("quantity").notNull().default(1),
  },
  (t) => [index("world_items_world_idx").on(t.worldId)],
);

export const loreChunks = pgTable(
  "lore_chunks",
  {
    id: id(),
    worldId: text("world_id").notNull().references(() => worlds.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    category: text("category").notNull().default("history"),
    tier: text("tier", { enum: ["always", "scene", "retrieval"] }).notNull().default("scene"),
    visibility: text("visibility", { enum: ["public", "secret"] }).notNull().default("public"),
    unlockTags: jsonb("unlock_tags").notNull().default([]),
    locationTags: jsonb("location_tags").notNull().default([]),
    characterIds: jsonb("character_ids").notNull().default([]),
    sort: integer("sort").notNull().default(0),
    manuallyUnlocked: boolean("manually_unlocked").notNull().default(false),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
  },
  (t) => [
    index("lore_chunks_world_idx").on(t.worldId),
    index("lore_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    worldId: text("world_id").notNull().references(() => worlds.id),
    title: text("title").notNull(),
    embodied: boolean("embodied").notNull().default(true),
    status: text("status", { enum: ["ready", "narrating", "processing"] }).notNull().default("ready"),
    clockMinutes: bigint("clock_minutes", { mode: "number" }).notNull().default(0),
    /** SessionRuntime */
    runtime: jsonb("runtime").notNull().default({}),
    /** NextTurnBrief */
    brief: jsonb("brief").notNull().default({}),
    /** SceneGenState */
    scene: jsonb("scene").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sessions_owner_idx").on(t.ownerId), index("sessions_world_idx").on(t.worldId)],
);

export const sessionLocations = pgTable(
  "session_locations",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** Soft pointer to the source library location — provenance only, no FK (world-instances.plan.md):
     * the snapshot columns below are self-sufficient, so deleting the library row never blocks. */
    locationId: text("location_id"),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ambient: jsonb("ambient").notNull().default({}),
    scale: text("scale", { enum: ["intimate", "room", "hall", "open", "expanse"] }).notNull().default("room"),
    /** Map-grouping label ("apartment-102", "downtown") — not a container. */
    area: text("area"),
    affordances: jsonb("affordances").notNull().default([]),
    emergent: boolean("emergent").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("session_locations_session_idx").on(t.sessionId)],
);

export const sessionLinks = pgTable(
  "session_links",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    fromId: text("from_id").notNull().references(() => sessionLocations.id, { onDelete: "cascade" }),
    toId: text("to_id").notNull().references(() => sessionLocations.id, { onDelete: "cascade" }),
    label: text("label"),
    travelMinutes: integer("travel_minutes").notNull().default(1),
    audibility: text("audibility"),
    access: jsonb("access").notNull().default({ kind: "public" }),
    /** Item instance id of the door bound to this link. No FK (soft reference). */
    doorItemId: text("door_item_id"),
  },
  (t) => [index("session_links_session_idx").on(t.sessionId)],
);

export const sessionParticipants = pgTable(
  "session_participants",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** Soft pointer to the source library character — provenance only, no FK (the `snapshot` is self-sufficient). */
    characterId: text("character_id"),
    isUser: boolean("is_user").notNull().default(false),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["player", "companion", "npc"] }).notNull().default("npc"),
    tier: text("tier", { enum: ["major", "minor", "extra"] }).notNull().default("minor"),
    /** CharacterProfile snapshot at spawn. */
    snapshot: jsonb("snapshot").notNull().default({}),
    /** ParticipantState */
    state: jsonb("state").notNull().default({}),
    locationId: text("location_id").references(() => sessionLocations.id, { onDelete: "set null" }),
    avatarImageId: text("avatar_image_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // session lookups are covered by the leading column of session_participants_name_unique
    uniqueIndex("session_participants_name_unique").on(t.sessionId, t.displayName),
  ],
);

export const itemInstances = pgTable(
  "item_instances",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** Soft pointer to the source library item — provenance only, no FK (the `snapshot` is self-sufficient). */
    itemId: text("item_id"),
    name: text("name").notNull(),
    /** ItemDefinition snapshot. */
    snapshot: jsonb("snapshot").notNull().default({}),
    holderParticipantId: text("holder_participant_id").references(() => sessionParticipants.id, { onDelete: "cascade" }),
    worn: boolean("worn").notNull().default(false),
    locationId: text("location_id").references(() => sessionLocations.id, { onDelete: "cascade" }),
    containerInstanceId: text("container_instance_id"),
    positionNote: text("position_note"),
    /** ItemInstanceState */
    state: jsonb("state").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("item_instances_session_idx").on(t.sessionId),
    index("item_instances_holder_idx").on(t.holderParticipantId),
    index("item_instances_location_idx").on(t.locationId),
    // exactly one placement: held(+worn) | in location | in container
    check(
      "item_instances_one_placement",
      sql`(
        (CASE WHEN ${t.holderParticipantId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.locationId} IS NOT NULL THEN 1 ELSE 0 END) +
        (CASE WHEN ${t.containerInstanceId} IS NOT NULL THEN 1 ELSE 0 END)
      ) = 1`,
    ),
    check("item_instances_worn_needs_holder", sql`NOT ${t.worn} OR ${t.holderParticipantId} IS NOT NULL`),
  ],
);

export const participantRelationships = pgTable(
  "participant_relationships",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    /** Edge owner — always an NPC (the player has no edges; see decision 41). */
    fromParticipantId: text("from_participant_id").notNull().references(() => sessionParticipants.id, { onDelete: "cascade" }),
    toParticipantId: text("to_participant_id").notNull().references(() => sessionParticipants.id, { onDelete: "cascade" }),
    /**
     * "feeling": owner's affinity toward the target.
     * "perceived": owner's belief about the target's feeling toward THEM —
     * only created when the target is the player (decision 41).
     */
    kind: text("kind", { enum: ["feeling", "perceived"] }).notNull().default("feeling"),
    value: integer("value").notNull().default(0),
    /** Denormalized from the stage registry for queries/UI; recomputed on every write. */
    stage: text("stage").notNull().default("stranger"),
    updatedAt: updatedAt(),
  },
  (t) => [
    // session lookups are covered by the leading column of participant_relationships_edge_unique
    uniqueIndex("participant_relationships_edge_unique").on(t.sessionId, t.fromParticipantId, t.toParticipantId, t.kind),
  ],
);

// ---------------------------------------------------------------------------
// Turns & memory
// ---------------------------------------------------------------------------

export const turns = pgTable(
  "turns",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    author: text("author", { enum: ["player", "director", "companion"] }).notNull().default("player"),
    speakerParticipantId: text("speaker_participant_id").references(() => sessionParticipants.id, { onDelete: "set null" }),
    input: text("input").notNull(),
    narration: text("narration"),
    status: text("status", { enum: ["pending", "narrating", "processing", "ready", "failed"] })
      .notNull()
      .default("pending"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    minutes: integer("minutes").notNull().default(0),
    /** Raw per-agent outputs (AgentResults) for the inspector / replay. */
    agentResults: jsonb("agent_results").notNull().default({}),
    /** Pre-narrator intake output (IntentBrief) — empty {} when intake didn't run. */
    intentBrief: jsonb("intent_brief").notNull().default({}),
    /** Diagnostic[] */
    diagnostics: jsonb("diagnostics").notNull().default([]),
    model: text("model"),
    usage: jsonb("usage").notNull().default({}),
    /** Per-leg provider attribution (TurnProviders): which OpenRouter upstream
     * served the narrator + each post-turn agent, with latency. Embedding
     * excluded. Powers the Inspector's slow-provider tracking. */
    providers: jsonb("providers").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("turns_session_number_unique").on(t.sessionId, t.number)],
);

export const turnMessages = pgTable(
  "turn_messages",
  {
    id: id(),
    turnId: text("turn_id").notNull().references(() => turns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull().default(0),
    role: text("role", { enum: ["player", "narrator", "character", "system"] }).notNull(),
    speaker: text("speaker"),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("turn_messages_turn_idx").on(t.turnId, t.seq)],
);

export const episodes = pgTable(
  "episodes",
  {
    id: id(),
    // Memory keying is mutually exclusive: either a session (the turn lane) or a chat
    // memory group (character-chat-standalone.spec.md §1.3). Enforced by the
    // `episodes_scope_exactly_one` CHECK below. `turnNumber` is a per-group exchange
    // ordinal in the chat lane, a real turn number in the session lane.
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    /** Memory-group keying (character-chat-standalone.spec.md §1.3) — the chat lane's scope. */
    chatMemoryGroupId: text("chat_memory_group_id"),
    turnNumber: integer("turn_number").notNull(),
    summary: text("summary").notNull(),
    threadIds: jsonb("thread_ids").notNull().default([]),
    /** Participant ids present for the turn — interim co-location semantics; write-only until the knowledge ledger ships. */
    witnessedBy: jsonb("witnessed_by").notNull().default([]),
    /**
     * Chat-lane provenance (character-chat-standalone.spec.md §4.3): the assistant
     * message this episode summarizes. Deletion targets this, not the ordinal —
     * a shared memory group spans conversations, so ordinals alone are ambiguous.
     */
    sourceMessageId: text("source_message_id"),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
  },
  (t) => [
    index("episodes_session_idx").on(t.sessionId, t.turnNumber),
    index("episodes_chat_group_idx").on(t.chatMemoryGroupId, t.turnNumber),
    index("episodes_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check(
      "episodes_scope_exactly_one",
      sql`(
        (${t.sessionId} IS NOT NULL AND ${t.chatMemoryGroupId} IS NULL) OR
        (${t.sessionId} IS NULL AND ${t.chatMemoryGroupId} IS NOT NULL)
      )`,
    ),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: id(),
    // Mutually-exclusive memory keying — see `episodes` above and the
    // `facts_scope_exactly_one` CHECK below (character-chat-primary.spec §1).
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    /** Memory-group keying (character-chat-standalone.spec.md §1.3) — the chat lane's scope. */
    chatMemoryGroupId: text("chat_memory_group_id"),
    kind: text("kind").notNull(),
    verb: text("verb"),
    subjectKind: text("subject_kind").notNull().default("character"),
    subjectId: text("subject_id"),
    /** Stored lowercased; see docs/memory.md. */
    subjectName: text("subject_name").notNull(),
    text: text("text").notNull(),
    tags: jsonb("tags").notNull().default([]),
    confidence: real("confidence").notNull().default(0.5),
    /** false ⇒ belief only (a told lie): known to its knowers, excluded from the narrator's truth channel. */
    canon: boolean("canon").notNull().default(true),
    /**
     * Player/dev-pinned (character-chat-standalone.spec.md §6.4 "remember this"): always
     * retrieved ahead of the top-k, exempt from the relevance floor, and never superseded
     * or retracted by an archivist-extracted fact (the asymmetric invariant) — only a
     * player/dev-authored fact (or the inspector) can retire it.
     */
    pinned: boolean("pinned").notNull().default(false),
    /**
     * Honest provenance (spec §6.4): who authored this fact — the background archivist
     * ("extracted", the default), the player's "remember this" ("player"), or a dev
     * inspector edit ("dev"). Session-lane rows keep the harmless default.
     */
    origin: text("origin", { enum: ["extracted", "player", "dev"] }).notNull().default("extracted"),
    /**
     * The channel this fact was established through (player-input-perception.plan.md slice 6 —
     * the RAG visibility fence). TEXT with headroom (NOT a pg enum — forward-compatible-schema
     * preference); vocabulary today `perceived | private | ooc` (contracts/facts/taxonomy.ts).
     * `perceived` renders to the narrator as established knowledge; `private` (thought-derived)
     * and `ooc` are excluded from narrator-bound retrieval. Default `perceived` migrates every
     * existing row and is the degraded default when classification is missing.
     */
    channel: text("channel").notNull().default("perceived"),
    /** Participant ids co-located at insert (interim semantics; perception refines to true witness sets). Write-only until the knowledge ledger ships. */
    witnessedBy: jsonb("witnessed_by").notNull().default([]),
    status: text("status", { enum: ["active", "superseded", "retracted"] }).notNull().default("active"),
    supersededById: text("superseded_by_id"),
    sourceTurnId: text("source_turn_id"),
    /**
     * Chat-lane provenance (character-chat-standalone.spec.md §4.3): the assistant
     * message this fact was extracted from — the session lane's `source_turn_id`
     * analogue. Plain text (no FK): retraction runs BEFORE the message row goes.
     */
    sourceMessageId: text("source_message_id"),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    index("facts_session_status_idx").on(t.sessionId, t.status),
    index("facts_chat_group_idx").on(t.chatMemoryGroupId, t.status),
    index("facts_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check(
      "facts_scope_exactly_one",
      sql`(
        (${t.sessionId} IS NOT NULL AND ${t.chatMemoryGroupId} IS NULL) OR
        (${t.sessionId} IS NULL AND ${t.chatMemoryGroupId} IS NOT NULL)
      )`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

export const images = pgTable(
  "images",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    // `chat_upload` (chat-image-input.plan.md): a player-attached chat photo — input-only
    // (never an identity anchor or edit reference), Gallery-hidden, hard-deleted with its
    // message/conversation (unlike scenes, which SET NULL and survive). The drizzle enum is
    // type-level only, so adding a kind is never a migration.
    kind: text("kind", { enum: ["avatar", "portrait_variant", "scene", "entity", "chat_upload"] }).notNull(),
    entityKind: text("entity_kind", { enum: ["character", "location", "item", "world"] }),
    entityId: text("entity_id"),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    /**
     * The conversation a chat scene was rendered for (character-chat-standalone plan
     * area 8, slice 9): scopes the scene list/scrub per chat instead of character-wide.
     * SET NULL so deleting a chat keeps the asset in the Gallery. Null on legacy rows
     * and non-chat images.
     */
    chatId: text("chat_id").references(() => characterChats.id, { onDelete: "set null" }),
    /**
     * The assistant message this scene illustrates — the inline-transcript anchor
     * (slice 9). Plain text, no FK: messages are individually deletable, and a dangling
     * anchor just means the image renders in the strip only. Captured at queue time
     * (newest assistant line for manual renders; the exchange's reply for auto).
     */
    anchorMessageId: text("anchor_message_id"),
    /** Relative to data/, e.g. images/<ownerId>/<imageId>.webp */
    path: text("path").notNull(),
    prompt: text("prompt").notNull().default(""),
    sourceImageId: text("source_image_id"),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull().default("pending"),
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("images_owner_idx").on(t.ownerId),
    index("images_entity_idx").on(t.entityKind, t.entityId),
    index("images_session_idx").on(t.sessionId),
    index("images_chat_idx").on(t.chatId),
  ],
);

/**
 * What a scene image featured / was anchored on — one row per reference
 * (scene-images.spec.md §4). The queryable source of truth that replaced the
 * old `images.meta.references` JSONB: app-wide metrics ("which scenes used this
 * character / location / portrait") become a table query. `entity_id` is the
 * library character/location id (null for non-entity roles); `image_id` is the
 * actual reference asset fed to a provider (null when the ref was textual-only);
 * `source` is the asset's provenance (null = unknown, e.g. backfilled rows).
 * FK-cascade on the scene image so every image-delete path cleans these up.
 */
export const imageReferences = pgTable(
  "image_references",
  {
    id: id(),
    sceneImageId: text("scene_image_id")
      .notNull()
      .references(() => images.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: sceneVisualReferenceKinds }).notNull(),
    entityId: text("entity_id"),
    role: text("role"),
    source: text("source", { enum: sceneReferenceSources }),
    imageId: text("image_id"),
    name: text("name").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("image_references_scene_idx").on(t.sceneImageId),
    index("image_references_entity_idx").on(t.kind, t.entityId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: ["post_turn", "reconcile", "inner_note", "chat_summary", "chat_scene_sketch", "scene_image", "chat_scene_image", "avatar", "portrait_variant", "entity_image", "embed_refresh", "image_sweep", "item_classify"],
    }).notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
    runnerId: text("runner_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_queued_idx").on(t.status, t.type),
    index("jobs_session_idx").on(t.sessionId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("events_session_idx").on(t.sessionId, t.createdAt), index("events_type_idx").on(t.type)],
);
