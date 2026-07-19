import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import type { AuthoredRelationship } from "@/contracts";
import type {
  SimulationCommandEnvelope,
  SimulationCommandResultRecord,
  SimulationSnapshot,
} from "@/contracts/simulation/branching";
import type { ActivityClaim, SimulationActionDefinition } from "@/contracts/simulation/activities";
import type { BodyModifierOperation } from "@/contracts/simulation/bodies";
import type { CommitmentKnowledgeSource } from "@/contracts/simulation/commitments";
import type { SimulationTrigger } from "@/contracts/simulation/scheduler";
import { sceneReferenceSources, sceneVisualReferenceKinds } from "@/contracts";
import { principalKinds } from "@/contracts/simulation/envelopes";
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
   * The persona pre-selected for new chats (persona-library.plan.md slice 6) — the
   * middle rung of `resolveChatPersona`'s ladder, so one-time setup still works and
   * the per-chat pick is an override rather than a chore on every new conversation.
   *
   * A **soft pointer** (no FK), like `characters.avatar_image_id`: the resolver's
   * lookup is owner-strict, so a dangling id simply misses and falls through to the
   * account name rather than erroring. The persona DELETE route clears it anyway.
   */
  defaultPersonaId: text("default_persona_id"),
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
 * **Personas** (persona-library.plan.md) — the player as a library entity: who *you*
 * are in a chat, with a body, a wardrobe and a bio. The graduated successor to the
 * single inline `users.player_persona` blob (one per account); a chat picks one.
 *
 * Deliberately NOT a row in `characters`: a "self" character would clutter every
 * library list and need a `kind` discriminator + filtering everywhere (the reasoning
 * recorded in finished/player-character.plan.md, which chose the blob for the same
 * reason and left this as the graduation).
 *
 * No `visibility`/`clonedFromId` in v1 — a persona is *you*, so cross-account sharing
 * has no obvious want. Both are additive later.
 */
export const personas = pgTable(
  "personas",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    /**
     * The library label, **unique per owner** — the disambiguator that lets `name`
     * repeat across personas ("Brian, 22" and "Brian, 40" are both named Brian).
     * A database/UX concern ONLY: it is deliberately absent from the `PlayerPersona`
     * shape every prompt consumer reads, so it has no path to an agent.
     */
    title: text("title").notNull(),
    /** The in-fiction name characters address. Freely repeatable across personas. */
    name: text("name").notNull(),
    /** PersonaProfile (contracts/players/persona-profile.ts) */
    profile: jsonb("profile").notNull().default({}),
    tags: jsonb("tags").notNull().default([]),
    avatarImageId: text("avatar_image_id"),
    searchEmbedding: vector("search_embedding", { dimensions: 1536 }),
    embedder: text("embedder"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The composite unique's LEADING column doubles as the owner-scoped lookup index,
  // so no separate `personas_owner_idx` is needed (the reasoning recorded on
  // `session_participants_name_unique` / `turns_session_number_unique` below).
  (t) => [uniqueIndex("personas_owner_title_unique").on(t.ownerId, t.title)],
);

/**
 * A conversation (docs/character-chat/; character-chat-standalone.spec.md §1):
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
    // --- The chat-wide SCENARIO (followups rulings 8-9): what belongs to the
    // conversation, not any one character. Moved off character_chat_state
    // 2026-07-12 (backfilled from each chat's primary): the premise, the
    // SETTING-wide house rules (per-character divergence rides character TAGS,
    // never per-character rule lists), the shared scene memory, ONE story
    // clock (away members skip meter decay, never fork the timeline), the
    // one-shot skip note + skip history, and the scene render prefs.
    premise: text("premise").notNull().default(""),
    /** SocialReactionCard[] — the setting's active rules, applied to EVERY member. */
    activeSocialCards: jsonb("active_social_cards").notNull().default([]),
    sceneAuto: text("scene_auto").notNull().default("off"),
    sceneModel: text("scene_model").notNull().default("reference"),
    /** ChatSceneMemory — the shared imagined setting. */
    sceneMemory: jsonb("scene_memory").notNull().default({}),
    /**
     * `ChatPlayerState` (contracts/players/chat-player-state.ts) — **who the player is
     * in this conversation and what they're wearing** (persona-library.plan.md slices
     * 7–8). Chat-wide, like every other field in this block: one player, many roster
     * characters. `{}` ⇒ no pick ⇒ the resolver falls to the owner's default persona.
     *
     * ONE jsonb column rather than five, following `scene_memory`'s precedent — field
     * additions here are never migrations. Parsed with `parseOr` at the read boundary.
     * It rides the `pre_exchange_scenario` rollback snapshot, so "another take" can't
     * leave the player undressed by a beat that no longer exists.
     */
    playerState: jsonb("player_state").notNull().default({}),
    /** SupportingCastMember[] — recurring named side characters (chat-supporting-cast.plan.md). */
    supportingCast: jsonb("supporting_cast").notNull().default([]),
    /** ChatPlan[] — tracked commitments that come due on the story clock (chat-plans-promises.plan.md). */
    plans: jsonb("plans").notNull().default([]),
    /** The chat-local game clock (the only time model) — one timeline for the roster. */
    clockMinutes: integer("clock_minutes").notNull().default(0),
    /**
     * CalendarStart — the story-calendar anchor for clock_minutes
     * (chat-clock-calendar.plan.md): minute 0 = this date+time. `{}` (the
     * default and every pre-feature row) heals to CHAT_DEFAULT_CALENDAR_START
     * (Jan 1, 8:00am) at the load boundary. Author-editable.
     */
    calendarStart: jsonb("calendar_start").notNull().default({}),
    pendingSkipNote: text("pending_skip_note").notNull().default(""),
    /**
     * The meanwhile pass's one-shot narrator note (chat-offscreen-life.plan.md) —
     * composes with pending_skip_note, cleared with it. "" = none pending.
     */
    pendingMeanwhileNote: text("pending_meanwhile_note").notNull().default(""),
    /** Clock minute the meanwhile pass last ran at (the cumulative ≥1-day gate's origin + the job's idempotency CAS). */
    meanwhilePassAtMinutes: integer("meanwhile_pass_at_minutes").notNull().default(0),
    /** SkipRecord[] — player time skips. */
    skipHistory: jsonb("skip_history").notNull().default([]),
    /** The scenario as it stood BEFORE the last exchange — "another take"'s rollback half. */
    preExchangeScenario: jsonb("pre_exchange_scenario").notNull().default({}),
    /**
     * ChatReplyFailure | null — why the LAST exchange produced no reply
     * (contracts/turns/chat-reply-failure.ts). Written when an exchange settles
     * with zero streamed text, nulled by any exchange that settles at all; the
     * client's post-exchange transcript refetch reads it for the failure popup.
     */
    lastReplyFailure: jsonb("last_reply_failure"),
    createdAt: createdAt(),
    /** Recency anchor for the Chats list; bumped on every exchange. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The "has something to say" seen-cursor (chat-initiative.plan.md slice 2 /
     * character-chat-standalone.spec.md §8.4 v2): stamped when the player OPENS
     * the conversation (PATCH {seen}), never by the post-exchange transcript
     * refetch — so a milestone landing mid-visit reads as unseen on the next
     * hub visit and clears on the next open (the unread-badge pattern).
     */
    milestonesSeenAt: timestamp("milestones_seen_at", { withTimezone: true }).notNull().defaultNow(),
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
/**
 * Per-conversation directed relationship matrix (relationship-model.plan.md
 * §The matrix): one row per (chat, from, to) roster pair — the chat analogue of
 * participant_relationships, record-shaped from day one ("A loves B, B secretly
 * resents A" is a data state). NPC↔NPC records are static authored texture in
 * v2 (no pulse, no ratchet — lived shifts reach the narrator via archivist
 * relationship facts); the character→player edge stays on character_chat_state.
 * Authoring is shared-cell (kind/history mirrored across both rows); storage is
 * fully directed. Seeded at creation from character_relationships defaults.
 */
export const characterChatRelationships = pgTable(
  "character_chat_relationships",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    fromCharacterId: text("from_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    toCharacterId: text("to_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    /** RelationshipRecord (contracts/relationships/record.ts) — live scalars + texture. */
    record: jsonb("record").notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.fromCharacterId, t.toCharacterId] })],
);

