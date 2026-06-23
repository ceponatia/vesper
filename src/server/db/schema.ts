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
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("characters_owner_idx").on(t.ownerId)],
);

/**
 * The character-chat harness transcript (docs/developer-notes/character-chat.plan.md).
 * A flat, per-character message log for the editor's Chat tab — deliberately
 * isolated from sessions (no turns, episodes, facts, or RAG). Clearing the chat
 * deletes these rows; the generated scene images (kind="scene") survive, but
 * their chat-derived prompt text is scrubbed (character-chat.followups.md §3).
 */
export const characterChatMessages = pgTable(
  "character_chat_messages",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("character_chat_messages_owner_character_idx").on(t.ownerId, t.characterId, t.createdAt)],
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
    ownerId: text("owner_id").notNull().references(() => users.id),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    summary: text("summary").notNull().default(""),
    /** (watermarkAt, watermarkId) = the newest message folded into `summary`; both null until the first fold. */
    watermarkAt: timestamp("watermark_at", { withTimezone: true }),
    watermarkId: text("watermark_id"),
    /** Exchanges represented by `summary` — telemetry/debug only, never a correctness input. */
    coveredExchanges: integer("covered_exchanges").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.characterId] })],
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
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    summary: text("summary").notNull(),
    threadIds: jsonb("thread_ids").notNull().default([]),
    /** Participant ids present for the turn — interim co-location semantics; write-only until the knowledge ledger ships. */
    witnessedBy: jsonb("witnessed_by").notNull().default([]),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
  },
  (t) => [
    index("episodes_session_idx").on(t.sessionId, t.turnNumber),
    index("episodes_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: id(),
    sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
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
    /** Participant ids co-located at insert (interim semantics; perception refines to true witness sets). Write-only until the knowledge ledger ships. */
    witnessedBy: jsonb("witnessed_by").notNull().default([]),
    status: text("status", { enum: ["active", "superseded", "retracted"] }).notNull().default("active"),
    supersededById: text("superseded_by_id"),
    sourceTurnId: text("source_turn_id"),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    index("facts_session_status_idx").on(t.sessionId, t.status),
    index("facts_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
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
    kind: text("kind", { enum: ["avatar", "portrait_variant", "scene", "entity"] }).notNull(),
    entityKind: text("entity_kind", { enum: ["character", "location", "item", "world"] }),
    entityId: text("entity_id"),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
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
      enum: ["post_turn", "reconcile", "inner_note", "chat_summary", "scene_image", "avatar", "portrait_variant", "entity_image", "embed_refresh", "image_sweep"],
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