/**
 * Library-level default relationship edges (owner ruling 2026-07-07): the
 * character editor's Relationships tab — how A stands toward B by default;
 * conversation creation seeds its matrix from these for every roster pair. A
 * real table (never a profile field) exactly so deleting a character cascades
 * its edges instead of leaving dangling names.
 */
export const characterRelationships = pgTable(
  "character_relationships",
  {
    fromCharacterId: text("from_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    toCharacterId: text("to_character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    /** AuthoredRelationshipRecord (contracts/relationships/record.ts) — band picks + texture. */
    record: jsonb("record").notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.fromCharacterId, t.toCharacterId] })],
);

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
    /**
     * AuthoredRelationshipRecord (contracts/relationships/record.ts) — the
     * starting player-edge a NEW conversation seeds from this preset: both
     * band picks + kind/history/mask/looming. Replaced the single-vocabulary
     * `starting_stage` (followups ruling 4); applies at creation only, never
     * to a running conversation.
     */
    startingRelationship: jsonb("starting_relationship").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("chat_scenario_presets_owner_idx").on(t.ownerId)],
);

/**
 * The character-chat transcript (docs/character-chat/). A flat message log per
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
 * Character-chat state (docs/character-chat/state.md; origin:
 * docs/developer-notes/finished/character-chat-state.spec.md). One row per
 * (chatId, characterId) — a multi-character roster holds one row per member
 * (multi-character-chat.plan.md): the character's tracked state beside the
 * message window, the rolling summary, and the chat-scoped facts/episodes —
 * the full meter registry, the two relationship axes, optional self-expiring
 * conditions, a dynamic "what's on their mind" note, the starting outfit +
 * exposure, narrative presence + activity recency, and the RAG carry-overs
 * (memory queries, attribute overlays, traces). Chat-WIDE fields — premise,
 * house rules, scene memory/prefs, the story clock — live on `character_chats`
 * (the scenario; followups rulings 8-9). A pure CREATE (not an extension of
 * character_chat_summaries) so the migration never hits drizzle's rename
 * prompt and the pulse stays independent of the summary fold. No row ⇒ a fresh
 * stateless chat; the first POST lazily seeds one. Lifecycle: `deleteChat`
 * removes the chat row and everything hanging off it — state rows, transcript,
 * summary, chat memory (character-chat-primary.spec.md §4, D4).
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
     * string[] — the structured worn item-definition ids (chat-wardrobe-parity.plan.md rung 2),
     * seeded from the active outfit preset. When non-empty, THIS is the wardrobe truth: the
     * narrator's wearing-line renders these garments and exposure is COMPUTED from their coverage
     * via the session classifier (`items/visibility.ts`). Empty ⇒ the free-text `outfit` path
     * (legacy chats + ad-hoc looks) still applies (self-healing migration, ruled).
     */
    wornItemIds: jsonb("worn_item_ids").notNull().default([]),
    /** The active outfit preset id (chat-wardrobe-parity rung 1) — which named look is "on"; "" ⇒ default/none. */
    outfitPresetId: text("outfit_preset_id").notNull().default(""),
    /**
     * Free-text outfit OVERLAY / fallback (chat-wardrobe-parity ruling): narrated-but-unowned
     * garments ("a borrowed hoodie") ride alongside the worn list, and legacy chats carry their
     * whole look here until re-dressed. Drives the scene-image prompt when no items are worn.
     */
    outfit: text("outfit").notNull().default(""),
    /** Manual intimate-reveal flag — authoritative only on the free-text path (empty worn list); computed from coverage otherwise. */
    outfitExposed: boolean("outfit_exposed").notNull().default(false),
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
     * TraitValue[] — persisted narrative TRAIT overlays that evolve over a chat
     * (character-fidelity slice 10): the archivist proposes `source:"narrative"` trait
     * shifts only at relationship milestones, clamped one band from the authored value and
     * guarded to `developable` traits; the prompt builder resolves them on top of the
     * authored traits so a bounded personality arc becomes visible/editable, not implicit drift.
     */
    traitOverlays: jsonb("trait_overlays").notNull().default([]),
    /**
     * VoiceExemplar[] ring (character-fidelity slice 8, cap 5): a few distinctly in-voice
     * lines the character actually said, one picked per exchange by the archivist — rendered
     * as a "How you sound" few-shot past the events-only summary horizon. Capped; rolls back
     * with the pre-exchange snapshot like the other rings.
     */
    voiceExemplars: jsonb("voice_exemplars").notNull().default([]),
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
     * Narrative presence (multi-character-chat.plan.md): "present" = sharing the
     * player's scene; "away" = offstage living their life (meters freeze, no
     * memory legs). The ONLY location-like state chat tracks; the roster panel
     * is the manual override, the archivist confirms transitions.
     */
    presence: text("presence", { enum: ["present", "away"] }).notNull().default("present"),
    /**
     * Where an AWAY member is, as a phrase — never a location entity
     * (chat-offscreen-life.plan.md §Whereabouts): written by the archivist's
     * presence read on an away transition and refreshed by the meanwhile pass;
     * rendered in the ensemble's away/salient lines. A PRESENT member with a
     * non-empty whereabouts "just returned" — the tail renders a one-turn
     * came-from license, then it clears.
     */
    whereabouts: text("whereabouts").notNull().default(""),
    /**
     * Consecutive exchanges without this character being mentioned, acting, or
     * being spoken to (activity recency): 0 = active this exchange; ≥ the quiet
     * threshold compresses their prompt blocks to tier 2.
     */
    quietExchanges: integer("quiet_exchanges").notNull().default(0),
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
    /**
     * ChatDrive[] (character-drives.plan.md): the character's runtime drives —
     * authored wants seeded from `profile.drives` plus play's `progress`/`revealed`/
     * `resolved`. The drive prompt law and the archivist's driveUpdates read/write it.
     */
    drives: jsonb("drives").notNull().default([]),
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
    // `chat_look` / `chat_place` (chat-scene-references.plan.md): a conversation's cached
    // render anchors — the outfit-true identity variant and the current place's establishing
    // shot. Chat-keyed, Gallery-hidden (kind-filtered queries), hard-deleted with the chat.
    kind: text("kind", { enum: ["avatar", "portrait_variant", "scene", "entity", "chat_upload", "chat_look", "chat_place"] }).notNull(),
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
    /** Owner's Gallery favorite flag (library-ux.plan.md §Follow-up pass). */
    favorite: boolean("favorite").notNull().default(false),
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
      enum: ["post_turn", "reconcile", "inner_note", "chat_summary", "chat_scene_sketch", "chat_meanwhile", "chat_look_image", "chat_place_image", "scene_image", "chat_scene_image", "avatar", "portrait_variant", "entity_image", "embed_refresh", "image_sweep", "item_classify"],
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


// ---------------------------------------------------------------------------
// Successor simulation authority (engine.spec.md)
// ---------------------------------------------------------------------------

/**
 * Successor-engine world identity and deterministic configuration.
 *
 * Domain identities are supplied explicitly rather than generated by this
 * adapter: event replay and branch forks must preserve them byte-for-byte.
 */
export const simWorlds = pgTable(
  "sim_worlds",
  {
    id: text("id").primaryKey(),
    worldTypeId: text("world_type_id").notNull(),
    seed: text("seed").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    status: text("status", { enum: ["active", "paused", "archived"] }).notNull().default("active"),
    /** Ruling 3: whether explicit forced-entry attempts are admissible here. */
    permitsTrespass: boolean("permits_trespass").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sim_worlds_status_idx").on(t.status)],
);

/**
 * One serial command/event stream and one optimistic version per causal branch.
 *
 * E2.5 ancestry (spec §29.3): a fork child records its parent, fork boundary,
 * and provenance here. A child stores only its own post-fork rows; ancestor
 * events are read through the parent chain bounded by fork_sequence, never
 * copied (plan R4).
 */
export const simBranches = pgTable(
  "sim_branches",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id")
      .notNull()
      .references(() => simWorlds.id, { onDelete: "cascade" }),
    headSequence: bigint("head_sequence", { mode: "number" }).notNull().default(0),
    version: bigint("version", { mode: "number" }).notNull().default(0),
    storySecond: bigint("story_second", { mode: "number" }).notNull().default(0),
    /** The story clock at this branch's origin: seed time for a root, fork time for a child. */
    originStorySecond: bigint("origin_story_second", { mode: "number" }).notNull().default(0),
    parentBranchId: text("parent_branch_id"),
    /** The last ancestor sequence this branch inherits; its own events start after it. */
    forkSequence: bigint("fork_sequence", { mode: "number" }),
    parentRulesetVersion: text("parent_ruleset_version"),
    parentEventSchemaVersion: integer("parent_event_schema_version"),
    forkedByPrincipalKind: text("forked_by_principal_kind", { enum: principalKinds }),
    forkedByPrincipalId: text("forked_by_principal_id"),
    forkReason: text("fork_reason"),
    /** Checksum of the materialized child projection at the fork point (§29.3). */
    inheritedSnapshotChecksum: text("inherited_snapshot_checksum"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sim_branches_world_idx").on(t.worldId),
    index("sim_branches_parent_idx").on(t.parentBranchId),
    unique("sim_branches_id_world_unique").on(t.id, t.worldId),
    // Same-world parentage; NO ACTION (not RESTRICT) so a world cascade that
    // removes parent and child in one statement still passes.
    foreignKey({
      name: "sim_branches_parent_world_fk",
      columns: [t.parentBranchId, t.worldId],
      foreignColumns: [t.id, t.worldId],
    }).onDelete("no action"),
    check(
      "sim_branches_head_sequence_safe",
      sql`${t.headSequence} >= 0 AND ${t.headSequence} <= 9007199254740991`,
    ),
    check(
      "sim_branches_version_safe",
      sql`${t.version} >= 0 AND ${t.version} <= 9007199254740991`,
    ),
    check(
      "sim_branches_story_second_safe",
      sql`${t.storySecond} >= 0 AND ${t.storySecond} <= 9007199254740991`,
    ),
    check(
      "sim_branches_origin_story_second_safe",
      sql`${t.originStorySecond} >= 0 AND ${t.originStorySecond} <= 9007199254740991`,
    ),
    check(
      "sim_branches_fork_sequence_safe",
      sql`${t.forkSequence} IS NULL OR (${t.forkSequence} >= 0 AND ${t.forkSequence} <= 9007199254740991)`,
    ),
    check("sim_branches_not_own_parent", sql`${t.parentBranchId} IS NULL OR ${t.parentBranchId} <> ${t.id}`),
    // Fork provenance is all-or-nothing: a root carries none of it, a child all of it.
    check(
      "sim_branches_fork_shape",
      sql`(${t.parentBranchId} IS NULL AND ${t.forkSequence} IS NULL AND ${t.parentRulesetVersion} IS NULL AND ${t.parentEventSchemaVersion} IS NULL AND ${t.forkedByPrincipalKind} IS NULL AND ${t.forkedByPrincipalId} IS NULL AND ${t.forkReason} IS NULL AND ${t.inheritedSnapshotChecksum} IS NULL) OR (${t.parentBranchId} IS NOT NULL AND ${t.forkSequence} IS NOT NULL AND ${t.parentRulesetVersion} IS NOT NULL AND ${t.parentEventSchemaVersion} IS NOT NULL AND ${t.forkedByPrincipalKind} IS NOT NULL AND ${t.forkedByPrincipalId} IS NOT NULL AND ${t.forkReason} IS NOT NULL AND ${t.inheritedSnapshotChecksum} IS NOT NULL)`,
    ),
  ],
);

/**
 * Every parsed command outcome, including deterministic rejection and
 * optimistic conflict. The branch/idempotency primary key makes a lost response
 * retry return one durable result; command IDs remain auditable even when a
 * duplicate submission is rejected under the branch lock.
 */
export const simCommands = pgTable(
  "sim_commands",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandId: text("command_id").notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    expectedVersion: bigint("expected_version", { mode: "number" }).notNull(),
    principalKind: text("principal_kind", {
      enum: ["player", "npc_policy", "npc_deliberator", "system", "director", "storyteller", "migration"],
    }).notNull(),
    envelope: jsonb("envelope").$type<SimulationCommandEnvelope>().notNull(),
    status: text("status", { enum: ["accepted", "rejected", "conflict"] }).notNull(),
    result: jsonb("result").$type<SimulationCommandResultRecord>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    completedAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "sim_commands_branch_idempotency_pk", columns: [t.branchId, t.idempotencyKey] }),
    index("sim_commands_branch_command_idx").on(t.branchId, t.commandId),
    index("sim_commands_status_idx").on(t.status, t.completedAt),
    check(
      "sim_commands_expected_version_safe",
      sql`${t.expectedVersion} >= 0 AND ${t.expectedVersion} <= 9007199254740991`,
    ),
    check("sim_commands_schema_version_positive", sql`${t.schemaVersion} > 0`),
  ],
);

/** Immutable, schema-versioned successor-engine domain history. */
export const simEvents = pgTable(
  "sim_events",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    storySecond: bigint("story_second", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    derivationVersion: text("derivation_version"),
    commandId: text("command_id"),
    causationId: text("causation_id"),
    correlationId: text("correlation_id").notNull(),
    actorIds: jsonb("actor_ids").$type<string[]>().notNull().default([]),
    entityIds: jsonb("entity_ids").$type<string[]>().notNull().default([]),
    locationId: text("location_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "sim_events_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    uniqueIndex("sim_events_branch_sequence_unique").on(t.branchId, t.sequence),
    unique("sim_events_branch_id_unique").on(t.branchId, t.id),
    index("sim_events_branch_command_idx").on(t.branchId, t.commandId),
    index("sim_events_type_idx").on(t.type),
    check(
      "sim_events_sequence_safe",
      sql`${t.sequence} > 0 AND ${t.sequence} <= 9007199254740991`,
    ),
    check(
      "sim_events_story_second_safe",
      sql`${t.storySecond} >= 0 AND ${t.storySecond} <= 9007199254740991`,
    ),
    check("sim_events_schema_version_positive", sql`${t.schemaVersion} > 0`),
  ],
);

/** Minimum character facts needed by the E2.2 transfer authority view. */
export const simCharacters = pgTable(
  "sim_characters",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    characterId: text("character_id").notNull(),
    name: text("name").notNull(),
    observedContainerIds: jsonb("observed_container_ids").$type<string[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_characters_branch_character_pk", columns: [t.branchId, t.characterId] }),
  ],
);

/** Typed capacity and access facts for an item holding locus. */
export const simHoldingContainers = pgTable(
  "sim_holding_containers",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    holdingContainerId: text("holding_container_id").notNull(),
    kind: text("kind", { enum: ["actor", "location", "container"] }).notNull(),
    name: text("name").notNull(),
    capacity: bigint("capacity", { mode: "number" }).notNull(),
    accessibleToActorIds: jsonb("accessible_to_actor_ids").$type<string[]>().notNull().default([]),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_holding_containers_branch_container_pk",
      columns: [t.branchId, t.holdingContainerId],
    }),
    check(
      "sim_holding_containers_capacity_safe",
      sql`${t.capacity} >= 0 AND ${t.capacity} <= 9007199254740991`,
    ),
  ],
);

/** Stable item identity and display facts, separate from mutable placement. */
export const simItems = pgTable(
  "sim_items",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ name: "sim_items_branch_item_pk", columns: [t.branchId, t.itemId] })],
);

/**
 * One row per item is the database-enforced exclusive holding invariant.
 * updated_sequence identifies the event boundary that last changed placement.
 */
export const simItemHoldings = pgTable(
  "sim_item_holdings",
  {
    branchId: text("branch_id").notNull(),
    itemId: text("item_id").notNull(),
    holdingContainerId: text("holding_container_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_item_holdings_branch_item_pk", columns: [t.branchId, t.itemId] }),
    foreignKey({
      name: "sim_item_holdings_item_fk",
      columns: [t.branchId, t.itemId],
      foreignColumns: [simItems.branchId, simItems.itemId],
    }).onDelete("cascade"),
    foreignKey({
      name: "sim_item_holdings_container_fk",
      columns: [t.branchId, t.holdingContainerId],
      foreignColumns: [simHoldingContainers.branchId, simHoldingContainers.holdingContainerId],
      // Drizzle cannot express FK deferrability. Migration 0054 makes this
      // DEFERRABLE INITIALLY DEFERRED so coherent branch cascades can finish,
      // while a standalone deletion of a live holding container still fails.
    }).onDelete("no action"),
    index("sim_item_holdings_container_idx").on(t.branchId, t.holdingContainerId),
    check(
      "sim_item_holdings_updated_sequence_safe",
      sql`${t.updatedSequence} >= 0 AND ${t.updatedSequence} <= 9007199254740991`,
    ),
  ],
);
/**
 * Delivery obligations created atomically with authoritative simulation events.
 * Consumers may lag or fail; this table and every downstream projection remain
 * disposable coordination state rather than world truth.
 */
export const simOutbox = pgTable(
  "sim_outbox",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    firstSequence: bigint("first_sequence", { mode: "number" }).notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    consumerKind: text("consumer_kind").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    payload: jsonb("payload").$type<{ sourceEventId: string }>().notNull(),
    state: text("state", { enum: ["pending", "processing", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "sim_outbox_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    foreignKey({
      name: "sim_outbox_branch_event_fk",
      columns: [t.branchId, t.sourceEventId],
      foreignColumns: [simEvents.branchId, simEvents.id],
    }).onDelete("cascade"),
    unique("sim_outbox_consumer_event_unique").on(t.consumerKind, t.branchId, t.sourceEventId),
    index("sim_outbox_claim_idx").on(t.consumerKind, t.state, t.availableAt, t.firstSequence),
    index("sim_outbox_branch_sequence_idx").on(t.consumerKind, t.branchId, t.firstSequence),
    check(
      "sim_outbox_sequence_range_safe",
      sql`${t.firstSequence} > 0 AND ${t.firstSequence} <= ${t.lastSequence} AND ${t.lastSequence} <= 9007199254740991`,
    ),
    check("sim_outbox_schema_version_positive", sql`${t.schemaVersion} > 0`),
    check("sim_outbox_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "sim_outbox_processing_has_lease",
      sql`${t.state} <> 'processing' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

/** Greatest contiguous source sequence committed by one consumer on one branch. */
export const simConsumerCheckpoints = pgTable(
  "sim_consumer_checkpoints",
  {
    consumerKind: text("consumer_kind").notNull(),
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    throughSequence: bigint("through_sequence", { mode: "number" }).notNull().default(0),
    projectionSchemaVersion: integer("projection_schema_version").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_consumer_checkpoints_consumer_branch_pk",
      columns: [t.consumerKind, t.branchId],
    }),
    check(
      "sim_consumer_checkpoints_sequence_safe",
      sql`${t.throughSequence} >= 0 AND ${t.throughSequence} <= 9007199254740991`,
    ),
    check(
      "sim_consumer_checkpoints_schema_version_positive",
      sql`${t.projectionSchemaVersion} > 0`,
    ),
  ],
);

/** First disposable async projection: one stable row per transferred item event. */
export const simItemTransferFeed = pgTable(
  "sim_item_transfer_feed",
  {
    consumerKind: text("consumer_kind").notNull(),
    branchId: text("branch_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceSequence: bigint("source_sequence", { mode: "number" }).notNull(),
    storySecond: bigint("story_second", { mode: "number" }).notNull(),
    actorId: text("actor_id").notNull(),
    itemId: text("item_id").notNull(),
    fromContainerId: text("from_container_id").notNull(),
    toContainerId: text("to_container_id").notNull(),
    projectionSchemaVersion: integer("projection_schema_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_item_transfer_feed_consumer_branch_event_pk",
      columns: [t.consumerKind, t.branchId, t.sourceEventId],
    }),
    foreignKey({
      name: "sim_item_transfer_feed_branch_event_fk",
      columns: [t.branchId, t.sourceEventId],
      foreignColumns: [simEvents.branchId, simEvents.id],
    }).onDelete("cascade"),
    unique("sim_item_transfer_feed_branch_sequence_unique").on(
      t.consumerKind,
      t.branchId,
      t.sourceSequence,
    ),
    index("sim_item_transfer_feed_branch_story_idx").on(t.branchId, t.storySecond),
    check(
      "sim_item_transfer_feed_sequence_safe",
      sql`${t.sourceSequence} > 0 AND ${t.sourceSequence} <= 9007199254740991`,
    ),
    check(
      "sim_item_transfer_feed_story_second_safe",
      sql`${t.storySecond} >= 0 AND ${t.storySecond} <= 9007199254740991`,
    ),
    check(
      "sim_item_transfer_feed_schema_version_positive",
      sql`${t.projectionSchemaVersion} > 0`,
    ),
  ],
);

/**
 * Durable requests to evaluate something at a future story second. A trigger is
 * only eligible once branch story time reaches its due second; nothing else makes
 * it due. Lease and attempt columns are disposable coordination state — world
 * truth stays in sim_events.
 */
export const simTriggers = pgTable(
  "sim_triggers",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    kind: text("kind", {
      enum: [
        "scheduled_transfer_item",
        "journey_arrival_due",
        "activity_completion_due",
        "commitment_notice_due",
        "commitment_deadline_due",
        "body_threshold_due",
        "body_condition_expiry_due",
      ],
    }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    dueStorySecond: bigint("due_story_second", { mode: "number" }).notNull(),
    /** Spec §12.1 queue order: lower is more urgent. No producer sets it above 0 yet. */
    priority: integer("priority").notNull().default(0),
    /** Immutable tie-break among triggers sharing one due second and priority. */
    stableOrder: bigint("stable_order", { mode: "number" }).notNull(),
    uniquenessKey: text("uniqueness_key").notNull(),
    payload: jsonb("payload").$type<SimulationTrigger["payload"]>().notNull(),
    state: text("state", { enum: ["pending", "processing", "completed", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    resultCommandId: text("result_command_id"),
    /**
     * Which scheduler ruleset produced this trigger's terminal outcome. Spec
     * §12.1 makes queue order part of the ruleset version, so a later scheduler
     * revision must stay distinguishable in history. Null until resolved.
     */
    derivationVersion: text("derivation_version"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "sim_triggers_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    unique("sim_triggers_branch_uniqueness_unique").on(t.branchId, t.uniquenessKey),
    unique("sim_triggers_branch_order_unique").on(t.branchId, t.stableOrder),
    index("sim_triggers_claim_idx").on(t.state, t.availableAt, t.dueStorySecond, t.stableOrder),
    index("sim_triggers_branch_due_idx").on(t.branchId, t.dueStorySecond, t.stableOrder),
    check("sim_triggers_schema_version_positive", sql`${t.schemaVersion} > 0`),
    check(
      "sim_triggers_due_story_second_safe",
      sql`${t.dueStorySecond} >= 0 AND ${t.dueStorySecond} <= 9007199254740991`,
    ),
    check(
      "sim_triggers_stable_order_safe",
      sql`${t.stableOrder} > 0 AND ${t.stableOrder} <= 9007199254740991`,
    ),
    check("sim_triggers_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "sim_triggers_processing_has_lease",
      sql`${t.state} <> 'processing' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    // A trigger must never dispatch a command into another branch. World equality
    // follows transitively from sim_triggers_branch_world_fk. coalesce keeps a
    // missing key failing rather than passing as a NULL check expression.
    check(
      "sim_triggers_payload_branch_matches",
      sql`coalesce(${t.payload}->'command'->>'branchId', '') = ${t.branchId}`,
    ),
  ],
);

/**
 * Replay checkpoints (spec §10.4). A snapshot carries the full projection
 * payload at its sequence so replay can resume there instead of walking to the
 * root; it may be discarded at any time without changing truth, and tests must
 * periodically rebuild from zero so a wrong snapshot cannot hide a replay
 * defect.
 */
export const simSnapshots = pgTable(
  "sim_snapshots",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    projectionKind: text("projection_kind").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    projectionSchemaVersion: integer("projection_schema_version").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    checksum: text("checksum").notNull(),
    /** Zero marks a range that starts at the non-evented world seed. */
    sourceFirstSequence: bigint("source_first_sequence", { mode: "number" }).notNull(),
    sourceLastSequence: bigint("source_last_sequence", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<SimulationSnapshot["payload"]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "sim_snapshots_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    unique("sim_snapshots_branch_kind_sequence_unique").on(t.branchId, t.projectionKind, t.sequence),
    index("sim_snapshots_branch_idx").on(t.branchId, t.projectionKind, t.sequence),
    check(
      "sim_snapshots_sequence_safe",
      sql`${t.sequence} >= 0 AND ${t.sequence} <= 9007199254740991`,
    ),
    check("sim_snapshots_schema_version_positive", sql`${t.projectionSchemaVersion} > 0`),
    check(
      "sim_snapshots_source_range_safe",
      sql`${t.sourceFirstSequence} >= 0 AND ${t.sourceFirstSequence} <= ${t.sourceLastSequence} AND ${t.sourceLastSequence} <= 9007199254740991`,
    ),
  ],
);

/**
 * E3.1 authoritative space (engine.spec §13). Topology rows are branch-scoped
 * seeded statics like sim_characters — no event mutates them yet, so a fork
 * copies them; loci and journeys are event-projected state.
 */
export const simLocations = pgTable(
  "sim_locations",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    locationId: text("location_id").notNull(),
    kind: text("kind").notNull(),
    coordinateX: real("coordinate_x"),
    coordinateY: real("coordinate_y"),
    defaultAccessPolicy: text("default_access_policy", {
      enum: ["public", "restricted", "private"],
    }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_locations_branch_location_pk", columns: [t.branchId, t.locationId] }),
    check(
      "sim_locations_coordinate_shape",
      sql`(${t.coordinateX} IS NULL) = (${t.coordinateY} IS NULL)`,
    ),
  ],
);

export const simZones = pgTable(
  "sim_zones",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    zoneId: text("zone_id").notNull(),
    locationId: text("location_id").notNull(),
    kind: text("kind").notNull(),
    parentZoneId: text("parent_zone_id"),
    occupancyLimit: integer("occupancy_limit"),
    privacyPolicy: text("privacy_policy", { enum: ["public", "semi_private", "private"] }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_zones_branch_zone_pk", columns: [t.branchId, t.zoneId] }),
    foreignKey({
      name: "sim_zones_branch_location_fk",
      columns: [t.branchId, t.locationId],
      foreignColumns: [simLocations.branchId, simLocations.locationId],
    }).onDelete("cascade"),
    check("sim_zones_not_own_parent", sql`${t.parentZoneId} IS NULL OR ${t.parentZoneId} <> ${t.zoneId}`),
    check("sim_zones_occupancy_positive", sql`${t.occupancyLimit} IS NULL OR ${t.occupancyLimit} > 0`),
  ],
);

export const simLinks = pgTable(
  "sim_links",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    linkId: text("link_id").notNull(),
    fromZoneId: text("from_zone_id").notNull(),
    toZoneId: text("to_zone_id").notNull(),
    modes: jsonb("modes").$type<string[]>().notNull(),
    minimumDurationSeconds: bigint("minimum_duration_seconds", { mode: "number" }).notNull(),
    schedule: jsonb("schedule").$type<{ opensAtStorySecond: number; closesAtStorySecond: number }[]>(),
    accessPolicy: text("access_policy", { enum: ["public", "restricted", "private"] }).notNull(),
    state: text("state", { enum: ["open", "closed", "locked", "blocked"] }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_links_branch_link_pk", columns: [t.branchId, t.linkId] }),
    foreignKey({
      name: "sim_links_branch_from_zone_fk",
      columns: [t.branchId, t.fromZoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
    }).onDelete("cascade"),
    foreignKey({
      name: "sim_links_branch_to_zone_fk",
      columns: [t.branchId, t.toZoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
    }).onDelete("cascade"),
    check("sim_links_not_self_loop", sql`${t.fromZoneId} <> ${t.toZoneId}`),
    check(
      "sim_links_duration_safe",
      sql`${t.minimumDurationSeconds} > 0 AND ${t.minimumDurationSeconds} <= 9007199254740991`,
    ),
  ],
);

/**
 * Exactly one physical locus per actor per branch — the primary key IS the
 * §3.1 invariant. Shape checks keep an `at` row from carrying journey fields
 * and an `in_transit` row from carrying place fields.
 */
export const simPhysicalLoci = pgTable(
  "sim_physical_loci",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    kind: text("kind", { enum: ["at", "in_transit"] }).notNull(),
    locationId: text("location_id"),
    zoneId: text("zone_id"),
    since: bigint("since", { mode: "number" }),
    journeyId: text("journey_id"),
    linkId: text("link_id"),
    enteredAt: bigint("entered_at", { mode: "number" }),
    earliestExitAt: bigint("earliest_exit_at", { mode: "number" }),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_physical_loci_branch_actor_pk", columns: [t.branchId, t.actorId] }),
    foreignKey({
      name: "sim_physical_loci_branch_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("cascade"),
    check(
      "sim_physical_loci_at_shape",
      sql`${t.kind} <> 'at' OR (${t.locationId} IS NOT NULL AND ${t.zoneId} IS NOT NULL AND ${t.since} IS NOT NULL AND ${t.journeyId} IS NULL AND ${t.linkId} IS NULL AND ${t.enteredAt} IS NULL AND ${t.earliestExitAt} IS NULL)`,
    ),
    check(
      "sim_physical_loci_transit_shape",
      sql`${t.kind} <> 'in_transit' OR (${t.journeyId} IS NOT NULL AND ${t.linkId} IS NOT NULL AND ${t.enteredAt} IS NOT NULL AND ${t.earliestExitAt} IS NOT NULL AND ${t.locationId} IS NULL AND ${t.zoneId} IS NULL AND ${t.since} IS NULL)`,
    ),
  ],
);

/**
 * E3.2 authored action catalog: branch-scoped seeded statics (like topology).
 * The typed payload is parsed through actionDefinitionSchema at every read —
 * a definition edit is data, never a migration.
 */
export const simActionDefinitions = pgTable(
  "sim_action_definitions",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    actionDefinitionId: text("action_definition_id").notNull(),
    version: integer("version").notNull(),
    payload: jsonb("payload").$type<SimulationActionDefinition>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_action_definitions_branch_action_pk",
      columns: [t.branchId, t.actionDefinitionId],
    }),
    check("sim_action_definitions_version_positive", sql`${t.version} > 0`),
  ],
);

/**
 * E3.2 activity instances (engine.spec §16.2). Claims are projected from
 * these rows — an actor's held claims are the claims of their non-terminal
 * activities — so a crashed worker can never orphan a claim (§16.3).
 */
export const simActivities = pgTable(
  "sim_activities",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    activityInstanceId: text("activity_instance_id").notNull(),
    actionDefinitionId: text("action_definition_id").notNull(),
    actionVersion: integer("action_version").notNull(),
    actorIds: jsonb("actor_ids").$type<string[]>().notNull(),
    zoneId: text("zone_id").notNull(),
    phase: text("phase", {
      enum: ["queued", "preparing", "active", "paused", "interrupted", "completed", "failed", "cancelled"],
    }).notNull(),
    startedAt: bigint("started_at", { mode: "number" }),
    expectedCompleteAt: bigint("expected_complete_at", { mode: "number" }),
    progressFixedPoint: integer("progress_fixed_point").notNull().default(0),
    claims: jsonb("claims").$type<ActivityClaim[]>().notNull(),
    sourceCommandId: text("source_command_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_activities_branch_activity_pk",
      columns: [t.branchId, t.activityInstanceId],
    }),
    foreignKey({
      name: "sim_activities_branch_zone_fk",
      columns: [t.branchId, t.zoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
    }).onDelete("cascade"),
    index("sim_activities_branch_phase_idx").on(t.branchId, t.phase),
    check("sim_activities_action_version_positive", sql`${t.actionVersion} > 0`),
    check(
      "sim_activities_progress_range",
      sql`${t.progressFixedPoint} >= 0 AND ${t.progressFixedPoint} <= 1000000`,
    ),
  ],
);

/**
 * E3.3 commitments (engine.spec §15). The window and derivation columns are
 * captured at creation (the creating event records them too); status is the
 * §15.4 machine driven by the notice and deadline triggers.
 */
export const simCommitments = pgTable(
  "sim_commitments",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    commitmentId: text("commitment_id").notNull(),
    actorId: text("actor_id").notNull(),
    kind: text("kind", { enum: ["shift", "appointment", "promise", "reservation", "routine"] }).notNull(),
    destinationZoneId: text("destination_zone_id").notNull(),
    earliestArrival: bigint("earliest_arrival", { mode: "number" }),
    targetArrival: bigint("target_arrival", { mode: "number" }),
    latestArrival: bigint("latest_arrival", { mode: "number" }).notNull(),
    expectedDurationSeconds: bigint("expected_duration_seconds", { mode: "number" }),
    priority: integer("priority").notNull().default(0),
    flexibility: text("flexibility", { enum: ["soft", "negotiable", "firm", "hard"] }).notNull(),
    preparationSeconds: bigint("preparation_seconds", { mode: "number" }).notNull().default(0),
    reliabilityBufferSeconds: bigint("reliability_buffer_seconds", { mode: "number" }).notNull().default(0),
    noticeLeadSeconds: bigint("notice_lead_seconds", { mode: "number" }).notNull().default(0),
    status: text("status", {
      enum: [
        "planned",
        "noticed",
        "accepted",
        "declined",
        "in_progress",
        "kept",
        "late",
        "missed",
        "cancelled",
      ],
    }).notNull(),
    knowledgeSource: jsonb("knowledge_source").$type<CommitmentKnowledgeSource>().notNull(),
    sourceCommandId: text("source_command_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_commitments_branch_commitment_pk", columns: [t.branchId, t.commitmentId] }),
    foreignKey({
      name: "sim_commitments_branch_zone_fk",
      columns: [t.branchId, t.destinationZoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
    }).onDelete("cascade"),
    index("sim_commitments_branch_status_idx").on(t.branchId, t.status),
    check(
      "sim_commitments_latest_arrival_safe",
      sql`${t.latestArrival} >= 0 AND ${t.latestArrival} <= 9007199254740991`,
    ),
  ],
);

/** E3.3 temporal pressures (engine.spec §15.2), one per commitment notice. */
export const simTemporalPressures = pgTable(
  "sim_temporal_pressures",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    pressureId: text("pressure_id").notNull(),
    actorId: text("actor_id").notNull(),
    sourceCommitmentId: text("source_commitment_id").notNull(),
    noticeAt: bigint("notice_at", { mode: "number" }).notNull(),
    decideBy: bigint("decide_by", { mode: "number" }).notNull(),
    actBy: bigint("act_by", { mode: "number" }).notNull(),
    severity: text("severity", { enum: ["background", "salient", "urgent", "hard"] }).notNull(),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_temporal_pressures_branch_pressure_pk", columns: [t.branchId, t.pressureId] }),
    foreignKey({
      name: "sim_temporal_pressures_branch_commitment_fk",
      columns: [t.branchId, t.sourceCommitmentId],
      foreignColumns: [simCommitments.branchId, simCommitments.commitmentId],
    }).onDelete("cascade"),
    index("sim_temporal_pressures_branch_actor_idx").on(t.branchId, t.actorId),
    check("sim_temporal_pressures_ordering", sql`${t.noticeAt} <= ${t.decideBy} AND ${t.decideBy} <= ${t.actBy}`),
  ],
);

/**
 * E3.4 engagements (engine.spec §18.1). Attention claims are projected from
 * these rows exactly as activity claims are — a crashed worker cannot orphan
 * a conversation's hold on its participants.
 */
export const simEngagements = pgTable(
  "sim_engagements",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    engagementId: text("engagement_id").notNull(),
    participantIds: jsonb("participant_ids").$type<string[]>().notNull(),
    channel: text("channel", { enum: ["co_present", "text", "voice", "video", "mixed"] }).notNull(),
    locationId: text("location_id"),
    zoneId: text("zone_id"),
    state: text("state", {
      enum: ["opening", "active", "winding_down", "ended", "interrupted"],
    }).notNull(),
    openedAt: bigint("opened_at", { mode: "number" }).notNull(),
    attentionClaim: jsonb("attention_claim").$type<ActivityClaim>().notNull(),
    sourceCommandId: text("source_command_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_engagements_branch_engagement_pk", columns: [t.branchId, t.engagementId] }),
    index("sim_engagements_branch_state_idx").on(t.branchId, t.state),
    check(
      "sim_engagements_co_present_has_zone",
      sql`${t.channel} <> 'co_present' OR ${t.zoneId} IS NOT NULL`,
    ),
  ],
);

/**
 * E3.5 access grants (engine.spec §14). Malformed rows fail closed at read
 * time — a grant that does not parse admits no one.
 */
export const simAccessGrants = pgTable(
  "sim_access_grants",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    grantId: text("grant_id").notNull(),
    granteeActorId: text("grantee_actor_id").notNull(),
    locationId: text("location_id").notNull(),
    zoneIds: jsonb("zone_ids").$type<string[]>(),
    basis: text("basis", {
      enum: ["owner", "resident", "employee", "invitation", "key", "forced"],
    }).notNull(),
    validFrom: bigint("valid_from", { mode: "number" }).notNull(),
    validUntil: bigint("valid_until", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_access_grants_branch_grant_pk", columns: [t.branchId, t.grantId] }),
    index("sim_access_grants_branch_actor_idx").on(t.branchId, t.granteeActorId),
  ],
);

/**
 * E4.1 observation log (engine.spec §20): one row per (event, witness),
 * derived deterministically from the event stream — a rebuilt branch mints
 * identical rows, which is why observation ids are derived, not random.
 * No FK to sim_events: a forked child holds observations for ancestor-branch
 * events it reads by reference (R4), never copies.
 */
export const simObservations = pgTable(
  "sim_observations",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    observationId: text("observation_id").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    sourceEventSequence: bigint("source_event_sequence", { mode: "number" }).notNull(),
    witnessActorId: text("witness_actor_id").notNull(),
    storySecond: bigint("story_second", { mode: "number" }).notNull(),
    channel: text("channel", {
      enum: ["embodied", "sight", "sound", "touch", "smell", "device", "social"],
    }).notNull(),
    evidenceClass: text("evidence_class", {
      enum: ["direct", "sensory", "reported", "inferred"],
    }).notNull(),
    confidenceFixedPoint: integer("confidence_fixed_point").notNull(),
    detailTier: integer("detail_tier").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "sim_observations_branch_observation_pk", columns: [t.branchId, t.observationId] }),
    index("sim_observations_branch_witness_sequence_idx").on(
      t.branchId,
      t.witnessActorId,
      t.sourceEventSequence,
    ),
    index("sim_observations_branch_event_idx").on(t.branchId, t.sourceEventId),
    check(
      "sim_observations_sequence_safe",
      sql`${t.sourceEventSequence} > 0 AND ${t.sourceEventSequence} <= 9007199254740991`,
    ),
    check(
      "sim_observations_story_second_safe",
      sql`${t.storySecond} >= 0 AND ${t.storySecond} <= 9007199254740991`,
    ),
    check(
      "sim_observations_confidence_range",
      sql`${t.confidenceFixedPoint} >= 0 AND ${t.confidenceFixedPoint} <= 10000`,
    ),
    check("sim_observations_detail_tier_range", sql`${t.detailTier} >= 1 AND ${t.detailTier} <= 3`),
  ],
);

/**
 * E4.2 assertions (engine.spec §21.1): claims made on a branch — possibly
 * false; canon truth stays in sim_events. Rows are derived deterministically
 * from disclosure events (ids embed the originating event), so a rebuilt
 * branch mints identical rows. No FK to sim_events for the same reason as
 * sim_observations: a forked child references ancestor events, never copies.
 */
export const simAssertions = pgTable(
  "sim_assertions",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    assertionId: text("assertion_id").notNull(),
    propositionKey: text("proposition_key").notNull(),
    subjectIds: jsonb("subject_ids").$type<string[]>().notNull(),
    claimedValue: jsonb("claimed_value").$type<unknown>().notNull(),
    sourceActorId: text("source_actor_id"),
    sourceEventId: text("source_event_id"),
    sourceEventSequence: bigint("source_event_sequence", { mode: "number" }),
    assertedAt: bigint("asserted_at", { mode: "number" }).notNull(),
    validFrom: bigint("valid_from", { mode: "number" }),
    validUntil: bigint("valid_until", { mode: "number" }),
    status: text("status", {
      enum: ["active", "contradicted", "superseded", "retracted"],
    }).notNull(),
    statusChangedAt: bigint("status_changed_at", { mode: "number" }),
    statusCauseEventId: text("status_cause_event_id"),
    derivationVersion: text("derivation_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_assertions_branch_assertion_pk", columns: [t.branchId, t.assertionId] }),
    index("sim_assertions_branch_proposition_idx").on(t.branchId, t.propositionKey),
    index("sim_assertions_branch_source_event_idx").on(t.branchId, t.sourceEventId),
    check(
      "sim_assertions_asserted_at_safe",
      sql`${t.assertedAt} >= 0 AND ${t.assertedAt} <= 9007199254740991`,
    ),
    check(
      "sim_assertions_validity_order",
      sql`${t.validFrom} IS NULL OR ${t.validUntil} IS NULL OR ${t.validFrom} <= ${t.validUntil}`,
    ),
  ],
);

/**
 * E4.2 beliefs (engine.spec §21.2): one actor's held stance toward an
 * assertion, with provenance — the observations it rests on and the chain of
 * tellers it travelled through. Superseded rows keep their history; the
 * active row is the holder's current stance.
 */
export const simBeliefs = pgTable(
  "sim_beliefs",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    beliefId: text("belief_id").notNull(),
    holderActorId: text("holder_actor_id").notNull(),
    assertionId: text("assertion_id").notNull(),
    confidenceFixedPoint: integer("confidence_fixed_point").notNull(),
    basisObservationIds: jsonb("basis_observation_ids").$type<string[]>().notNull(),
    learnedFromActorIds: jsonb("learned_from_actor_ids").$type<string[]>().notNull(),
    believedFrom: bigint("believed_from", { mode: "number" }).notNull(),
    believedUntil: bigint("believed_until", { mode: "number" }),
    status: text("status", {
      enum: ["active", "doubted", "rejected", "superseded"],
    }).notNull(),
    statusCauseEventId: text("status_cause_event_id"),
    sourceEventId: text("source_event_id").notNull(),
    sourceEventSequence: bigint("source_event_sequence", { mode: "number" }).notNull(),
    derivationVersion: text("derivation_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_beliefs_branch_belief_pk", columns: [t.branchId, t.beliefId] }),
    foreignKey({
      name: "sim_beliefs_branch_assertion_fk",
      columns: [t.branchId, t.assertionId],
      foreignColumns: [simAssertions.branchId, simAssertions.assertionId],
    }).onDelete("cascade"),
    index("sim_beliefs_branch_holder_status_idx").on(t.branchId, t.holderActorId, t.status),
    index("sim_beliefs_branch_assertion_idx").on(t.branchId, t.assertionId),
    check(
      "sim_beliefs_confidence_range",
      sql`${t.confidenceFixedPoint} >= 0 AND ${t.confidenceFixedPoint} <= 10000`,
    ),
    check(
      "sim_beliefs_sequence_safe",
      sql`${t.sourceEventSequence} > 0 AND ${t.sourceEventSequence} <= 9007199254740991`,
    ),
    check(
      "sim_beliefs_interval_order",
      sql`${t.believedUntil} IS NULL OR ${t.believedFrom} <= ${t.believedUntil}`,
    ),
  ],
);

/**
 * E4.3 persisted NarrativeCuts (engine.spec §22). A cut row is IMMUTABLE and
 * addressable: rerender re-reads it and creates nothing; a failed narrator
 * render retries from the same row (ruling 8); armed speech acts confirm
 * against it by id (§23.3). There is deliberately no update path and no
 * updated_at — recompiling the same cut id must reproduce semantic_hash or
 * fail with a version diagnostic (§22.3).
 */
export const simNarrativeCuts = pgTable(
  "sim_narrative_cuts",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    cutId: text("cut_id").notNull(),
    engagementId: text("engagement_id").notNull(),
    viewpointActorId: text("viewpoint_actor_id").notNull(),
    compilerVersion: text("compiler_version").notNull(),
    semanticHash: text("semantic_hash").notNull(),
    branchVersion: bigint("branch_version", { mode: "number" }).notNull(),
    fromSequence: bigint("from_sequence", { mode: "number" }).notNull(),
    throughSequence: bigint("through_sequence", { mode: "number" }).notNull(),
    fromStorySecond: bigint("from_story_second", { mode: "number" }).notNull(),
    throughStorySecond: bigint("through_story_second", { mode: "number" }).notNull(),
    /** The full parsed §22.1 cut — the row IS the render input, bit for bit. */
    content: jsonb("content").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "sim_narrative_cuts_branch_cut_pk", columns: [t.branchId, t.cutId] }),
    index("sim_narrative_cuts_branch_engagement_idx").on(t.branchId, t.engagementId, t.throughSequence),
    check(
      "sim_narrative_cuts_sequence_order",
      sql`${t.fromSequence} >= 0 AND ${t.throughSequence} >= ${t.fromSequence}`,
    ),
    check(
      "sim_narrative_cuts_story_second_order",
      sql`${t.fromStorySecond} >= 0 AND ${t.throughStorySecond} >= ${t.fromStorySecond}`,
    ),
  ],
);

/**
 * E4.3 soft canon (engine.spec §23.4, ruling 14): the bounded expiring store
 * of narrator-established details. Rows are derived — every soft_canon_*
 * event carries its full post-fold snapshot, so live upsert and fork replay
 * mint identical rows. Expiry is read-time (valid_until), never a status
 * write; promotion and demotion are audited status moves.
 */
export const simSoftCanon = pgTable(
  "sim_soft_canon",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    key: text("key").notNull(),
    scope: text("scope", {
      enum: ["scene", "relationship", "character", "location", "world"],
    }).notNull(),
    subjectIds: jsonb("subject_ids").$type<string[]>().notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    confidenceFixedPoint: integer("confidence_fixed_point").notNull(),
    firstRecordedAt: bigint("first_recorded_at", { mode: "number" }).notNull(),
    lastRecordedAt: bigint("last_recorded_at", { mode: "number" }).notNull(),
    validUntil: bigint("valid_until", { mode: "number" }),
    sourceCutIds: jsonb("source_cut_ids").$type<string[]>().notNull(),
    status: text("status", { enum: ["active", "promoted", "demoted"] }).notNull(),
    statusChangedAt: bigint("status_changed_at", { mode: "number" }),
    statusCauseEventId: text("status_cause_event_id"),
    rulesVersion: text("rules_version").notNull(),
    derivationVersion: text("derivation_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_soft_canon_branch_entry_pk", columns: [t.branchId, t.entryId] }),
    index("sim_soft_canon_branch_scope_status_idx").on(t.branchId, t.scope, t.status),
    check(
      "sim_soft_canon_confidence_range",
      sql`${t.confidenceFixedPoint} >= 0 AND ${t.confidenceFixedPoint} <= 10000`,
    ),
    check(
      "sim_soft_canon_recorded_order",
      sql`${t.firstRecordedAt} >= 0 AND ${t.lastRecordedAt} >= ${t.firstRecordedAt}`,
    ),
  ],
);

/**
 * E4.4 memory documents (engine.spec §24): redacted, indexable recall
 * representations derived from persisted source rows by the memory-index
 * outbox consumer. Eligibility, validity, and privacy are resolved
 * relationally at query time (§24.1) — this table never widens what any
 * viewpoint may see; a missing or stale row only narrows recall.
 */
export const simMemoryDocuments = pgTable(
  "sim_memory_documents",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    docId: text("doc_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["observation", "assertion", "belief", "speech_act", "soft_canon", "authored_lore"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceEventId: text("source_event_id"),
    firstSequence: bigint("first_sequence", { mode: "number" }).notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" }).notNull(),
    storySecond: bigint("story_second", { mode: "number" }).notNull(),
    visibility: text("visibility", { enum: ["public", "actors", "belief_holders"] }).notNull(),
    eligibleActorIds: jsonb("eligible_actor_ids").$type<string[]>().notNull(),
    aboutEntityIds: jsonb("about_entity_ids").$type<string[]>().notNull(),
    validFromSecond: bigint("valid_from_second", { mode: "number" }).notNull(),
    validUntilSecond: bigint("valid_until_second", { mode: "number" }),
    supersededAtSecond: bigint("superseded_at_second", { mode: "number" }),
    epistemicLabel: text("epistemic_label").notNull(),
    confidenceFixedPoint: integer("confidence_fixed_point"),
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    docSchemaVersion: integer("doc_schema_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_memory_documents_branch_doc_pk", columns: [t.branchId, t.docId] }),
    index("sim_memory_documents_branch_kind_idx").on(t.branchId, t.sourceKind),
    index("sim_memory_documents_branch_sequence_idx").on(t.branchId, t.firstSequence),
    check(
      "sim_memory_documents_sequence_order",
      sql`${t.firstSequence} >= 0 AND ${t.lastSequence} >= ${t.firstSequence}`,
    ),
    check(
      "sim_memory_documents_embedding_named",
      sql`(${t.embedding} IS NULL) = (${t.embeddingModel} IS NULL)`,
    ),
  ],
);

export const simJourneys = pgTable(
  "sim_journeys",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    journeyId: text("journey_id").notNull(),
    actorIds: jsonb("actor_ids").$type<string[]>().notNull(),
    originZoneId: text("origin_zone_id").notNull(),
    destinationZoneId: text("destination_zone_id").notNull(),
    routeLinkIds: jsonb("route_link_ids").$type<string[]>().notNull(),
    travelMode: text("travel_mode").notNull(),
    departedAt: bigint("departed_at", { mode: "number" }),
    earliestArrivalAt: bigint("earliest_arrival_at", { mode: "number" }).notNull(),
    expectedArrivalAt: bigint("expected_arrival_at", { mode: "number" }).notNull(),
    status: text("status", {
      enum: ["planned", "active", "delayed", "interrupted", "arrived", "abandoned"],
    }).notNull(),
    currentLinkIndex: integer("current_link_index").notNull().default(0),
    routeDerivationVersion: text("route_derivation_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_journeys_branch_journey_pk", columns: [t.branchId, t.journeyId] }),
    check("sim_journeys_not_self_journey", sql`${t.originZoneId} <> ${t.destinationZoneId}`),
    check(
      "sim_journeys_arrival_order",
      sql`${t.expectedArrivalAt} >= ${t.earliestArrivalAt}`,
    ),
    check("sim_journeys_link_index_nonnegative", sql`${t.currentLinkIndex} >= 0`),
  ],
);

/**
 * E5.1 body meters (engine.spec §25.2). One row per actor × meter; the value
 * is fixed-point (10 000 ≡ 1.0) and `last_integrated_at` is the last MATERIAL
 * write — queries integrate analytically from here and never persist, which
 * is what makes partition invariance structural.
 */
export const simBodyMeters = pgTable(
  "sim_body_meters",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    meterKey: text("meter_key").notNull(),
    valueFixedPoint: integer("value_fixed_point").notNull(),
    baselineFixedPoint: integer("baseline_fixed_point").notNull(),
    lastIntegratedAt: bigint("last_integrated_at", { mode: "number" }).notNull(),
    registryVersion: text("registry_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_body_meters_branch_actor_meter_pk", columns: [t.branchId, t.actorId, t.meterKey] }),
    check(
      "sim_body_meters_value_fixed_point_range",
      sql`${t.valueFixedPoint} >= 0 AND ${t.valueFixedPoint} <= 10000`,
    ),
    check(
      "sim_body_meters_baseline_fixed_point_range",
      sql`${t.baselineFixedPoint} >= 0 AND ${t.baselineFixedPoint} <= 10000`,
    ),
    check(
      "sim_body_meters_last_integrated_safe",
      sql`${t.lastIntegratedAt} >= 0 AND ${t.lastIntegratedAt} <= 9007199254740991`,
    ),
  ],
);

/** E5.1 body conditions (engine.spec §25.1): categorical, sourced, self-expiring. */
export const simBodyConditions = pgTable(
  "sim_body_conditions",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    conditionId: text("condition_id").notNull(),
    actorId: text("actor_id").notNull(),
    key: text("key", {
      enum: ["asleep", "collapsed", "afterglow", "groggy", "wired", "ill"],
    }).notNull(),
    onsetAt: bigint("onset_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }),
    status: text("status", { enum: ["active", "ended"] }).notNull(),
    endBasis: text("end_basis", { enum: ["expired", "cleared"] }),
    endedAt: bigint("ended_at", { mode: "number" }),
    sourceEventId: text("source_event_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_body_conditions_branch_condition_pk", columns: [t.branchId, t.conditionId] }),
    index("sim_body_conditions_branch_actor_status_idx").on(t.branchId, t.actorId, t.status),
    check(
      "sim_body_conditions_end_basis_matches_status",
      sql`(${t.status} = 'ended') = (${t.endBasis} IS NOT NULL)`,
    ),
  ],
);

/**
 * E5.2 rhythm rows (engine.spec §25.5) — authored branch-scoped daily
 * windows, copied to fork children like action definitions. Sleep windows
 * anchor the circadian curve; wash windows are window-crossing self-care.
 */
export const simBodyRhythms = pgTable(
  "sim_body_rhythms",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    kind: text("kind", { enum: ["sleep", "wash"] }).notNull(),
    startMinuteOfDay: integer("start_minute_of_day").notNull(),
    endMinuteOfDay: integer("end_minute_of_day").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_body_rhythms_branch_actor_kind_start_pk",
      columns: [t.branchId, t.actorId, t.kind, t.startMinuteOfDay],
    }),
    check(
      "sim_body_rhythms_minutes_range",
      sql`${t.startMinuteOfDay} >= 0 AND ${t.startMinuteOfDay} <= 1439 AND ${t.endMinuteOfDay} >= 0 AND ${t.endMinuteOfDay} <= 1439`,
    ),
  ],
);

/**
 * E5.1 body modifiers — the one §25.3 contract. Validity boundaries are
 * integration boundaries; expiry needs no trigger because the piecewise
 * solver already sees `valid_until`.
 */
export const simBodyModifiers = pgTable(
  "sim_body_modifiers",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    modifierId: text("modifier_id").notNull(),
    actorId: text("actor_id").notNull(),
    meterKey: text("meter_key").notNull(),
    operation: jsonb("operation").$type<BodyModifierOperation>().notNull(),
    stackingGroup: text("stacking_group").notNull(),
    priority: integer("priority").notNull().default(0),
    validFrom: bigint("valid_from", { mode: "number" }).notNull(),
    validUntil: bigint("valid_until", { mode: "number" }),
    visibility: text("visibility", { enum: ["obvious", "private"] }).notNull(),
    conditionId: text("condition_id"),
    sourceEventId: text("source_event_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_body_modifiers_branch_modifier_pk", columns: [t.branchId, t.modifierId] }),
    foreignKey({
      name: "sim_body_modifiers_branch_condition_fk",
      columns: [t.branchId, t.conditionId],
      foreignColumns: [simBodyConditions.branchId, simBodyConditions.conditionId],
    }).onDelete("cascade"),
    index("sim_body_modifiers_branch_actor_meter_idx").on(t.branchId, t.actorId, t.meterKey),
    check(
      "sim_body_modifiers_validity_order",
      sql`${t.validUntil} IS NULL OR ${t.validUntil} > ${t.validFrom}`,
    ),
  ],
);
