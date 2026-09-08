import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
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
import type {
  SimulationCommandEnvelope,
  SimulationCommandResultRecord,
  SimulationSnapshot,
} from "@vesper/simulation-core/contracts/branching";
import type { ActivityClaim, SimulationActionDefinition } from "@vesper/simulation-core/contracts/activities";
import type { BodyModifierOperation } from "@vesper/simulation-core/contracts/bodies";
import type { CohortPresenceWindow } from "@vesper/simulation-core/contracts/cohorts";
import type { CommitmentKnowledgeSource } from "@vesper/simulation-core/contracts/commitments";
import type {
  ContainerAccessPolicy,
  ItemConsumptionEffect,
  ItemLocus,
} from "@vesper/simulation-core/contracts/materials";
import { simulationTriggerKinds, type SimulationTrigger } from "@vesper/simulation-core/contracts/scheduler";
import type {
  HouseholdStockAccessPolicy,
  RestockFunding,
} from "@vesper/simulation-core/contracts/households";
import type { RelationshipLedgerPayload } from "@vesper/simulation-core/contracts/social";
import {
  identityLoraBindingStates,
  identityReferenceStrategies,
  imageAspectModes,
  imageEditKinds,
  imageIdentityCropMethods,
  imageIdentityPackStatuses,
  imageIdentityPreservationRatings,
  imageLabControlKinds,
  imageLabExperimentKinds,
  imageLabExperimentStatuses,
  imageLabModes,
  imageLabVerdicts,
  imageLoraLocatorTypes,
  imageProfileOperations,
  imageProfileTasks,
  imagePromptStrategies,
  imageReferenceArities,
  imageReferenceTransports,
  sceneReferenceSources,
  sceneVisualReferenceKinds,
  trialCellStatuses,
  trialRunStatuses,
  trialVerdicts,
} from "@vesper/image-core";
import { principalKinds } from "@vesper/simulation-core/contracts/envelopes";
import { itemGoneBases } from "@vesper/simulation-core/contracts/materials";
import { itemMaterialFeedEventKinds } from "@vesper/simulation-core/contracts/outbox";
import {
  householdMemberRoles,
  householdMembershipStatuses,
  materialQuantityKinds,
  meansBandKeys,
} from "@vesper/simulation-core/contracts/households";
import {
  relationshipLedgerKinds,
  relationshipLedgerProvenances,
} from "@vesper/simulation-core/contracts/social";
import { inferenceLods } from "@vesper/simulation-core/contracts/deliberation";
import { simulationLods } from "@vesper/simulation-core/contracts/lod";
import { newId } from "@/lib/ids";
import { imageGeneratorRunStatuses } from "@/contracts/images/image-generator";
import { referenceViewMethods, referenceViewStatuses, referenceViewVerdicts } from "@/contracts/images/reference-views";
import {
  visualExtractionProposalStatuses,
  visualExtractionRunStatuses,
  visualExtractionTargetOwners,
} from "@/contracts/visual-state/extraction";

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
 * Accounts. Owns its core columns for Better Auth's Drizzle
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
   * The persona pre-selected for new chats — the
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
 * Better Auth session tokens. Named `auth_sessions` to avoid the
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
    /**
     * The portrait **candidate** — the picture on screen in the portrait studio,
     * on the library card, and in the chat strip. Generating, uploading,
     * promoting or cloning a portrait writes this pointer and nothing else.
     *
     * A **soft pointer** (no FK) so deleting an image can never cascade into the
     * character row; the delete paths null it instead.
     */
    avatarImageId: text("avatar_image_id"),
    /**
     * The **identity source**: the portrait the owner accepted as this
     * character's face. Every identity-sensitive read — the identity pack and
     * its crop editor, chat looks, scene cast anchors, the lab's identity
     * reference — resolves from here, never from the candidate, so trying a new
     * portrait cannot change how existing renders recognize the character.
     *
     * Acceptance is a claim about an image ID, never a boolean: the previous
     * accepted portrait has to stay nameable while a newer candidate sits
     * unaccepted. `accepted_at` records when the claim was made. Both are
     * cleared together — by the owner clearing acceptance, and by the delete of
     * whatever image this names.
     *
     * A **soft pointer** (no FK) for exactly the reason `avatar_image_id` is one.
     */
    acceptedAvatarImageId: text("accepted_avatar_image_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /**
     * Cross-account **share scope**. `private` ⇒ owner-only;
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
     * tab. A per-entity scalar, not part of the resettable `character_chat_state` row
     * (so chat resets never clear it) and not in the `profile` jsonb the editor's
     * SaveBar rewrites (so an immediate save can't be clobbered). Empty ⇒ the chat
     * default (`DEFAULT_CHARACTER_CHAT_MODEL_ID`).
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
 * **Personas** — the player as a library entity: who *you*
 * are in a chat, with a body, a wardrobe and a bio. The graduated successor to the
 * single inline `users.player_persona` blob (one per account); a chat picks one.
 *
 * Deliberately NOT a row in `characters`: a "self" character would clutter every
 * library list and need a `kind` discriminator + filtering everywhere, which is
 * why the inline blob came first and this table is its graduation.
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
 * A conversation (docs/character-chat/):
 * the chat lane's first-class record — the transcript, rolling summary, and
 * per-participant state hang off `chat_id`, so one character can host many
 * stories (a long-running main thread beside a fresh alternate-universe
 * scenario). Membership is the `chat_participants` join table (a roster of up to
 * 4, sort 0 = the primary participant). The multi-character substrate shipped
 * 2026-07-12: the exchange runs the
 * ensemble frame at a roster over 1 and is byte-identical at a roster of 1, and
 * scene images render every member whose `presence` is "present". The
 * `turn_context` layout is the piece that stays 1-on-1-only.
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
    // --- The chat-wide SCENARIO: what belongs to the
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
    /**
     * Admin-only **scene composer** model override (a curated
     * `SCENE_COMPOSER_MODELS` id — lib/composer-models.ts). "" ⇒ the curated
     * default, which is every chat that has never been switched.
     *
     * A sibling of `agentReasoningProfile` rather than of `sceneModel`, and
     * deliberately NOT on the scenario: this is operational configuration for
     * comparing composer models, not story state, so retakes and state rollback
     * must never change it. (`sceneModel` picks the IMAGE model that paints the
     * shot; this picks the TEXT model that plans it.)
     */
    sceneComposerModel: text("scene_composer_model").notNull().default(""),
    /**
     * **Visual-state narration**, per conversation and OFF by default.
     *
     * On, the narrator receives the visual projection's two blocks — a short
     * must-not-contradict fence of what is visibly true, and at most two details
     * that just changed or just came into view — and the conversation's narrator
     * cue state is committed with each exchange.
     *
     * A per-chat switch rather than a deploy-wide flag (owner ruling 2026-08-17)
     * because the paid round could not measure the benefit: the trial's own gate
     * refused a verdict, so this ships as something to turn on and read rather
     * than something to enable everywhere. Operational configuration, not story
     * state — retakes and state rollback never change it, exactly like
     * `agentReasoningProfile` beside it.
     */
    visualStateNarration: boolean("visual_state_narration").notNull().default(false),
    /**
     * Admin-only structured-agent reasoning experiment. This is operational
     * configuration, not story state: retakes and state rollback never change it.
     */
    agentReasoningProfile: text("agent_reasoning_profile", {
      enum: ["off", "continuity", "synthesis", "broad_post_turn"],
    })
      .notNull()
      .default("off"),
    /**
     * The Narrator Prompt Lab template this conversation is experimenting with
     * — `null`, the default and every
     * pre-feature row, means Vesper's production narrator instructions.
     *
     * A sibling of `agentReasoningProfile` above, and for the same reason: this
     * is **operational configuration, not story state**. Retakes, regenerate,
     * rerun, state reset and simulation rollback never change it, it is not part
     * of `ChatScenario`, and no scenario preset carries it. Per CHAT rather than
     * per character on purpose — two conversations with the same character must
     * be able to run different instruction prompts for a parallel A/B.
     *
     * A real FK with `ON DELETE SET NULL`, which is the integrity backstop for a
     * genuine hard delete only. The NORMAL delete is SOFT (`deleted_at`), and
     * `softDeleteNarratorPromptTemplate` explicitly clears live selections in the
     * same transaction — those conversations fall back to production instructions
     * on their next exchange while the immutable revisions stay put, so historical
     * take provenance still resolves. Resolution is fail-open regardless: a
     * selection that does not resolve degrades to production with a diagnostic
     * rather than dead-ending the conversation.
     */
    narratorPromptTemplateId: text("narrator_prompt_template_id").references(
      () => narratorPromptTemplates.id,
      { onDelete: "set null" },
    ),
    /** ChatSceneMemory — the shared imagined setting. */
    sceneMemory: jsonb("scene_memory").notNull().default({}),
    /**
     * `ChatPlayerState` (contracts/players/chat-player-state.ts) — **who the player is
     * in this conversation and what they're wearing**. Chat-wide, like every other
     * field in this block: one player, many roster
     * characters. `{}` ⇒ no pick ⇒ the resolver falls to the owner's default persona.
     *
     * ONE jsonb column rather than five, following `scene_memory`'s precedent — field
     * additions here are never migrations. Parsed with `parseOr` at the read boundary.
     * It rides the `pre_exchange_scenario` rollback snapshot, so "another take" can't
     * leave the player undressed by a beat that no longer exists.
     */
    playerState: jsonb("player_state").notNull().default({}),
    /**
     * `ChatGarmentStore` (contracts/items/garment-instance.ts) — the conversation's
     * GARMENT INSTANCES and their content-hash-deduplicated blueprint snapshots.
     *
     * Chat-WIDE, and one field rather than a table, for one reason: rollback. The
     * whole "another take" guarantee is "one jsonb blob per anchor, restored
     * wholesale", so a scenario field inherits `pre_exchange_scenario` +
     * `rollbackScenario` with zero new snapshot machinery — while a table would
     * need per-exchange row copies of its own. Chat-wide because a garment sits at
     * loci no character owns (`scene`, `wardrobe`, `gone`) and moves between body,
     * hands and room, and because the two live writes are not one transaction:
     * a cross-blob transfer could duplicate or lose a garment on a partial degrade.
     *
     * `{}` (the default and every pre-feature row) parses to the empty, UNSEEDED
     * store, which materializes from `worn_item_ids` + `player_state` on the next
     * state write. Parsed with `parseOr` at the read boundary.
     */
    garments: jsonb("garments").notNull().default({}),
    /**
     * `ChatEnvironment` (contracts/state/chat-environment.ts) — the scene's WIND,
     * PRECIPITATION and enclosure (body-attribute-affordances slice 4). The chat
     * lane's first authoritative weather owner: the continuity extraction leg
     * proposes a typed patch, `applyEnvironmentProposal` commits it, and the
     * affordance adapter reads THIS rather than the narrator's sentence about the
     * sky. Chat-wide like `scene_memory` (one setting for the roster) and on the
     * scenario, so it rides `pre_exchange_scenario` and rolls back for free.
     *
     * Nullable: pre-feature rows are `null`, which the load boundary reads as the
     * empty (indoors, still, dry) environment without a diagnostic.
     */
    environment: jsonb("environment"),
    /**
     * `AffordanceCueState` (contracts/affordances/core/ranking.ts) — what the
     * affordance read has already offered the narrator, and in which band
     * (body-attribute-affordances slice 4; the garment `cues` precedent).
     *
     * It lives beside the state it describes for ONE reason: the affordance read
     * is a pure function of committed state plus this memory, so restoring both
     * from the same rollback anchor is what makes a retake reproduce the identical
     * read. Written when the read reaches the prompt; until then it rides
     * through untouched.
     */
    affordanceCues: jsonb("affordance_cues"),
    /**
     * `SceneState` (contracts/affordances/scene/state.ts) — where the bodies are,
     * how they are configured, what holds them up, and the contact core's
     * active-contact projection HOUSED inside it (romantic-contact-affordances
     * slice 3A; the affectionate integration proof).
     *
     * Chat-WIDE because a scene has no owner: proximity is a fact about a PAIR
     * and a contact spans two bodies, so there is no per-character state row it
     * could sit on without being half a truth. On the SCENARIO for the reason
     * `affordance_cues` is — the physical read is a pure function of committed
     * state plus this placement, so restoring both from the one
     * `pre_exchange_scenario` anchor is what makes "another take" reproduce the
     * identical read instead of resolving against a beat that no longer exists.
     *
     * This column is the PROJECTION; the durable provenance is the
     * `chat_contact_events` ledger, which replays back into exactly this value
     * (`replayContactCommits`). That is what keeps the two from becoming two
     * truths — the projection may always be rebuilt from the events.
     *
     * Nullable: pre-feature rows are `null`, which the load boundary reads as the
     * empty scene (nobody placed) WITHOUT a diagnostic. Anything actually stored
     * crosses `parseSceneState`, which is total and fail-closed on version.
     */
    scene: jsonb("scene"),
    /** SupportingCastMember[] — recurring named side characters. */
    supportingCast: jsonb("supporting_cast").notNull().default([]),
    /** ChatPlan[] — tracked commitments that come due on the story clock. */
    plans: jsonb("plans").notNull().default([]),
    /** The chat-local game clock (the only time model) — one timeline for the roster. */
    clockMinutes: integer("clock_minutes").notNull().default(0),
    /**
     * CalendarStart — the story-calendar anchor for clock_minutes:
     * minute 0 = this date+time. `{}` (the
     * default and every pre-feature row) heals to CHAT_DEFAULT_CALENDAR_START
     * (Jan 1, 8:00am) at the load boundary. Author-editable.
     */
    calendarStart: jsonb("calendar_start").notNull().default({}),
    pendingSkipNote: text("pending_skip_note").notNull().default(""),
    /**
     * The meanwhile pass's one-shot narrator note — composes with
     * pending_skip_note, cleared with it. "" = none pending.
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
    /**
     * R1: which lane owns this chat's world truth —
     * `legacy_chat` (default; successor not consulted) · `successor_shadow` ·
     * `successor_narrative_view` · `successor_authoritative`. Flipped only
     * through the audited admin route; read through
     * `readChatEngineAuthority`'s fail-closed boundary, never raw.
     */
    engineAuthority: text("engine_authority", {
      enum: ["legacy_chat", "successor_shadow", "successor_narrative_view", "successor_authoritative"],
    })
      .notNull()
      .default("legacy_chat"),
    /** Successor recall routing — orthogonal to the lane (contracts/simulation/authority.ts). */
    successorRagEligibility: boolean("successor_rag_eligibility").notNull().default(false),
    /**
     * The successor branch this chat's world maps onto (null until linked).
     * SET NULL on branch teardown: authority reads then degrade to
     * legacy-lane behavior rather than pointing at a ghost.
     */
    simBranchId: text("sim_branch_id").references(() => simBranches.id, { onDelete: "set null" }),
    /** R3: the sim actor the PLAYER embodies in the linked branch (null = unmapped). */
    simPlayerActorId: text("sim_player_actor_id"),
    /** R3: the sim actor the chat's primary character embodies (null = unmapped). */
    simPrimaryActorId: text("sim_primary_actor_id"),
    createdAt: createdAt(),
    /** Recency anchor for the Chats list; bumped on every exchange. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The "has something to say" seen-cursor: stamped when the player OPENS
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
 * Chat membership. `memory_group_id`
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
 * Reusable scenario setups: a nameable
 * premise/outfit/cards/starting-stage bundle, seeded into a new conversation's
 * state exactly the way the scenario modal writes those fields. A small owned
 * table now; `LibraryKind` graduation (sharing/cloning) later if wanted.
 */
/**
 * Per-conversation directed relationship matrix: one row per (chat, from, to)
 * roster pair — the chat analogue of
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
     * Alternate takes on an assistant reply:
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
 * Rolling background summary for one character chat. One row per
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
 * Character-chat state (docs/character-chat/state.md). One row per
 * (chatId, characterId) — a multi-character roster holds one row per member:
 * the character's tracked state beside the
 * message window, the rolling summary, and the chat-scoped facts/episodes —
 * the full meter registry, the two relationship axes, optional self-expiring
 * conditions, a dynamic "what's on their mind" note, the starting outfit +
 * exposure, narrative presence + activity recency, and the RAG carry-overs
 * (memory queries, attribute overlays, traces). Chat-WIDE fields — premise,
 * house rules, scene memory/prefs, the story clock — live on `character_chats`
 * (the scenario). A pure CREATE (not an extension of
 * character_chat_summaries) so the migration never hits drizzle's rename
 * prompt and the pulse stays independent of the summary fold. No row ⇒ a fresh
 * stateless chat; the first POST lazily seeds one. Lifecycle: `deleteChat`
 * removes the chat row and everything hanging off it — state rows, transcript,
 * summary, chat memory (D4).
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
     * fan-out applied — the rollback
     * target for "another take". Overwritten each exchange; `{}` ⇒ none.
     */
    preExchangeState: jsonb("pre_exchange_state").notNull().default({}),
    /** Record<string,number> — the full meter registry, carried verbatim (seeded from initialMeters()). */
    meters: jsonb("meters").notNull().default({}),
    /**
     * −100…100, the FEELING axis toward the player persona (was `affinity`) —
     * volatile, moved by the reaction pulse. Seeded from the authored
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
     * Record<string,string> — the meter bands last surfaced as a "just shifted" beat,
     * `{ meterId: band }`. The anti-repetition
     * gate diffs current bands against this so an unchanged state never re-fires a beat.
     */
    surfacedCues: jsonb("surfaced_cues").notNull().default({}),
    /**
     * string[] — the structured worn item-definition ids, seeded from the active
     * outfit preset. When non-empty, THIS is the wardrobe truth: the
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
     * string[] — the chat archivist's memory-retrieval queries for the NEXT turn,
     * mirroring the session director's `memoryQueries`.
     * Produced post-turn, consumed at the next prompt build to seed RAG recall.
     */
    memoryQueries: jsonb("memory_queries").notNull().default([]),
    /**
     * AttributeValue[] — persisted narrative attribute overlays that EVOLVE over a chat:
     * the attribute proposer merges `source:"narrative"`
     * overlays here (inherent traits guarded), and the prompt builder resolves them on top of
     * the authored base. Distinct from the transient condition overlays (render-time only).
     */
    attributeOverlays: jsonb("attribute_overlays").notNull().default([]),
    /**
     * TraitValue[] — persisted narrative TRAIT overlays that evolve over a chat:
     * the archivist proposes `source:"narrative"` trait
     * shifts only at relationship milestones, clamped one band from the authored value and
     * guarded to `developable` traits; the prompt builder resolves them on top of the
     * authored traits so a bounded personality arc becomes visible/editable, not implicit drift.
     */
    traitOverlays: jsonb("trait_overlays").notNull().default([]),
    /**
     * VoiceExemplar[] ring (cap 5): a few distinctly in-voice
     * lines the character actually said, one picked per exchange by the archivist — rendered
     * as a "How you sound" few-shot past the events-only summary horizon. Capped; rolls back
     * with the pre-exchange snapshot like the other rings.
     */
    voiceExemplars: jsonb("voice_exemplars").notNull().default([]),
    /**
     * ChatMemoryTrace — last-turn RAG debug: what was retrieved + extracted this
     * exchange, for the dev inspector. Parsed defensively.
     */
    lastMemoryTrace: jsonb("last_memory_trace").notNull().default({}),
    /**
     * string[] — the character's unfinished business: ≤3 short phrases the
     * archivist re-emits in full each exchange (resolved loops
     * fall off naturally). Rendered as an "Unfinished business" state line, shown in the
     * relationship panel, and read by the "has something to say" derivation.
     */
    openLoops: jsonb("open_loops").notNull().default([]),
    /**
     * RelationshipSample[] ring (cap ~200): `{at, clockMinutes, affinity, stage}`
     * appended by the finalizer when affinity moved or the stage crossed — the sparkline.
     */
    relationshipHistory: jsonb("relationship_history").notNull().default([]),
    /**
     * Milestone[] (append-only, capped): first exchange, stage changes (both
     * directions), strong card-driven reactions, player-marked moments — each
     * `{at, kind, label, messageId?}`.
     */
    milestones: jsonb("milestones").notNull().default([]),
    /**
     * Narrative presence: "present" = sharing the
     * player's scene; "away" = offstage living their life (meters freeze, no
     * memory legs). The ONLY location-like state chat tracks; the roster panel
     * is the manual override, the archivist confirms transitions.
     */
    presence: text("presence", { enum: ["present", "away"] }).notNull().default("present"),
    /**
     * Where an AWAY member is, as a phrase — never a location entity:
     * written by the archivist's
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
     * CallbackEntry[] ring: episode refs already offered as
     * an unprompted "remember when" cue, plus the chat-clock minute each fired — the
     * anti-repeat memory behind the cadence gate. Capped (CHAT_CALLBACK_HISTORY_CAP);
     * rolls back with the pre-exchange snapshot like the rest of the state.
     */
    callbackHistory: jsonb("callback_history").notNull().default([]),
    /**
     * ChatFeelingState (engine/chat-feeling.ts): the
     * persistent feeling (label + derived intensity + cause, exchange-decayed) and
     * the bruise (damped positive regard gains after a betrayal at high regard).
     * One jsonb blob so shape growth is never a migration; parsed defensively.
     */
    feeling: jsonb("feeling").notNull().default({}),
    /**
     * SelfieEntry[] ring: recorded selfie sends (request/offer
     * + chat-clock minute) — the unprompted-offer cooldown's memory. Capped; rolls
     * back with the pre-exchange snapshot like the rest of the state.
     */
    selfieHistory: jsonb("selfie_history").notNull().default([]),
    /**
     * ChatDrive[]: the character's runtime drives —
     * authored wants seeded from `profile.drives` plus play's `progress`/`revealed`/
     * `resolved`. The drive prompt law and the archivist's driveUpdates read/write it.
     */
    drives: jsonb("drives").notNull().default([]),
    /**
     * `BodySurfaceState` (contracts/state/body-surface.ts) — this character's
     * per-body-location surface wetness (body-attribute-affordances slice 4):
     * fixed-point levels with the story minute they last changed and what wet
     * them, drying lazily on the story clock (the garment-condition precedent).
     *
     * PER CHARACTER, so it lives here rather than on the scenario — one head of
     * hair belongs to one person. Extraction-proposed and clamped by the reducer;
     * it rides `storedChatStateSchema`, so "another take" restores the soaking
     * along with everything else. Nullable: pre-feature rows read as dry.
     */
    bodySurface: jsonb("body_surface"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.characterId] })],
);

/**
 * Observer-scoped visual memory: what ONE observer has noticed about ONE
 * subject's recognizable features, and when the narrator last said it out loud.
 *
 * Scoped to the chat MEMORY GROUP rather than the chat, by the owner ruling that
 * governs every other chat memory: "continue our shared history" reuses the
 * group and therefore retains recognition, while a fresh/AU conversation mints a
 * new group and starts as strangers. `viewpoint_id` is the observer — the chat
 * owner's user id in this lane, the successor's actor id later — and it is on the
 * primary key precisely so observer A's memory can never appear in observer B's
 * read.
 *
 * TWO GENERATIONS, one row. `features` is the memory as of the last applied
 * exchange and `applied_message_id` names that exchange's prompting message;
 * `features_before` is the state it advanced FROM. A retake re-runs the same
 * prompting message id, so the store hands back `features_before` and recomputes
 * from the identical pre-exchange memory — which is what makes "retake does not
 * double-increment notice or mention counts" true without an event ledger.
 *
 * The two jsonb columns hold `VisualMemoryState`
 * (contracts/affordances/recognition/visual-memory.ts) and cross the trust
 * boundary through `parseOr` in `visual-memory-store.ts`; a corrupt blob heals to
 * "this observer has noticed nothing" rather than costing a turn.
 */
export const chatVisualMemory = pgTable(
  "chat_visual_memory",
  {
    memoryGroupId: text("memory_group_id").notNull(),
    viewpointId: text("viewpoint_id").notNull(),
    subjectId: text("subject_id").notNull(),
    features: jsonb("features").notNull().default({}),
    featuresBefore: jsonb("features_before"),
    appliedMessageId: text("applied_message_id"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.memoryGroupId, t.viewpointId, t.subjectId] })],
);

/**
 * NARRATOR VISUAL CUE STATE (the cue-state
 * contract in contracts/visual-state/cue-state.ts): for ONE observer and ONE
 * subject, when each repeat family was last in view and when the narrator last
 * said it.
 *
 * A SEPARATE table from `chat_visual_memory`, deliberately. The two records are
 * disjoint by construction — memory holds what an observer could recognize,
 * this holds everything recognition refuses (a rolled sleeve, a posture, an
 * occupied hand) — and keeping them apart is what stops a transient body-language
 * fact from ever reaching the recognition floor, the cap, or the decay law.
 * Sharing the memory row's columns would also have made the two-generation
 * shuffle below unsound: two upserts against one row in one exchange, and the
 * second sees an `applied_message_id` the first already stamped.
 *
 * The key and the retake law are otherwise identical to
 * `chat_visual_memory` — memory group, observer, subject; `cues` is the state as
 * of the last applied exchange, `cues_before` the state it advanced from, and
 * `applied_message_id` the exchange guard that decides which one a load returns.
 *
 * Both jsonb columns hold `VisualCueState` and cross the trust boundary through
 * `parseOr` in `visual-cue-store.ts`; a corrupt blob heals to "nothing has been
 * seen yet" rather than costing a turn.
 */
export const chatVisualCues = pgTable(
  "chat_visual_cues",
  {
    memoryGroupId: text("memory_group_id").notNull(),
    viewpointId: text("viewpoint_id").notNull(),
    subjectId: text("subject_id").notNull(),
    cues: jsonb("cues").notNull().default({}),
    cuesBefore: jsonb("cues_before"),
    appliedMessageId: text("applied_message_id"),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.memoryGroupId, t.viewpointId, t.subjectId] })],
);

/**
 * The chat lane's DURABLE CONTACT LEDGER (romantic-contact-affordances — the
 * affectionate integration proof): every `ContactLifecycleCommit` an exchange
 * produced, stamped with the exchange that produced it.
 *
 * The ruled law is **durable event/action provenance plus a versioned
 * active-contact projection captured in the chat's retake snapshot — never
 * prompt-local**. This table is the provenance half; `character_chats.scene`
 * (the `SceneState` riding `ChatScenario`, and therefore `pre_exchange_scenario`)
 * is the projection half. Nothing about what is touching may live only in a
 * rendered prompt, which is what the lane had before this: a sentence.
 *
 * ## Retakes
 *
 * `guard_message_id` is the exchange guard (`promptMessageId ?? assistantMessageId`)
 * — the same key `chat_visual_memory` and both rollback anchors take, so the
 * whole exchange rolls back to one boundary. "Another take" restores the
 * projection through `pre_exchange_scenario` and DELETES this guard's rows
 * (`deleteChatContactEventsForGuard`) before the new take re-runs the leg, so a
 * regenerated exchange leaves one ledger entry per thing that happened rather
 * than one per attempt. The guard FK also CASCADES, so deleting a message takes
 * its contact provenance with it — the same trade `chat_visual_memory` makes,
 * and the right one: an exchange that no longer exists cannot go on justifying
 * what is touching.
 *
 * ## Why the idempotency key is (chat, event ref, sequence)
 *
 * One lane event can commit SEVERAL contacts at once: `contactCommitEvents` puts
 * the ends that freed a surface pair ahead of the start that claimed it, and
 * every one of them carries the same `ContactEventRef`. So the event ref alone
 * cannot be unique. `sequence` is the commit's index within that event's commit
 * list, which a retried write re-derives identically — the same event replayed
 * produces the same (event_ref, sequence) pairs and conflicts harmlessly instead
 * of duplicating the ledger.
 *
 * `payload` is the serialized commit, carried verbatim: this table records what
 * happened, it does not interpret it (`chat-contact-events.ts` hands the blob
 * back as `unknown` and leaves the shape to the contact core's own parser).
 */
export const chatContactEvents = pgTable(
  "chat_contact_events",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    /** The exchange guard — the retake key (`chat_visual_memory`'s precedent). */
    guardMessageId: text("guard_message_id")
      .notNull()
      .references(() => characterChatMessages.id, { onDelete: "cascade" }),
    /** The contact core's `ContactEventRef` for the lane event this commit belongs to. */
    eventRef: text("event_ref").notNull(),
    /** This commit's index within that event's commit list — the second half of the idempotency key. */
    sequence: integer("sequence").notNull(),
    /**
     * The `ContactLifecycleCommit` discriminant. `contact_continued` is in the
     * vocabulary and never written: an unchanged held contact across ten
     * exchanges is ONE start, not ten rows. Naming it anyway keeps a later
     * decision to record holds a data change rather than a migration.
     */
    kind: text("kind", {
      enum: ["contact_started", "contact_updated", "contact_continued", "contact_ended"],
    }).notNull(),
    /** The contact this commit is about (`ContactId` — derived, so a replay reproduces it). */
    contactId: text("contact_id").notNull(),
    /** The story-clock minute the commit landed on (`ChatScenario.clockMinutes`). */
    storyMinute: integer("story_minute").notNull(),
    /** The serialized `ContactLifecycleCommit`. Never interpreted here. */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chat_contact_events_event_sequence_unique").on(t.chatId, t.eventRef, t.sequence),
    // The retake delete's index — one exchange's rows, by the guard it hangs on.
    index("chat_contact_events_chat_guard_idx").on(t.chatId, t.guardMessageId),
    // The reader's order (createdAt, then sequence within one event).
    index("chat_contact_events_chat_created_idx").on(t.chatId, t.createdAt),
  ],
);

/**
 * The chat lane's DURABLE ROMANTIC-PERMISSION LEDGER (owner rulings settled
 * 2026-08-04): every `RomanticPermissionEvent`
 * a producer committed — a future NPC-side grant/denial/withdrawal decision, or
 * an audited developer override — stamped with the exchange that produced it.
 *
 * The branch is the CHAT (`branchId == character_chats.id`, ruled): character
 * chat has no separate branch entity, so branch-local means chat-scoped rows
 * behind a cascade FK. There is deliberately NO stored projection column — the
 * active projection (current standing grants) is a pure fold over these rows,
 * computed on read (`foldRomanticPermissionProjection`), so a retake that
 * prunes rows restores the projection by construction.
 *
 * ## Retakes
 *
 * `guard_message_id` is the exchange guard (`promptMessageId ?? assistantMessageId`)
 * — the same key `chat_contact_events` and both rollback anchors take, so the
 * whole exchange rolls back to one boundary. "Another take" DELETES this
 * guard's rows (`deleteChatPermissionEventsForGuard`) beside the contact
 * ledger's prune, unconditionally, so a discarded reply's grant, denial, or
 * withdrawal cannot survive into the replacement take. The FK CASCADES, so a
 * hard-deleted message takes its permission provenance with it.
 *
 * NULLABLE, unlike the contact ledger's guard, for exactly one case: a
 * developer override recorded while the chat has no messages yet has no
 * exchange to hang on, and refusing it would make an empty chat untestable.
 * Production NPC events always set it.
 *
 * ## Why the idempotency key is (chat, event ref, sequence)
 *
 * One producer call can commit several events at once (both directions of a
 * mutual grant, a denial beside a withdrawal), all sharing one event ref —
 * `permission-reply:<assistantMessageId>` for NPC-decision events,
 * `permission-override:<eventId>` for developer overrides (namespaces disjoint
 * from the contact ledger's `contact:`/`contact-reply:`). `sequence` is the
 * event's index within that call's list, re-derived identically by a retry, so
 * a replayed write conflicts harmlessly instead of duplicating the ledger —
 * and the conflict is then VERIFIED against the stored row's content, exactly
 * as the contact append does.
 *
 * `payload` is the serialized `RomanticPermissionEvent`, carried verbatim: this
 * table records what happened, it does not interpret it
 * (`chat-permission-events.ts` hands the blob back as `unknown` and leaves the
 * shape to the permission contracts' own parser). The typed columns beside it
 * (`kind`, `source_kind`, the direction pair, `scope`) are queryable copies for
 * the verified-conflict judgment and the dev inspector, never a second truth.
 */
export const chatPermissionEvents = pgTable(
  "chat_permission_events",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    /** The exchange guard — the retake key. Null ONLY for pre-message developer overrides. */
    guardMessageId: text("guard_message_id").references(() => characterChatMessages.id, { onDelete: "cascade" }),
    /** The producer call's ref (`permission-reply:…` / `permission-override:…`). */
    eventRef: text("event_ref").notNull(),
    /** This event's index within that call's event list — the second half of the idempotency key. */
    sequence: integer("sequence").notNull(),
    /** The `RomanticPermissionEventKind` discriminant. */
    kind: text("kind", {
      enum: ["granted", "attempt_denied", "withdrawn", "relationship_revoked", "developer_overridden"],
    }).notNull(),
    /** Which authority produced it. `relationship_transition` is reserved — no producer yet. */
    sourceKind: text("source_kind", {
      enum: ["npc_decision", "relationship_transition", "developer_override"],
    }).notNull(),
    /** Who may attempt the contact (the directional key's first half). */
    permittedActorId: text("permitted_actor_id").notNull(),
    /** Whose authoritative side authored the event (the directional key's second half). */
    grantingTargetId: text("granting_target_id").notNull(),
    /** The exact scope. Always `romantic_touch` today; stored as the string it is. */
    scope: text("scope").notNull(),
    /** The story-clock minute the event landed on (`ChatScenario.clockMinutes`). */
    storyMinute: integer("story_minute").notNull(),
    /** The serialized `RomanticPermissionEvent`. Never interpreted here. */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chat_permission_events_event_sequence_unique").on(t.chatId, t.eventRef, t.sequence),
    // The retake delete's index — one exchange's rows, by the guard it hangs on.
    index("chat_permission_events_chat_guard_idx").on(t.chatId, t.guardMessageId),
    // The reader's order (createdAt, then sequence within one event).
    index("chat_permission_events_chat_created_idx").on(t.chatId, t.createdAt),
  ],
);

/**
 * The NPC reply-scene DECISION ENVELOPE — one row per persisted assistant
 * message that ran the reply-scene leg. Movement commits and EMPTY outcomes
 * need durable
 * identity as much as contact rows do: a trigger miss, a degraded classifier
 * call, and an all-rejected proposal set are tombstones the retry/reuse logic
 * reads, not absences it re-runs — the same assistant reply is never
 * reclassified into different authority.
 *
 * This table is the TRACE. There is deliberately no best-effort
 * `lastSceneDecisionTrace` field on the chat: the dev inspector reads the
 * newest non-pruned envelope instead, so the record it explains is the record
 * the transaction actually committed.
 *
 * ## The retake guard
 *
 * (chat_id, assistant_message_id) is UNIQUE — the assistant message IS the
 * retake guard. Concurrent first writers race on this key: one wins, and a
 * loser whose envelope is not canonical-byte-equivalent fails closed
 * (`chat-npc-scene-envelope.ts` owns the guarded transaction). "Another take"
 * deletes this row unconditionally beside the `pre_exchange_scenario`
 * restoration, and both FKs CASCADE so a hard-deleted reply (or chat) takes its
 * decision record with it — the same backstop `chat_contact_events` has.
 *
 * ## What the columns pin
 *
 * `reply_hash`/`digest_hash` tie the decision to the exact persisted reply
 * bytes and the classifier digest it read; `base_scene_hash`/
 * `result_scene_hash` fingerprint the pre/post scene projections so replay can
 * prove what the decision saw and what it left. `payload` carries the bounded
 * parsed-slot outcomes, grounded spans/hashes, gate-drop reasons, normalized
 * ordered actions (the actual committed scene intents, not only the model
 * candidates), resolver outcomes, contact-row references, and model/latency
 * telemetry — parsed at the read boundary, never trusted.
 */
export const chatNpcSceneDecisions = pgTable(
  "chat_npc_scene_decisions",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    /** The assistant reply this decision is about — the retake guard. */
    assistantMessageId: text("assistant_message_id")
      .notNull()
      .references(() => characterChatMessages.id, { onDelete: "cascade" }),
    /** sha256 hex of the exact persisted reply bytes (utf8). */
    replyHash: text("reply_hash").notNull(),
    /** sha256 hex of the canonical classifier digest; "" when no digest was assembled (trigger miss). */
    digestHash: text("digest_hash").notNull(),
    /** The decision-output schema version this envelope was produced under. */
    schemaVersion: integer("schema_version").notNull(),
    /** `shadow` (no authority granted) versus `authority`. */
    mode: text("mode", { enum: ["shadow", "authority"] }).notNull(),
    /** The post-settle story-clock minute, truncated ONCE for the whole envelope. */
    storyMinute: integer("story_minute").notNull(),
    /** All three are durable tombstones — an empty outcome is as idempotent as a commit. */
    status: text("status", { enum: ["trigger_miss", "degraded", "evaluated"] }).notNull(),
    /** Exact fingerprint of the post-settle scene the decision resolved against. */
    baseSceneHash: text("base_scene_hash").notNull(),
    /** Exact fingerprint of the projection the decision left behind. */
    resultSceneHash: text("result_scene_hash").notNull(),
    /** `NpcSceneDecisionPayload` — bounded, parsed defensively at the read boundary. */
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // The retake guard AND the first-writer race's arbiter: one decision per reply.
    uniqueIndex("chat_npc_scene_decisions_assistant_unique").on(t.chatId, t.assistantMessageId),
    // The inspector's newest-envelope read.
    index("chat_npc_scene_decisions_chat_created_idx").on(t.chatId, t.createdAt),
  ],
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
    /** Cross-account share scope — see characters.visibility. */
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
 * them as world_links. FK-cascade so deleting either endpoint
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
    /** Cross-account share scope — see characters.visibility. */
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
    /** Cross-account share scope — see items.visibility. */
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
// Memory
// ---------------------------------------------------------------------------

export const episodes = pgTable(
  "episodes",
  {
    id: id(),
    /**
     * Memory-group keying — the chat lane's scope, the only memory scope now
     * (the session lane is gone).
     * `turnNumber` is a per-group exchange ordinal.
     */
    chatMemoryGroupId: text("chat_memory_group_id"),
    turnNumber: integer("turn_number").notNull(),
    summary: text("summary").notNull(),
    threadIds: jsonb("thread_ids").notNull().default([]),
    /** Participant ids present for the turn — interim co-location semantics; write-only until the knowledge ledger ships. */
    witnessedBy: jsonb("witnessed_by").notNull().default([]),
    /**
     * Chat-lane provenance: the assistant
     * message this episode summarizes. Deletion targets this, not the ordinal —
     * a shared memory group spans conversations, so ordinals alone are ambiguous.
     */
    sourceMessageId: text("source_message_id"),
    embedding: embedding(),
    embedder: text("embedder"),
    createdAt: createdAt(),
  },
  (t) => [
    index("episodes_chat_group_idx").on(t.chatMemoryGroupId, t.turnNumber),
    index("episodes_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: id(),
    /** Memory-group keying — the chat lane's scope, the only memory scope now. */
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
     * Player/dev-pinned ("remember this"): always
     * retrieved ahead of the top-k, exempt from the relevance floor, and never superseded
     * or retracted by an archivist-extracted fact (the asymmetric invariant) — only a
     * player/dev-authored fact (or the inspector) can retire it.
     */
    pinned: boolean("pinned").notNull().default(false),
    /**
     * Honest provenance: who authored this fact — the background archivist
     * ("extracted", the default), the player's "remember this" ("player"), or a dev
     * inspector edit ("dev").
     */
    origin: text("origin", { enum: ["extracted", "player", "dev"] }).notNull().default("extracted"),
    /**
     * The channel this fact was established through (the RAG visibility fence).
     * TEXT with headroom (NOT a pg enum — forward-compatible-schema
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
     * Chat-lane provenance: the assistant
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
    index("facts_chat_group_idx").on(t.chatMemoryGroupId, t.status),
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
    // `chat_upload`: a player-attached chat photo — input-only
    // (never an identity anchor or edit reference), Gallery-hidden, hard-deleted with its
    // message/conversation (unlike scenes, which SET NULL and survive). The drizzle enum is
    // type-level only, so adding a kind is never a migration.
    // `chat_look` / `chat_place`: a conversation's cached
    // render anchors — the outfit-true identity variant and the current place's establishing
    // shot. Chat-keyed, Gallery-hidden (kind-filtered queries), hard-deleted with the chat.
    // `identity_face_crop`: the hidden face crop an
    // identity pack derives from the character's canonical portrait — an internal render
    // input, never a user-visible asset. It must be excluded from EVERY listing, clone
    // and cross-owner read; `HIDDEN_IMAGE_KINDS` in `src/server/images/asset-storage.ts` names
    // those surfaces.
    // `identity_trial_output`: a render produced by
    // an admin identity-pack trial cell — operational evidence, never a Gallery asset.
    // Hidden like the face crop (same `HIDDEN_IMAGE_KINDS` surfaces); its owner still
    // reads it through the file route, which is how the blinded review UI displays it.
    // Swept when its trial run is deleted, AND with its character — an image survives
    // its character iff its kind is Gallery-listable, and this one is not, so it goes
    // too (`deleteNonGalleryCharacterImages` in `src/server/images/asset-deletion.ts`).
    // `lab_control` / `lab_output`: the Advanced Image Lab's control fixtures
    // (pose skeleton, depth map, edge map) and
    // its experiment renders. Admin-only operational evidence, never Gallery items —
    // hidden exactly like `identity_trial_output`, and owned solely by the lab module.
    // `generator_output`: an Image
    // Generator run's render — admin bench evidence with no entity/chat association,
    // hidden exactly like `lab_output` and deleted with its run.
    // `reference_view`: one slot of a character's reference view SET — the accepted
    // portrait re-rendered from another angle, in one of two wardrobe states
    // (`character_reference_views`). Hidden exactly like `identity_face_crop`: an
    // owner-reviewed render INPUT, never a Gallery asset, absent from the portrait
    // strip, from clones, from the public file widening and from the storage quota,
    // and deleted with its character. Its owner reads it through the ordinary owner
    // file route, which is how the studio's view grid displays it.
    kind: text("kind", { enum: ["avatar", "portrait_variant", "scene", "entity", "chat_upload", "chat_look", "chat_place", "identity_face_crop", "identity_trial_output", "lab_control", "lab_output", "generator_output", "reference_view"] }).notNull(),
    entityKind: text("entity_kind", { enum: ["character", "location", "item", "world"] }),
    entityId: text("entity_id"),
    /**
     * The conversation a chat scene was rendered for: scopes the scene
     * list/scrub per chat instead of character-wide.
     * SET NULL so deleting a chat keeps the asset in the Gallery. Null on legacy rows
     * and non-chat images.
     */
    chatId: text("chat_id").references(() => characterChats.id, { onDelete: "set null" }),
    /**
     * The assistant message this scene illustrates — the inline-transcript
     * anchor. Plain text, no FK: messages are individually deletable, and a dangling
     * anchor just means the image renders in the strip only. Captured at queue time
     * (newest assistant line for manual renders; the exchange's reply for auto).
     */
    anchorMessageId: text("anchor_message_id"),
    /** Relative to data/, e.g. images/<ownerId>/<imageId>.webp */
    path: text("path").notNull(),
    /**
     * Encoded size of the stored webp. `writeWebpAtomic`
     * already reported this into `meta.bytes`; promoting it to a column makes the
     * per-owner storage quota a `SUM(bytes)` over an indexed column rather than a JSONB
     * scan. Deliberately **derived, never a counter** — every delete path reclaims quota
     * for free, and no decrement can be forgotten. 0 on a pending or failed row.
     */
    bytes: integer("bytes").notNull().default(0),
    prompt: text("prompt").notNull().default(""),
    sourceImageId: text("source_image_id"),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull().default("pending"),
    /** Owner's Gallery favorite flag. */
    favorite: boolean("favorite").notNull().default(false),
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("images_owner_idx").on(t.ownerId),
    index("images_entity_idx").on(t.entityKind, t.entityId),
    index("images_chat_idx").on(t.chatId),
  ],
);

/**
 * What a scene image featured / was anchored on — one row per reference.
 * The queryable source of truth that replaced the
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

/**
 * The image-model registry. Which Replicate
 * models the app can run is DATA, not a code union: rows here are managed from
 * the admin page at `/settings/image-models`, and the portrait/variant/scene
 * pickers read them. Seeded with six models by migration; seeded rows are
 * ordinary rows (owner ruling 4 — `builtin` marks them for display, it does not
 * gate deletion).
 *
 * The capability columns are filled by a save-time probe of Replicate's model
 * schema, EXCEPT `maxReferences`: no model declares `maxItems` on its array
 * reference input, so the cap is stored and hand-editable rather than derived.
 *
 * The enum-typed columns reuse the contract vocabularies (`imageAspectModes`,
 * `imageReferenceArities`) so the column and the parser can never drift.
 */
export const imageModels = pgTable(
  "image_models",
  {
    id: id(),
    /** Replicate model path, optionally `owner/name:version`. */
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    /** Can run with no reference (its reference input is not in `required`). */
    canGenerate: boolean("can_generate").notNull().default(true),
    /** Has a reference input at all — says nothing about identity preservation. */
    canEdit: boolean("can_edit").notNull().default(false),
    /**
     * The input key references are written to. Differs per model (`image` /
     * `image_input` / `images`) and cannot be assumed from the model family:
     * both Qwen models call it `image` with different arities.
     */
    referenceField: text("reference_field").notNull().default("image"),
    referenceArity: text("reference_arity", { enum: imageReferenceArities }).notNull().default("array"),
    /**
     * How reference bytes reach the model: an uploaded file URL (`file`, the
     * default every model but Wan wants) or an inlined `data:` URI. Not
     * derivable from the schema — see the contract's `imageReferenceTransports`.
     */
    referenceTransport: text("reference_transport", { enum: imageReferenceTransports })
      .notNull()
      .default("file"),
    maxReferences: integer("max_references").notNull().default(1),
    aspectMode: text("aspect_mode", { enum: imageAspectModes }).notNull().default("aspect_ratio"),
    /**
     * Every shape the model offers, verbatim from its schema enum. The render
     * path picks the closest to what a lane wants and crops the rest, so one
     * mechanism serves the 3:4 lanes, Stable Diffusion 3.5 Large (which has no
     * 3:4), and the 1:1 / 3:2 entity lanes alike.
     */
    supportedAspects: jsonb("supported_aspects").notNull().default([]),
    /** Null when the model has no such input (Seedream 4.5, Wan 2.7). */
    outputFormat: text("output_format"),
    /** Per-model payload constants (e.g. `max_images: 1`). */
    extraInput: jsonb("extra_input").notNull().default({}),
    /**
     * The Replicate version whose schema produced the mechanical columns above.
     * Null on every row seeded or probed before this column existed. Exists so the
     * admin card can say a pinned `owner/name:version` slug no longer matches the
     * version the stored bindings were read from — the way a control silently
     * starts being sent to a field that moved between versions.
     */
    probedVersionId: text("probed_version_id"),
    /**
     * REVIEWED, never probed: what this model's "editing" actually does.
     * `canEdit` is true for anything with an image input, which lumps
     * `qwen/qwen-image-edit-2511` (follows an instruction, keeps the face) in with
     * `stability-ai/stable-diffusion-3.5-large` (strength repainting that can hand
     * back a different person). A re-probe must never overwrite these two ratings —
     * a schema cannot tell you whether a face survived.
     */
    editKind: text("edit_kind", { enum: imageEditKinds }).notNull().default("unknown"),
    /** REVIEWED: how well a face survives a render. Gates identity-critical tasks. */
    identityPreservation: text("identity_preservation", { enum: imageIdentityPreservationRatings })
      .notNull()
      .default("unknown"),
    /**
     * Operator-facing caveat shown on the admin card and in pickers, not a failure
     * class. Wan 2.7 is what forced it: its upstream moderation cannot be disabled
     * and has refused ordinary character references, which an operator needs told
     * before choosing the model rather than after a rejected render.
     */
    operatorWarning: text("operator_warning"),
    /**
     * `ImageModelAdvancedCapabilities` (contracts/images/image-model-capabilities.ts):
     * probed optional control bindings, dedicated structural image inputs,
     * provider-input descriptors, output arity, and the known-input-field
     * allowlist for a profile's `providerOverrides`.
     *
     * Written atomically beside `probedVersionId` at probe time; rows probed
     * before a given derivation existed simply lack that section, and the
     * contract parses `{}` into an inert set where no optional control is sent.
     */
    advancedCapabilities: jsonb("advanced_capabilities").notNull().default({}),
    forPortrait: boolean("for_portrait").notNull().default(false),
    forVariant: boolean("for_variant").notNull().default(false),
    forScene: boolean("for_scene").notNull().default(false),
    builtin: boolean("builtin").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    /**
     * Column only — deliberately absent from `imageModelSchema`. The record crosses
     * to the client as JSON, so carrying a timestamp forces a date-serialization
     * decision (Date vs ISO string vs epoch) that no consumer needs until the admin
     * version card has to show when a model was last probed.
     */
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("image_models_slug_idx").on(t.slug)],
);

/**
 * Per-task profiles beneath a model row. A model row says what Replicate will
 * ACCEPT; a profile
 * says how Vesper should USE it for one job. The same Seedream row is an everyday
 * 2K scene model on one surface and a slow 4K location model on another, and one
 * permanent `extraInput` bag on the parent cannot express that difference — which
 * is the entire reason this table exists rather than more columns up there.
 *
 * A profile may NARROW its model (fewer reference roles, a tighter timeout, fixed
 * controls) but never claim a capability the model lacks. That is enforced in code
 * at resolution time (`profileEligibility`), not by a constraint here, so a
 * reviewed rating downgrade on the parent takes its profiles out of service
 * without a migration.
 *
 * Seeded with 17 rows by migration 0100, each describing what its lane already
 * does; like model rows they are ordinary rows (`builtin` marks them for display,
 * it does not gate deletion). The enum columns reuse the contract vocabularies so
 * column and parser cannot drift.
 */
export const imageModelProfiles = pgTable(
  "image_model_profiles",
  {
    id: id(),
    imageModelId: text("image_model_id")
      .notNull()
      .references(() => imageModels.id, { onDelete: "cascade" }),
    /** Stable machine key, unique within the model (`scene-standard`). Not displayed. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    task: text("task", { enum: imageProfileTasks }).notNull(),
    /** Whether the run starts from text or from an existing image. Checked against
     * the parent's `canGenerate`/`canEdit`. */
    operation: text("operation", { enum: imageProfileOperations }).notNull(),
    /** An enum resolved through a code registry, never free text: a profile row must
     * not be able to introduce prompt logic no test has seen. */
    promptStrategy: text("prompt_strategy", { enum: imagePromptStrategies }).notNull(),
    /** `ImageReferencePolicy` — allowed/required roles and the priority order
     * capacity trimming works down. `{}` parses to the inert empty policy. */
    referencePolicy: jsonb("reference_policy").notNull().default({}),
    /** `ImageControlDefaults` — the normalized controls minus `seed` (a stored seed
     * is a pin, not a default), plus a seed policy. */
    controlDefaults: jsonb("control_defaults").notNull().default({}),
    /** Raw provider keys merged last, validated against the model's probed
     * `knownInputFields`. An escape hatch, not a second configuration system. */
    providerOverrides: jsonb("provider_overrides").notNull().default({}),
    /** Null means "use the env/default prediction budget", which all 17 seeded rows
     * do. A 4K set profile is the case that will want its own. */
    timeoutMs: integer("timeout_ms"),
    enabled: boolean("enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    builtin: boolean("builtin").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The composite unique's LEADING column doubles as the per-model lookup index,
    // so no separate `image_model_profiles_model_idx` is needed (the house ruling
    // recorded on `personas`).
    uniqueIndex("image_model_profiles_model_key_unique").on(t.imageModelId, t.key),
    // At most one GLOBAL default per task. A partial unique index is that guarantee
    // at the storage layer — the same device as `sim_time_jobs_one_active_per_branch`,
    // and bare column names inside sql`` for the same reason: the predicate is
    // written into the index definition, where a bound parameter cannot go.
    uniqueIndex("image_model_profiles_default_per_task").on(t.task).where(sql`is_default and enabled`),
    // 30s–15min, mirroring the contract's bounds. A profile timeout below the
    // shortest real render is a guaranteed failure, and one above the platform's
    // own ceiling is a lie the operator would only discover from a stuck job.
    check(
      "image_model_profiles_timeout_bounds",
      sql`${t.timeoutMs} is null or (${t.timeoutMs} >= 30000 AND ${t.timeoutMs} <= 900000)`,
    ),
  ],
);

/**
 * The curated LoRA library.
 *
 * A LoRA is a weights file the PROVIDER fetches by locator, so a row here is not
 * another control default — it is an address plus the rules that say where that
 * address may be sent. Those rules live on the row rather than on the profiles
 * that name it, because a LoRA is trained against one base model and produces
 * noise on another: compatibility is a fact about the weights, and duplicating it
 * onto every profile is how one of the copies goes stale.
 *
 * The locator carries no credential, which is why there is
 * no token column to leak — private repositories stay out of scope until a
 * secret can live somewhere other than this table.
 *
 * `compatibleVersionIds` empty means "any version of a compatible slug";
 * `compatibleModelSlugs` and `allowedTasks` empty mean NOTHING is compatible,
 * because an unfilled list there is an unfinished row rather than a wildcard
 * (`evaluateImageLoraForRender` is where that asymmetry is decided and explained).
 */
export const imageLoras = pgTable(
  "image_loras",
  {
    id: id(),
    label: text("label").notNull(),
    /** `https_url`, `huggingface_repo` or `civitai_model_version` — the shape `locator` is validated as. */
    locatorType: text("locator_type", { enum: imageLoraLocatorTypes }).notNull(),
    /**
     * A public retrieval address: an HTTPS URL, an `owner/repo` slug, or a bare
     * Civitai model-version id. The id is stored rather than the download URL it
     * builds, so the one place that address is spelled stays in the contract
     * (`resolveImageLoraArtifactLocator`) and no pasted `?token=` reaches the row.
     */
    locator: text("locator").notNull(),
    /** jsonb string arrays — base model slugs, exact provider versions, trigger words. */
    compatibleModelSlugs: jsonb("compatible_model_slugs").notNull().default([]),
    compatibleVersionIds: jsonb("compatible_version_ids").notNull().default([]),
    /**
     * Vesper's curated strength band. `doublePrecision` rather than the `real`
     * used for scores elsewhere in this file because a scale is not a statistic:
     * it travels verbatim into the provider payload and into the control hash, and
     * float4 would hand back 0.8500000238418579 for a stored 0.85 — a recorded
     * configuration that no longer equals the one an operator typed.
     */
    defaultScale: doublePrecision("default_scale").notNull(),
    minimumScale: doublePrecision("minimum_scale").notNull(),
    maximumScale: doublePrecision("maximum_scale").notNull(),
    triggerWords: jsonb("trigger_words").notNull().default([]),
    /** Woven around the compiled prompt before model-dialect preparation. */
    promptPrefix: text("prompt_prefix"),
    promptSuffix: text("prompt_suffix"),
    /** jsonb `ImageProfileTask[]` — the jobs this LoRA may serve. */
    allowedTasks: jsonb("allowed_tasks").notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    /** Marks a seeded row for display. Does NOT gate deletion, matching the registry. */
    builtin: boolean("builtin").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The provider ceiling observed on the live `lora_scale` binding (0–4), restated
    // as storage truth. A row outside it could never render, so it should never be
    // storable; a future model with a wider band relaxes this check and the
    // contract's own rail together.
    check(
      "image_loras_scale_bounds",
      sql`${t.minimumScale} >= 0 AND ${t.minimumScale} <= 4 AND ${t.defaultScale} >= 0 AND ${t.defaultScale} <= 4 AND ${t.maximumScale} >= 0 AND ${t.maximumScale} <= 4`,
    ),
    // An unordered triple is a row whose own default is outside its own range —
    // every render from it would be refused, which is a configuration error worth
    // catching at save time rather than at spend time.
    check(
      "image_loras_scale_order",
      sql`${t.minimumScale} <= ${t.defaultScale} AND ${t.defaultScale} <= ${t.maximumScale}`,
    ),
  ],
);

/**
 * A character's identity pack — the face crop and measurements every later render
 * reuses so the same person comes back.
 *
 * The pack is a TABLE, not `images.meta`, because four things need relational
 * ownership that a metadata blob cannot give: which revision is current,
 * compare-and-set promotion under concurrency, revision history, and lifecycle
 * cleanup. The row is authoritative; the hidden crop's `images.meta` is
 * diagnostic provenance only and must never be used to DISCOVER the current crop.
 *
 * **Revisions are rows.** A detector result, a heuristic crop, a manual
 * correction and a retry are distinct claims about the same character, so each
 * gets its own row: corrections stay auditable, supersession is deterministic,
 * failure evidence survives (a terminal failure is never reset in place — the
 * retry is a NEW revision), and cleanup can tell a current asset from an obsolete
 * one. Exactly one row per character may carry `current`, enforced below by a
 * partial unique index rather than by application discipline. "Current" means
 * *the authoritative state for the canonical source* — it may be `ready`,
 * `pending`, `unusable` or `failed`.
 *
 * Both image pointers are `set null` safety nets, not the integrity story: a pack
 * whose source id went null is immediately unusable (`source_missing`) and may not
 * keep serving a crop just because the hidden file still exists. Deleting the
 * character deletes the pack outright — this is operational data, and it does not
 * inherit the Gallery-retention exception that keeps user-visible images.
 */
export const imageIdentityPacks = pgTable(
  "image_identity_packs",
  {
    id: id(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    /** 1-based, monotonic per character. A retry or manual fix takes the next number. */
    revision: integer("revision").notNull(),
    current: boolean("current").notNull().default(false),
    status: text("status", { enum: imageIdentityPackStatuses }).notNull().default("pending"),
    /** The canonical portrait this revision was derived from. */
    sourceImageId: text("source_image_id").references(() => images.id, { onDelete: "set null" }),
    /**
     * SHA-256 over the STORED normalized webp bytes, not the upload. A byte-level
     * change invalidates the pack even when the new portrait looks identical: the
     * system must never claim a crop was derived from bytes it did not read.
     */
    sourceContentHash: text("source_content_hash").notNull(),
    sourceWidth: integer("source_width").notNull(),
    sourceHeight: integer("source_height").notNull(),
    /** Serialized-contract version — changes require an upcaster or a regenerated pack. */
    schemaVersion: integer("schema_version").notNull(),
    /** Normalization / detector interpretation / crop geometry / encoding. A change here
     * needs a new revision (new crop bytes). */
    derivationVersion: text("derivation_version").notNull(),
    /** Thresholds only. A policy change RE-EVALUATES the stored measurements; it never
     * makes the crop bytes stale. */
    policyVersion: text("policy_version").notNull(),
    /** Null until a revision has actually produced a crop (a `pending` or failed row). */
    method: text("method", { enum: imageIdentityCropMethods }),
    detectorVersion: text("detector_version"),
    /** Detector confidence in the chosen face, null for heuristic and manual crops. */
    confidence: real("confidence"),
    faceCropImageId: text("face_crop_image_id").references(() => images.id, { onDelete: "set null" }),
    /** `SourcePixelCrop | null` (contracts/images/identity-pack.ts) — integer source pixels
     * in the stored orientation. Clients may send normalized coordinates; the server
     * resolves and persists source pixels. */
    crop: jsonb("crop_json"),
    /** `ImageIdentityPackQuality | null` — measurements only (face box, blur, occlusion,
     * padding). No embeddings, demographics or model-written descriptions ever land here. */
    quality: jsonb("quality_json"),
    /** `ImageIdentityPackWarningCode[]` — warnings may accompany a perfectly usable pack. */
    warningCodes: jsonb("warning_codes_json").notNull().default([]),
    /** An `ImageIdentityPackFailureCode` explaining a terminal `unusable`/`failed` row.
     * Stable code; the human-readable copy is produced at the UI boundary. */
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    /** The admin or owner behind a manual crop or recorded policy override. No cascade:
     * an audit trail that erases itself when the reviewer's account goes is not one. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
    reviewReason: text("review_reason"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Invariant 1 — at most ONE current revision per character — held at the storage
    // layer, so a lost promotion race fails loudly instead of leaving two "current"
    // packs for the sweep to find. Same device as `image_model_profiles_default_per_task`,
    // and bare column names inside sql`` for the same reason: the predicate is written
    // into the index definition, where a bound parameter cannot go.
    uniqueIndex("image_identity_packs_one_current_per_character").on(t.characterId).where(sql`current`),
    // The revision sequence. Its LEADING column doubles as the per-character lookup
    // index (the house ruling recorded on `personas`), so no separate character index.
    uniqueIndex("image_identity_packs_character_revision_unique").on(t.characterId, t.revision),
    // The derivation key: "is there already a revision for this character from these
    // exact bytes under these exact versions?" — the coalescing lookup that keeps two
    // concurrent ensure calls from deriving the same crop twice, and the diagnostic
    // lookup behind cleanup and sweep findings.
    index("image_identity_packs_derivation_idx").on(
      t.characterId,
      t.sourceContentHash,
      t.schemaVersion,
      t.derivationVersion,
      t.revision,
    ),
  ],
);

/**
 * One slot of a character's **reference view set** — the accepted portrait
 * re-rendered from another angle, in one wardrobe state.
 *
 * A table rather than `images.meta` for the reasons `image_identity_packs` gives
 * and one more of its own: a slot has a REVIEW, and a review is a relational
 * fact about a person and a moment, not a note on a file. The row is
 * authoritative; the hidden `reference_view` asset's `images.meta` is diagnostic
 * provenance only and must never be used to DISCOVER a slot's current view.
 *
 * **Attempts are rows.** A render, a retry, a rejection and an owner upload are
 * distinct claims about the same slot, so each takes its own row and the
 * previous one is marked `superseded`. Rejections stay auditable, an owner can
 * see what was replaced, and — the point of keeping them — nothing is ever
 * deleted when the portrait changes. Staleness is decided at READ time by
 * comparing `source_image_id` against the character's accepted pointer, so
 * re-accepting the earlier portrait revives exactly the views that were rendered
 * from it.
 *
 * Exactly one row per (character, angle, wardrobe) may carry `current`, enforced
 * below by a partial unique index rather than by application discipline — the
 * same device as `image_identity_packs_one_current_per_character`.
 *
 * `image_id` is a `set null` safety net, not the integrity story: a view whose
 * asset went null is not consumable (the read-time projection refuses it), and
 * it may not keep anchoring renders just because the row survives. Deleting the
 * character deletes the row outright — this is operational data, and it does not
 * inherit the Gallery-retention exception that keeps user-visible images.
 */
export const characterReferenceViews = pgTable(
  "character_reference_views",
  {
    id: id(),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    /** A `referenceViewAngleIds` member. Text, not an enum: the angle registry is an
     * extension point, and a row whose id left the registry is dropped at read time
     * with a diagnostic rather than made unstorable. */
    angleId: text("angle_id").notNull(),
    /** A `referenceViewWardrobes` member, on the same registry-not-enum rule as the angle. */
    wardrobe: text("wardrobe").notNull(),
    current: boolean("current").notNull().default(false),
    /** The accepted portrait this view was rendered from. */
    sourceImageId: text("source_image_id").references(() => images.id, { onDelete: "set null" }),
    /**
     * SHA-256 over the STORED normalized webp bytes of that portrait, not the
     * upload — `image_identity_packs.source_content_hash`'s rule, for its reason:
     * a byte-level change invalidates the view even when the new portrait looks
     * identical, and the system must never claim a view was derived from bytes it
     * did not read.
     */
    sourceContentHash: text("source_content_hash").notNull(),
    /** The produced asset. Null while pending, and after a failure. */
    imageId: text("image_id").references(() => images.id, { onDelete: "set null" }),
    status: text("status", { enum: referenceViewStatuses }).notNull().default("pending"),
    /** Null until a row has actually produced a view (a `pending` or failed row). */
    method: text("method", { enum: referenceViewMethods }),
    /** `REFERENCE_VIEW_GENERATION_VERSION` at build time — a row behind it reads stale. */
    generationVersion: integer("generation_version").notNull(),
    /** A stable `classifyImageFailure` bucket; the human copy is produced at the UI boundary. */
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    /**
     * The owner's ruling on THIS attempt, written by a review or an upload and
     * cleared only by explicit Undo — the review fact survives supersession.
     *
     * `status` cannot carry it: a retired row's status becomes `superseded` the
     * instant the next attempt claims the slot, flattening a rejection and an
     * approval into the same word. Null means nobody ruled before the attempt was
     * replaced, which is an honest and ordinary outcome rather than missing data.
     */
    verdict: text("verdict", { enum: referenceViewVerdicts }),
    /** Monotonic token for attempt-bound review and undo. */
    reviewRevision: integer("review_revision").notNull().default(0),
    /** Optional rejection provenance, parsed with referenceViewFeedbackSchema on read. */
    feedback: jsonb("feedback"),
    /** The owner whose eye approved or rejected this view, or who uploaded it (an
     * owner-supplied view is the owner's own review). No cascade, for the same reason
     * as `image_identity_packs.reviewed_by_user_id`: an audit trail that erases itself
     * when the reviewer's account goes is not one. */
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // At most ONE current row per slot, held at the storage layer so a lost
    // reservation race fails loudly instead of leaving two "current" views for the
    // studio to pick between. Bare column name inside sql`` for the reason the pack
    // index gives: the predicate is written into the index definition, where a bound
    // parameter cannot go.
    uniqueIndex("character_reference_views_one_current_per_slot")
      .on(t.characterId, t.angleId, t.wardrobe)
      .where(sql`current`),
    // The per-slot history read, newest first — and its leading column doubles as the
    // per-character lookup index (the house ruling recorded on `personas`).
    index("character_reference_views_slot_idx").on(t.characterId, t.angleId, t.wardrobe, t.createdAt),
  ],
);

/**
 * Which character LoRA was trained from which identity pack revision.
 *
 * The two sides already exist: `image_identity_packs` holds the canonical face,
 * `image_loras` holds the weights and the rules for sending them. This row is
 * the only thing that knows they belong together — and, more usefully, when they
 * stop belonging together. A LoRA trained from revision 3 of a pack keeps
 * rendering perfectly after revision 4 becomes current; it just gradually stops
 * being a likeness of the character every other Vesper surface describes.
 * Nothing errors, so the drift has to be detectable from a row rather than from
 * somebody noticing.
 *
 * **It points at the pack REVISION, not the character.** Supersession is the
 * whole staleness signal (`evaluateIdentityLoraBinding`), and a character-keyed
 * row would have to re-derive it from a revision number it does not hold.
 *
 * **Several bindings per pack are normal.** Stage 4 trains rank 8 and rank 16
 * from one dataset and compares them, so both exist at once as `experimental`.
 * At most one may be `active`, held below by a partial unique index rather than
 * by application discipline — the same device as
 * `image_identity_packs_one_current_per_character`. A losing arm is `retired`,
 * never deleted: an image rendered under it still has to be able to say what
 * produced it.
 *
 * Both foreign keys cascade. A deleted character takes its packs and therefore
 * its bindings, and a LoRA removed from the library takes the rows claiming it
 * is a character's likeness — a binding whose weights are gone describes nothing.
 */
export const imageIdentityLoraBindings = pgTable(
  "image_identity_lora_bindings",
  {
    id: id(),
    identityPackId: text("identity_pack_id")
      .notNull()
      .references(() => imageIdentityPacks.id, { onDelete: "cascade" }),
    loraId: text("lora_id")
      .notNull()
      .references(() => imageLoras.id, { onDelete: "cascade" }),
    /** The base weights the LoRA was trained against — the only ones it is valid on. */
    baseCheckpoint: text("base_checkpoint").notNull(),
    /** `fingerprintSdTrainingDataset` over the training set. Recorded provenance, not yet compared. */
    datasetFingerprint: text("dataset_fingerprint").notNull(),
    datasetImageCount: integer("dataset_image_count").notNull(),
    /** `<family>/<slug>` of the package training recipe, plus the exact revision that ran. */
    trainingRecipeId: text("training_recipe_id").notNull(),
    trainingRecipeRevision: integer("training_recipe_revision").notNull(),
    rank: integer("rank").notNull(),
    /** The word the LoRA answers to, or null when the recipe trained none. */
    triggerToken: text("trigger_token"),
    /** The trainer's own id for the run — the way back to its logs and cost line. */
    trainingRunRef: text("training_run_ref"),
    state: text("state", { enum: identityLoraBindingStates }).notNull().default("experimental"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The per-pack lookup, and the state filter that read always carries.
    index("image_identity_lora_bindings_pack_idx").on(t.identityPackId, t.state),
    // One promoted LoRA per pack. Bare column name inside sql`` for the reason
    // every partial index in this file gives: the predicate is written into the
    // index definition, where a bound parameter cannot go.
    uniqueIndex("image_identity_lora_bindings_one_active_per_pack")
      .on(t.identityPackId)
      .where(sql`state = 'active'`),
    // The same weights bound twice to the same pack is not a second arm, it is a
    // duplicate — two rows that would both claim to be the promotion candidate.
    uniqueIndex("image_identity_lora_bindings_pack_lora_unique").on(t.identityPackId, t.loraId),
    // A rank outside the contract's rail could never have trained, so it should
    // never be storable; the dataset count matches "a training set has images".
    check("image_identity_lora_bindings_rank_bounds", sql`${t.rank} >= 1 AND ${t.rank} <= 128`),
    check("image_identity_lora_bindings_dataset_size", sql`${t.datasetImageCount} >= 1`),
  ],
);

/**
 * An admin identity-reference trial run — one bounded, owner-scoped comparison
 * of reference strategies across a fixed
 * character/profile/fixture grid. The validated create-request is snapshotted
 * into `config_json` so a later registry or profile edit can never change what
 * a finished run claims it tested.
 *
 * Verdicts are NOT stored here. They used to be one jsonb array on this row,
 * which made every ruling a read-modify-write of the whole ledger: two admins
 * ruling on two different (profile, strategy) slots at once silently lost one
 * of the two verdicts. They live in `image_identity_pack_trial_verdicts`, one
 * row per ruling, upserted under a unique key that cannot lose a write.
 *
 * The status enum comes from the contract vocabulary (`imageIdentityPacks`'s
 * precedent) rather than being restated inline: a lifecycle position the parser
 * knows and the column rejects is a write that fails at 3am.
 */
export const imageIdentityPackTrialRuns = pgTable(
  "image_identity_pack_trial_runs",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    status: text("status", { enum: trialRunStatuses }).notNull().default("draft"),
    /** The validated create-run request snapshot (contracts/images/identity-pack-trial.ts). */
    configJson: jsonb("config_json").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("image_identity_pack_trial_runs_owner_idx").on(t.ownerId)],
);

/**
 * One cell of a trial run's grid — a single (character, profile, strategy,
 * prompt fixture) render attempt. The spec-time identity lives in `spec_json`
 * and the execution outcome in `result_json` (null until executed); both are
 * contract-validated jsonb, read back through the `readJsonColumn` pattern.
 * The output image is a `set null` safety net like the pack's crop pointer —
 * a deleted output makes the cell unreviewable, not invalid.
 *
 * `claim_token` / `claimed_at` are the DURABLE EXECUTION CLAIM. A pass takes a
 * cell by compare-and-set from `planned` to `running`, stamping both; it settles
 * by compare-and-set from `running` AND the same token to a terminal status. The
 * in-process execution lock cannot serialize two machines, and a claim held only
 * in memory dies with the process that took it — so without these columns a
 * restart mid-pass leaves the cell `planned` and the next pass pays the provider
 * a second time for one cell's evidence. A claim left behind by a dead worker is
 * recoverable only after a bounded interval, never by resetting the cell on
 * sight: `running` records "this render may already have been paid for".
 */
export const imageIdentityPackTrialCells = pgTable(
  "image_identity_pack_trial_cells",
  {
    id: id(),
    runId: text("run_id").notNull(),
    /**
     * Deterministic `characterId:profileId:fixtureId:strategy:variantKey` plan
     * key (`trialCellKey` in the lib). Plain ascending order over this column is
     * the execution order, and the component order is load-bearing: it keeps
     * every arm of one (character, profile, fixture) comparison group adjacent,
     * so unseeded paired renders happen as close together as practical.
     */
    cellKey: text("cell_key").notNull(),
    status: text("status", { enum: trialCellStatuses }).notNull().default("planned"),
    specJson: jsonb("spec_json").notNull(),
    resultJson: jsonb("result_json"),
    outputImageId: text("output_image_id").references(() => images.id, { onDelete: "set null" }),
    /** The claiming pass's token — null on every cell no pass has taken. */
    claimToken: text("claim_token"),
    /** When the claim was stamped, so a stale claim can be aged out on a clock
     * rather than on a guess about which worker is alive. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Named short: drizzle's auto-generated FK name would exceed Postgres's
    // 63-char identifier cap (both table names are long), and a silently
    // truncated constraint name is a drift trap for later migrations.
    foreignKey({
      name: "image_identity_pack_trial_cells_run_fk",
      columns: [t.runId],
      foreignColumns: [imageIdentityPackTrialRuns.id],
    }).onDelete("cascade"),
    // The composite unique's LEADING column doubles as the per-run lookup index
    // (the house ruling recorded on `personas`).
    uniqueIndex("image_identity_pack_trial_cells_run_cell_key_unique").on(t.runId, t.cellKey),
    // The execute path's hot filter: "which cells of this run are still
    // planned?" runs on every pass and again after it settles, and the
    // cell-key unique above cannot serve it (status is not in that index).
    index("image_identity_pack_trial_cells_run_status_idx").on(t.runId, t.status),
  ],
);

/**
 * A submitted blinded pair grade — insert-once under unique `(run_id, pair_id)`,
 * so a double submission fails loudly (`grade_conflict`) instead of averaging.
 * `left_is_a` persists the blind left/right↔A/B mapping the reviewer actually
 * saw; unblinding happens only in aggregation. The reviewer FK carries no
 * cascade for the same reason as `image_identity_packs.reviewed_by_user_id`:
 * an audit trail that erases itself when the reviewer's account goes is not one.
 */
export const imageIdentityPackTrialGrades = pgTable(
  "image_identity_pack_trial_grades",
  {
    id: id(),
    runId: text("run_id").notNull(),
    /** Deterministic sorted-cell-id pair key (lib/images/identity-pack-trial.ts). */
    pairId: text("pair_id").notNull(),
    cellAId: text("cell_a_id").notNull(),
    cellBId: text("cell_b_id").notNull(),
    leftIsA: boolean("left_is_a").notNull(),
    gradesJson: jsonb("grades_json").notNull(),
    reviewedByUserId: text("reviewed_by_user_id"),
    createdAt: createdAt(),
  },
  (t) => [
    // Named short — see the cells table: the auto-generated names would exceed
    // Postgres's 63-char identifier cap.
    foreignKey({
      name: "image_identity_pack_trial_grades_run_fk",
      columns: [t.runId],
      foreignColumns: [imageIdentityPackTrialRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "image_identity_pack_trial_grades_cell_a_fk",
      columns: [t.cellAId],
      foreignColumns: [imageIdentityPackTrialCells.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "image_identity_pack_trial_grades_cell_b_fk",
      columns: [t.cellBId],
      foreignColumns: [imageIdentityPackTrialCells.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "image_identity_pack_trial_grades_reviewer_fk",
      columns: [t.reviewedByUserId],
      foreignColumns: [users.id],
    }),
    uniqueIndex("image_identity_pack_trial_grades_run_pair_unique").on(t.runId, t.pairId),
  ],
);

/**
 * One authoritative ruling per (run, profile, strategy).
 *
 * This table replaces the run row's `verdicts_json` array, and the reason is
 * lost updates: recording a verdict there meant reading the whole array,
 * filtering out the slot being ruled, appending the new entry and writing the
 * array back. Two admins ruling on two DIFFERENT slots concurrently both read
 * the same array and the second write erased the first — a promotion decision
 * silently vanishing, in the one ledger the whole blinded procedure exists to
 * produce. One row per ruling under the unique below makes each ruling its own
 * write, and revision is an upsert on that key rather than a rewrite of
 * everybody else's.
 *
 * `override_incomplete_review` records that the admin ruled BEFORE every
 * reviewable pair was graded (`review_incomplete` otherwise refuses the
 * verdict). It is stored on the ruling rather than inferred later because
 * whether the evidence was complete AT DECISION TIME is unrecoverable once more
 * grades arrive, and a promotion made on half the pairs must stay
 * distinguishable from one made on all of them.
 *
 * The decider FK carries no cascade for the same reason as
 * `image_identity_packs.reviewed_by_user_id`: an audit trail that erases itself
 * when the decider's account goes is not one. It is `not null` — a ruling with
 * no actor is not an audit record — which is the one place this diverges from
 * the grades table's nullable reviewer column.
 */
export const imageIdentityPackTrialVerdicts = pgTable(
  "image_identity_pack_trial_verdicts",
  {
    // No `$defaultFn`: the service supplies `newId()` explicitly, because the
    // upsert's insert half must name the id it would use even when the conflict
    // arm wins and that id is discarded.
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    profileId: text("profile_id").notNull(),
    identityStrategy: text("identity_strategy", { enum: identityReferenceStrategies }).notNull(),
    verdict: text("verdict", { enum: trialVerdicts }).notNull(),
    /** Required: a promotion with no stated reason is indistinguishable from a
     * mistake six months later. */
    reason: text("reason").notNull(),
    /** The identity-pack policy version in force when the ruling was made. */
    policyVersion: text("policy_version").notNull(),
    overrideIncompleteReview: boolean("override_incomplete_review").notNull().default(false),
    decidedByUserId: text("decided_by_user_id").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Named short — see the cells table: the auto-generated names would exceed
    // Postgres's 63-char identifier cap.
    foreignKey({
      name: "image_identity_pack_trial_verdicts_run_fk",
      columns: [t.runId],
      foreignColumns: [imageIdentityPackTrialRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "image_identity_pack_trial_verdicts_decider_fk",
      columns: [t.decidedByUserId],
      foreignColumns: [users.id],
    }),
    // The upsert target, and the guarantee the service is allowed to assume
    // rather than re-check: one ruling per slot, revised in place, never
    // duplicated by a concurrent submission. Its LEADING column doubles as the
    // per-run lookup index (the house ruling recorded on `personas`).
    uniqueIndex("image_identity_pack_trial_verdicts_run_combo_unique").on(t.runId, t.profileId, t.identityStrategy),
  ],
);

/**
 * One Advanced Image Lab experiment — a single deliberate admin render with every
 * input, setting, and outcome written down.
 *
 * The row exists because the questions the lab asks cannot be answered by any
 * provider schema — "does this model honour a pose skeleton?" is settled by
 * looking at one image — and an answer is worthless unless what produced it is
 * recoverable months later. So the requested AND executed version, the final
 * prompt as sent, the ordered inputs, and the settings overlay are all stored
 * verbatim rather than re-derived from a profile that will have moved on.
 *
 * Nothing here touches an ordinary lane. A baseline re-runs a lane's own
 * configuration but saves its render as a hidden `lab_output`, so lab activity
 * can never put a player-visible variant or scene in the Gallery.
 *
 * FK choices follow the trial tables: the owner CASCADES (an account's lab
 * evidence goes with the account), while character, chat, and both image
 * pointers are SET NULL — a deleted subject makes an experiment incomplete, not
 * invalid, and losing the record of a paid render because its source portrait
 * was tidied up would destroy the only evidence a verdict rests on. `profileId`
 * is a plain id SNAPSHOT with no FK, for the same reason the trial cell spec
 * stores one: deleting a profile must not erase what a finished baseline says it
 * ran.
 *
 * The enum-typed columns reuse the contract vocabularies
 * (`contracts/images/image-lab.ts`) so the column and the parser cannot drift.
 * `failure_code` is deliberately NOT enum-typed: it carries codes from two
 * vocabularies (`imageLabFailureCodes` and the render-failure classifier), and
 * freezing their union in the column would make adding a classifier code a
 * migration.
 */
export const imageLabExperiments = pgTable(
  "image_lab_experiments",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: imageLabExperimentKinds }).notNull(),
    /** Null on Stage 0: a probe declares no identity/composition bias. */
    mode: text("mode", { enum: imageLabModes }),
    characterId: text("character_id").references(() => characters.id, { onDelete: "set null" }),
    chatId: text("chat_id").references(() => characterChats.id, { onDelete: "set null" }),

    modelSlug: text("model_slug").notNull(),
    /** The pinned version the run ASKED for; null until the run starts. */
    requestedVersionId: text("requested_version_id"),
    /** The version the provider echoed back. A disagreement with the requested one
     * is how an unannounced provider-side bump becomes visible instead of silent. */
    executedVersionId: text("executed_version_id"),
    /** Resolved profile id — baselines only. Snapshot, no FK (see above). */
    profileId: text("profile_id"),

    /** What the admin typed. */
    instruction: text("instruction").notNull().default(""),
    /** What was actually sent, recorded by the runner. */
    finalPrompt: text("final_prompt"),

    /** Ordered `imageLabInputSchema` list (contracts/images/image-lab.ts). */
    inputs: jsonb("inputs").notNull().default([]),
    controlImageId: text("control_image_id").references(() => images.id, { onDelete: "set null" }),
    controlKind: text("control_kind", { enum: imageLabControlKinds }),

    /** `imageLabSettingsSchema`: the normalized control overlay plus the raw
     * provider-shaped bag merged last. */
    settings: jsonb("settings").notNull().default({}),
    resultImageId: text("result_image_id").references(() => images.id, { onDelete: "set null" }),

    status: text("status", { enum: imageLabExperimentStatuses }).notNull().default("pending"),
    failureCode: text("failure_code"),
    /**
     * The reviewing admin's ruling — the kinds that ask a question, in the
     * vocabulary their kind offers (`imageLabVerdictOptions`). One column across
     * both vocabularies: an experiment records exactly one ruling whatever kind
     * it is. The column is plain `text` (drizzle's `{ enum }` is a TypeScript
     * refinement, not a check constraint), so a widened vocabulary is a code
     * change and never a migration.
     */
    verdict: text("verdict", { enum: imageLabVerdicts }),
    verdictNote: text("verdict_note"),

    predictionId: text("prediction_id"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => [
    // The lab page's only listing query: this owner's experiments, newest first.
    // Its LEADING column doubles as the per-owner lookup index (the house ruling
    // recorded on `personas`).
    index("image_lab_experiments_owner_created_idx").on(t.ownerId, t.createdAt),
  ],
);

/**
 * One Image Generator run — a single immutable raw prompt/model attempt on the
 * admin bench. The
 * Generator is a separate surface from the Advanced Image Lab: no experiment
 * kind, no verdict, no fixture rules — one row is one paid attempt whose
 * prompt, ordered inputs, controls, advanced provider values, and outcome are
 * stored verbatim. Variants create NEW rows via `source_run_id`; nothing
 * mutates or reruns a settled row.
 *
 * FK policy follows the evidence-table ruling: the owner CASCADES (an
 * account's bench evidence goes with the account); the self pointer and the
 * output pointer are SET NULL (a deleted original makes a variant's lineage
 * incomplete, not invalid); the slug and both version columns are SNAPSHOTS
 * with no FK, so deleting a registry row cannot erase what a finished run says
 * it executed.
 *
 * `failure_code` is deliberately NOT enum-typed: it carries the dotted
 * `image_generator.*` codes plus verbatim shared-layer codes (`image_profile.*`,
 * `image_lora.*`), and freezing that union in the column would make a
 * shared-layer code a migration.
 */
export const imageGeneratorRuns = pgTable(
  "image_generator_runs",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status", { enum: imageGeneratorRunStatuses }).notNull().default("pending"),
    /** Registry snapshot at create; re-resolved by exact slug at run time. */
    modelSlug: text("model_slug").notNull(),
    /** The pinned version the run ASKED for; written by the runner before spend. */
    requestedVersionId: text("requested_version_id"),
    /** The version the provider echoed back — how an unannounced bump becomes visible. */
    executedVersionId: text("executed_version_id"),
    /** The admin's whole positive prompt, verbatim. */
    prompt: text("prompt").notNull(),
    /** What was actually sent, recorded by the runner before the provider call. */
    finalPrompt: text("final_prompt"),
    /** `imageGeneratorRunInputsSchema` (contracts/images/image-generator.ts). */
    inputs: jsonb("inputs").notNull().default({}),
    /** `imageGeneratorControlsSchema` — the normalized per-run control overlay. */
    controls: jsonb("controls").notNull().default({}),
    /** `imageGeneratorProviderInputsSchema` — raw advanced provider values. */
    providerInputs: jsonb("provider_inputs").notNull().default({}),
    resultImageId: text("result_image_id").references(() => images.id, { onDelete: "set null" }),
    failureCode: text("failure_code"),
    /** Truncated provider/classifier detail beside the code. */
    error: text("error"),
    predictionId: text("prediction_id"),
    /** Duplicate/variant lineage — self FK, declared in the table config below. */
    sourceRunId: text("source_run_id"),
    /** `{ attempt?, outcome?, renderFailure? … }` — per-run records, not queryable facts. */
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    // The self FK lives here because a column cannot reference its own table
    // inline; named short like the trial tables' explicit FKs.
    foreignKey({
      name: "image_generator_runs_source_run_fk",
      columns: [t.sourceRunId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
    // The page's only listing query: this owner's runs, newest first. Its
    // LEADING column doubles as the per-owner lookup index (the house ruling
    // recorded on `personas`).
    index("image_generator_runs_owner_created_idx").on(t.ownerId, t.createdAt),
  ],
);

/**
 * One offline reference-image extraction run: an admin registered an
 * extractor's structured proposals about one character's canonical image.
 * Admin-only (`/api/admin/self/reference-extractions`), review-first — a row
 * here never touches a canonical owner; only a reviewed acceptance on a
 * PROPOSAL row does, through the owner's own write path.
 *
 * `source_hash` is SHA-256 over the STORED webp bytes, computed server-side at
 * registration (the `image_identity_packs.source_content_hash` rule: never
 * claim derivation from bytes the system did not read). The image FK is
 * SET NULL like the identity pack's: a deleted portrait does not erase the
 * review record derived from it — the hash still names the exact input.
 *
 * Registering a new run for the same (character, source image) supersedes the
 * prior open one: its PENDING proposals close as `superseded`, while decided
 * proposals keep their ruling forever (they are what re-runs reconcile
 * against). Statuses come from the contract vocabulary so the column and the
 * parser cannot drift.
 */
export const visualReferenceExtractions = pgTable(
  "visual_reference_extractions",
  {
    id: id(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    sourceImageId: text("source_image_id").references(() => images.id, { onDelete: "set null" }),
    sourceHash: text("source_hash").notNull(),
    extractorId: text("extractor_id").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    status: text("status", { enum: visualExtractionRunStatuses }).notNull().default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    // The review page's one listing query: a character's runs, newest first. Its
    // LEADING column doubles as the per-character lookup index (the house ruling
    // recorded on `personas`).
    index("visual_reference_extractions_character_idx").on(t.characterId, t.createdAt),
  ],
);

/**
 * One extraction proposal with its review state — its own row, not a jsonb
 * array on the run, for the reason `image_identity_pack_trial_verdicts` gives:
 * a per-proposal ruling as a read-modify-write over one blob silently loses a
 * concurrent ruling.
 *
 * `slot_key` is the claim's stable identity across runs and extractor versions
 * (`visualExtractionSlotKey`), and the slot index below is what registration
 * reconciles a re-run against: the newest DECIDED row per slot either carries
 * its ruling onto the new run (same machine claim) or marks the new row
 * conflicted (`conflict_with_proposal_id`) — never overwritten.
 *
 * `baseline_json` stores the diff against canonical truth AS REGISTERED
 * (`VisualExtractionProposalDiff`, minus values recoverable elsewhere); review
 * reads recompute a fresh diff, and the accept path requires the reviewer to
 * echo the fresh diff's `currentDigest`, so an accept can only land against
 * canonical state the reviewer actually saw. `edited_value_json` is the
 * reviewer's manual edit; it survives supersession by riding the carry.
 * Reviewer FK carries no cascade (the `image_identity_packs` audit-trail rule).
 */
export const visualReferenceProposals = pgTable(
  "visual_reference_proposals",
  {
    id: id(),
    extractionId: text("extraction_id")
      .notNull()
      .references(() => visualReferenceExtractions.id, { onDelete: "cascade" }),
    /** Denormalized from the run for the cross-run slot lookup. */
    characterId: text("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    slotKey: text("slot_key").notNull(),
    targetOwner: text("target_owner", { enum: visualExtractionTargetOwners }).notNull(),
    kindId: text("kind_id").notNull(),
    /** `BodyLocusRef | null` — required for located_fact/presentation targets, absent for attributes. */
    locus: jsonb("locus_json"),
    /** The machine's proposed value, as re-issued by the target owner's parser. */
    value: jsonb("value_json").notNull(),
    proposedFingerprint: text("proposed_fingerprint").notNull(),
    /** Extractor confidence, fixed-point 0…10 000. Display only: confidence never grants overwrite. */
    confidence: integer("confidence").notNull(),
    /** `VisualExtractionImageRegion | null` — evidence highlight, never truth. */
    evidenceRegion: jsonb("evidence_region_json"),
    /** The registration-time diff against canonical truth. */
    baseline: jsonb("baseline_json").notNull(),
    status: text("status", { enum: visualExtractionProposalStatuses }).notNull().default("pending"),
    editedValue: jsonb("edited_value_json"),
    /** The decided proposal whose ruling this row inherited at registration. */
    carriedFromProposalId: text("carried_from_proposal_id"),
    /** The decided proposal this row's machine claim disagrees with. */
    conflictWithProposalId: text("conflict_with_proposal_id"),
    reviewedByUserId: text("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("visual_reference_proposals_extraction_idx").on(t.extractionId),
    // The reconcile lookup: a character's decided rulings per slot, newest first.
    index("visual_reference_proposals_slot_idx").on(t.characterId, t.slotKey, t.createdAt),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: text("type", {
      // `lab_image` / `lab_control_extract`: the Advanced Image Lab's experiment render
      // and its control-fixture extraction. Both reach an image provider, so both map to
      // the image lane in `providerLaneFor`.
      // `generator_image`: one Image Generator run — an image-provider render,
      // so it maps to the image lane as well.
      enum: ["post_turn", "reconcile", "inner_note", "chat_summary", "chat_scene_sketch", "chat_meanwhile", "chat_look_image", "chat_place_image", "scene_image", "chat_scene_image", "avatar", "portrait_variant", "entity_image", "embed_refresh", "image_sweep", "item_classify", "identity_pack", "lab_image", "lab_control_extract", "generator_image", "reference_views"],
    }).notNull(),
    /**
     * Who the work is being done for — the key the
     * per-user concurrency cap counts over. Nullable: system//engine-internal jobs
     * belong to no user, and legacy rows predate the column. Uncapped when null.
     */
    ownerId: text("owner_id").references(() => users.id),
    status: text("status", { enum: ["queued", "running", "done", "failed"] }).notNull().default("queued"),
    runnerId: text("runner_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").notNull().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * The conversation this job works for, when it is chat-scoped — the database
     * relationship that takes the row with its chat (`ON DELETE CASCADE`). Null for
     * system and library jobs (image sweep, avatars, entity images) that belong to
     * no conversation; those age out through retention instead.
     */
    chatId: text("chat_id").references(() => characterChats.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("jobs_queued_idx").on(t.status, t.type),
    /** Backs the per-owner active-job count in the concurrency cap's conditional insert. */
    index("jobs_owner_status_idx").on(t.ownerId, t.status),
    index("jobs_chat_idx").on(t.chatId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
    /**
     * The conversation a chat-scoped event describes, when the writer had it — the
     * database relationship that takes the row with its chat (`ON DELETE CASCADE`).
     * Null for events that belong to no conversation (library image work, system
     * maintenance); those age out through retention instead.
     */
    chatId: text("chat_id").references(() => characterChats.id, { onDelete: "cascade" }),
  },
  (t) => [index("events_type_idx").on(t.type), index("events_chat_idx").on(t.chatId)],
);

/**
 * Durable usage accounting for cost-bearing work.
 *
 * Burst limits stay in-process — losing them to a restart is harmless. These do
 * not: an in-memory daily budget is reset by crash-looping the process, which is
 * precisely the move an abuser would make. One row per (owner, kind, UTC day).
 *
 * `windowStart` is a `YYYY-MM-DD` UTC date rather than a timestamp on purpose —
 * the reset boundary becomes a fact about the key, so nothing has to sweep
 * expired rows or fire a timer for a counter to roll over.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A `UsageCounterKind` (src/server/api/quota.ts) — vocabulary is a code edit, never a migration. */
    kind: text("kind").notNull(),
    /** UTC calendar day, `YYYY-MM-DD`. */
    windowStart: text("window_start").notNull(),
    /** Monotonic within a window; bigint because byte counters outgrow int4 quickly. */
    amount: bigint("amount", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The upsert target — `ON CONFLICT` needs this to be unique, not merely indexed. */
    uniqueIndex("usage_counters_owner_kind_window_idx").on(t.ownerId, t.kind, t.windowStart),
  ],
);

/**
 * A saved narrator instruction prompt — the Narrator Prompt Lab's template
 * identity.
 *
 * The template is the STABLE half; the body lives in
 * `narrator_prompt_revisions`, which is append-only. Editing never overwrites:
 * **Save** writes revision `N + 1` and re-points `current_revision` /
 * `current_revision_id` at it. A conversation selects the TEMPLATE, not a pinned
 * revision, so it picks up the newest body on its next exchange — while one
 * exchange resolves exactly one revision under its lock and freezes it, so a
 * save landing mid-stream can never change the reply being written.
 *
 * `current_revision` doubles as the **optimistic-concurrency token**. A save
 * claims `base + 1` with a conditional `UPDATE … WHERE current_revision = $base`,
 * which is a compare-and-swap: at READ COMMITTED the loser re-checks its
 * predicate against the committed row, matches zero rows, and is reported as
 * `prompt_conflict` for the editor to reload. No `SELECT … FOR UPDATE` and no
 * SERIALIZABLE isolation are involved, and adding either would be a
 * misunderstanding of why this works.
 *
 * `current_revision` and `current_revision_id` must always agree outside a
 * transaction; both are written inside the same transaction that inserts the
 * revision, which is the only reason `current_revision_id` may be nullable at
 * all (revision 1 does not exist yet when the template row is inserted).
 *
 * Deletes are SOFT (`deleted_at`) so immutable revisions survive to explain
 * historical takes; the service clears live chat selections in the same
 * transaction. Owner-scoped, and cascaded from the owner.
 */
export const narratorPromptTemplates = pgTable(
  "narrator_prompt_templates",
  {
    id: id(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Owner-visible label; unique case-insensitively among the owner's ACTIVE templates. */
    name: text("name").notNull(),
    /** Optional hypothesis — what this experiment is trying to prove. */
    notes: text("notes").notNull().default(""),
    /** The current revision NUMBER, and the compare-and-swap token every save claims against. */
    currentRevision: integer("current_revision").notNull().default(0),
    /**
     * The current revision ROW. Nullable only for the instant inside the create
     * transaction before revision 1 exists; no committed row ever has a
     * `current_revision > 0` with a null pointer.
     *
     * Deliberately NOT a database FK: the revision table points at the template
     * (cascade), and a second FK back would be a cycle the migration ordering has
     * to unpick for no benefit. The service is the only writer.
     */
    currentRevisionId: text("current_revision_id"),
    /** Provenance for **Duplicate** — the template this one was branched from. */
    duplicatedFromId: text("duplicated_from_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Soft delete. Set ⇒ hidden from every ordinary list and never resolvable as a test source. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * Case-insensitive active-name uniqueness per owner. Partial on
     * `deleted_at is null` so a soft-deleted template does not squat its name
     * forever, and expression-based on `lower(name)` so `Player Agency` and
     * `player agency` cannot both be live — an experiment log with two prompts
     * whose names differ only in case is unreadable.
     */
    uniqueIndex("narrator_prompt_templates_owner_active_name_unique")
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`deleted_at is null`),
    index("narrator_prompt_templates_owner_updated_idx").on(t.ownerId, t.updatedAt),
  ],
);

/**
 * One immutable narrator prompt body.
 *
 * **Rows here are never UPDATEd after insert.** That is the whole point: a take
 * generated three weeks ago must still be explainable by the exact text that
 * produced it, and "the template used to say something else" is not an answer a
 * mutable body can give. Delete is soft at the template level precisely so these
 * survive it.
 *
 * `UNIQUE(template_id, revision)` is the integrity backstop, not the lock — the
 * conditional UPDATE on `narrator_prompt_templates.current_revision` is what
 * serializes two concurrent saves. The constraint exists so a bug that bypasses
 * that path fails loudly instead of forking the revision chain.
 *
 * `body_hash` is `fnv1aHex` over `` `${templateLanguage}\n${body}` `` — the
 * LANGUAGE is inside the hash because the same characters mean different things
 * under a future template language, so an identical body under `plain_v0` and a
 * later `plain_v1` must not collide into one identity.
 */
export const narratorPromptRevisions = pgTable(
  "narrator_prompt_revisions",
  {
    id: id(),
    templateId: text("template_id")
      .notNull()
      .references(() => narratorPromptTemplates.id, { onDelete: "cascade" }),
    /** 1-based, contiguous, and claimed by the template's compare-and-swap. */
    revision: integer("revision").notNull(),
    body: text("body").notNull(),
    bodyHash: text("body_hash").notNull(),
    /**
     * A `NarratorPromptLanguage` (contracts/narrator-prompts/template.ts). v1
     * bodies are literal text: braces and every other sigil are sent verbatim.
     * An UNKNOWN value never executes as `plain_v0` by guess — resolution
     * degrades to production instructions with a diagnostic instead, so a future
     * language cannot retroactively reinterpret a hand-typed old prompt.
     */
    templateLanguage: text("template_language", { enum: ["plain_v0"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("narrator_prompt_revisions_template_revision_unique").on(t.templateId, t.revision)],
);


// ---------------------------------------------------------------------------
// Successor simulation authority
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
    /**
     * `active` plays; `paused` is unused vocabulary held for a future need.
     * "archived" was dropped (E20-1):
     * nothing ever set it, and a successor world is now hard-deleted with its
     * chat rather than shelved. App-level enum on a text column — no CHECK
     * constraint, so narrowing it needs no migration.
     */
    status: text("status", { enum: ["active", "paused"] }).notNull().default("active"),
    /** Ruling 3: whether explicit forced-entry attempts are admissible here. */
    permitsTrespass: boolean("permits_trespass").notNull().default(false),
    /**
     * R5 time domain (ruling 17): the calendar anchor — the DATE of story day
     * zero ({year, month, day}; time-of-day comes from storySecond itself).
     * Null = no calendar declared: presentation stays "Day N". Presentation
     * config, not causal state — editable in place, never through the event
     * log (changing it re-labels history, it does not rewrite it).
     */
    calendarStart: jsonb("calendar_start"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sim_worlds_status_idx").on(t.status)],
);

/**
 * One serial command/event stream and one optimistic version per causal branch.
 *
 * E2.5 ancestry: a fork child records its parent, fork boundary,
 * and provenance here. A child stores only its own post-fork rows; ancestor
 * events are read through the parent chain bounded by fork_sequence, never
 * copied.
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
    /** Checksum of the materialized child projection at the fork point. */
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

/**
 * Route-level idempotency for successor sim-commands. One row per
 * `(chatId, requestId)` — the stable token the client
 * mints per tap. Under the shared `chat_exchange` lock the route records `started`
 * BEFORE executing, then `completed` with the full HTTP result (status + body), so
 * a retry replays the recorded response verbatim instead of re-running the drain or
 * writing a second world beat. A canonical `(kind, payload)` hash guards a reused
 * requestId carrying a DIFFERENT action (→ `idempotency_mismatch`). Beats and step
 * commands carry their own deterministic ids, so a crash between execute and
 * `completed` still dedupes at the insert when the retry re-executes. This is a
 * CHAT-scoped replay table, distinct from `sim_commands` (branch-scoped, the
 * command-runner's own per-envelope dedupe) — one uniform route-level replay path.
 */
export const simCommandRequests = pgTable(
  "sim_command_requests",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    kind: text("kind").notNull(),
    payloadHash: text("payload_hash").notNull(),
    /**
     * The branch story-clock captured when this request FIRST started — the stable
     * anchor a relative command (`advance_time`, target = clock + minutes) re-derives
     * its absolute target from on a crash-remnant re-execution, so a retry lands the
     * same clock instead of advancing a second time. Null for callers with no branch
     * clock at record time.
     */
    preClockStorySecond: bigint("pre_clock_story_second", { mode: "number" }),
    state: text("state", { enum: ["started", "completed", "failed"] })
      .notNull()
      .default("started"),
    /** The recorded HTTP result — null until `completed`. */
    resultStatus: integer("result_status"),
    resultBody: jsonb("result_body"),
    /** Result-shape tag (the command kind) for forward-compatible replay interpretation. */
    schemaTag: text("schema_tag"),
    startedAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_command_requests_chat_request_pk", columns: [t.chatId, t.requestId] }),
    index("sim_command_requests_state_idx").on(t.state, t.startedAt),
  ],
);

/**
 * The non-terminal provisioning states — a request that has begun but has not
 * yet reached `ready` or `failed`. These hold a quota slot (an in-flight world
 * is a world) and, from slice 2, protect their world from the orphan sweeper.
 */
export const simProvisioningPendingStates = [
  "requested",
  "world_created",
  "chat_created",
  "relationships_seeded",
] as const;

/**
 * Resumable successor-world provisioning (ruling E20-3) — the
 * `sim_command_requests` shape, owner-scoped.
 *
 * One row per `(ownerId, requestId)`: the stable token the Worlds page mints
 * per create intent. The POST runs under `successor_provision:<ownerId>` and
 * advances this record after each committed step, so a crash leaves a durable
 * resume point instead of the old `seed_failed` / `flip_failed` half-states —
 * an unrouted chat plus a live orphan world that no retry could ever reclaim.
 * Because the world identity is DERIVED from this key
 * (`deriveProvisioningStamp`), a resume re-runs the remaining steps against the
 * SAME ids and converges to one world / one chat.
 *
 * `worldId` / `branchId` / `chatId` are SOFT pointers (no FK): compensating
 * cleanup deletes the graph they name while this row survives to record the
 * failure, and a later chat delete (E20-1) must not cascade the audit away.
 */
export const simProvisioningRequests = pgTable(
  "sim_provisioning_requests",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    /** Canonical hash of `(characterId, title)` — a same-key different-ask is `idempotency_mismatch`. */
    payloadHash: text("payload_hash").notNull(),
    state: text("state", {
      enum: ["requested", "world_created", "chat_created", "relationships_seeded", "ready", "failed"],
    })
      .notNull()
      .default("requested"),
    /** Derived identities, recorded as each step commits — null until that step is reached. */
    worldId: text("world_id"),
    branchId: text("branch_id"),
    chatId: text("chat_id"),
    /** The recorded 201 — replayed verbatim for a same-key re-POST. Null until `ready`. */
    response: jsonb("response"),
    httpStatus: integer("http_status"),
    /** Why it failed, for the operator — never returned to the caller. */
    error: text("error"),
    startedAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_provisioning_requests_owner_request_pk", columns: [t.ownerId, t.requestId] }),
    // The honest quota (slice 4) counts this owner's non-terminal records; the
    // orphan sweeper (slice 2) reads them by state to spare in-flight worlds.
    index("sim_provisioning_requests_owner_state_idx").on(t.ownerId, t.state),
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

/** Minimum character facts needed by the simulation's actor-registry stores. */
export const simCharacters = pgTable(
  "sim_characters",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    characterId: text("character_id").notNull(),
    name: text("name").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_characters_branch_character_pk", columns: [t.branchId, t.characterId] }),
  ],
);

/**
 * Stable item identity and display facts, separate from mutable placement
 * (`sim_item_holdings`). E5.3 adds the material-classification key resource
 * costs reference, social ownership (distinct from holding), and
 * an optional container declaration — capacity and access are both-null
 * (not a container) or both-set, never one without the other.
 */
export const simItems = pgTable(
  "sim_items",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    name: text("name").notNull(),
    /** Authored classification key resource costs reference (E5.3). */
    materialKindKey: text("material_kind_key"),
    /** Authored body effects a consumption applies, in authored order. Null = not consumable. */
    consumptionEffects: jsonb("consumption_effects").$type<ItemConsumptionEffect[]>(),
    /** Social ownership — null = unowned. Changed only by item_ownership_set. */
    ownerActorId: text("owner_actor_id"),
    /** Present iff this item is itself a container; paired with containerAccess. */
    containerCapacityCount: bigint("container_capacity_count", { mode: "number" }),
    containerAccess: jsonb("container_access").$type<ContainerAccessPolicy>(),
    /**
     * E5.3 slice 3: whether wear/cleanliness are tracked
     * for this item. Meters/modifiers lazily initialize the first time a
     * condition-touching operation reaches a tracked item — this flag alone
     * gates whether that ever happens.
     */
    conditionTracked: boolean("condition_tracked").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_items_branch_item_pk", columns: [t.branchId, t.itemId] }),
    check(
      "sim_items_container_capacity_safe",
      sql`${t.containerCapacityCount} IS NULL OR (${t.containerCapacityCount} >= 0 AND ${t.containerCapacityCount} <= 9007199254740991)`,
    ),
    check(
      "sim_items_container_shape",
      sql`(${t.containerCapacityCount} IS NULL) = (${t.containerAccess} IS NULL)`,
    ),
  ],
);

/**
 * One row per item is the database-enforced exclusive holding invariant:
 * every item has exactly one holding locus. `locusKind` discriminates which of
 * `actorId`/`slotKey`/`containerItemId`/`zoneId`/`goneBasis` is populated — the
 * per-kind CHECK constraints below enforce exactly one reference set per row.
 * `gone` is terminal — no transition leaves it. `updatedSequence`
 * identifies the event boundary that last changed placement.
 */
export const simItemHoldings = pgTable(
  "sim_item_holdings",
  {
    branchId: text("branch_id").notNull(),
    itemId: text("item_id").notNull(),
    locusKind: text("locus_kind", { enum: ["held", "worn", "container", "zone", "gone"] }).notNull(),
    /** held/worn: the carrying/wearing actor. Null for container/zone/gone. */
    actorId: text("actor_id"),
    /** worn only: the free-text slot key (v1). Null otherwise. */
    slotKey: text("slot_key"),
    /** container only: the item this one sits inside. Null otherwise. */
    containerItemId: text("container_item_id"),
    /** zone only: the zone this item rests at. Null otherwise. */
    zoneId: text("zone_id"),
    /** gone only: the terminal disposition. Null otherwise. */
    goneBasis: text("gone_basis", { enum: itemGoneBases }),
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
      name: "sim_item_holdings_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
      // Nullable composite FK: MATCH SIMPLE means a null actorId (container/
      // zone/gone rows) is never checked against sim_characters. Drizzle
      // cannot express FK deferrability — hand-edited in migration 0069 (the
      // 0054 precedent) to DEFERRABLE INITIALLY DEFERRED, alongside the other
      // two FKs below: a world/branch teardown cascades sim_characters and
      // sim_item_holdings from the SAME sim_branches delete, and Postgres does
      // not order sibling cascades against each other, so a non-deferred FK
      // here can fire before the row it references is (about to be) gone too.
    }).onDelete("no action"),
    foreignKey({
      name: "sim_item_holdings_container_item_fk",
      columns: [t.branchId, t.containerItemId],
      foreignColumns: [simItems.branchId, simItems.itemId],
      // Drizzle cannot express FK deferrability. Hand-edited in migration 0069
      // (the 0054 precedent) to DEFERRABLE INITIALLY DEFERRED — see the actor
      // FK comment above for why a branch-cascade teardown needs this.
    }).onDelete("no action"),
    foreignKey({
      name: "sim_item_holdings_zone_fk",
      columns: [t.branchId, t.zoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
      // Drizzle cannot express FK deferrability. Hand-edited in migration 0069
      // (the 0054 precedent) to DEFERRABLE INITIALLY DEFERRED — see the actor
      // FK comment above for why a branch-cascade teardown needs this.
    }).onDelete("no action"),
    index("sim_item_holdings_container_item_idx").on(t.branchId, t.containerItemId),
    index("sim_item_holdings_actor_idx").on(t.branchId, t.actorId),
    index("sim_item_holdings_zone_idx").on(t.branchId, t.zoneId),
    check(
      "sim_item_holdings_updated_sequence_safe",
      sql`${t.updatedSequence} >= 0 AND ${t.updatedSequence} <= 9007199254740991`,
    ),
    check(
      "sim_item_holdings_held_shape",
      sql`${t.locusKind} <> 'held' OR (${t.actorId} IS NOT NULL AND ${t.slotKey} IS NULL AND ${t.containerItemId} IS NULL AND ${t.zoneId} IS NULL AND ${t.goneBasis} IS NULL)`,
    ),
    check(
      "sim_item_holdings_worn_shape",
      sql`${t.locusKind} <> 'worn' OR (${t.actorId} IS NOT NULL AND ${t.slotKey} IS NOT NULL AND ${t.containerItemId} IS NULL AND ${t.zoneId} IS NULL AND ${t.goneBasis} IS NULL)`,
    ),
    check(
      "sim_item_holdings_container_shape",
      sql`${t.locusKind} <> 'container' OR (${t.containerItemId} IS NOT NULL AND ${t.actorId} IS NULL AND ${t.slotKey} IS NULL AND ${t.zoneId} IS NULL AND ${t.goneBasis} IS NULL)`,
    ),
    check(
      "sim_item_holdings_zone_shape",
      sql`${t.locusKind} <> 'zone' OR (${t.zoneId} IS NOT NULL AND ${t.actorId} IS NULL AND ${t.slotKey} IS NULL AND ${t.containerItemId} IS NULL AND ${t.goneBasis} IS NULL)`,
    ),
    check(
      "sim_item_holdings_gone_shape",
      sql`${t.locusKind} <> 'gone' OR (${t.goneBasis} IS NOT NULL AND ${t.actorId} IS NULL AND ${t.slotKey} IS NULL AND ${t.containerItemId} IS NULL AND ${t.zoneId} IS NULL)`,
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

/**
 * Durable time-advance jobs (drain-hardening A5 slice 4): a long skip / travel drain that
 * outlives its originating HTTP request. Once a skip starts the SERVER owns completion — a
 * leased/fenced runner drains the branch to `targetStorySecond` in bounded steps, persisting
 * `reachedStorySecond` as it goes, and finishes whether or not the app stays open (the Fly
 * machine never auto-stops). Distinct from `sim_outbox` (which is event-delivery keyed to a
 * committed source event); a time job is durable player INTENT plus progress.
 *
 * Concurrency (the review's load-bearing requirement): at most ONE active job per branch (the
 * partial unique index), claimed with a lease + fenced progress writes, re-claimable on lease
 * expiry, so a second request or a boot sweep can never double-run one. `blocked` is the poison
 * outcome — a terminally-failed trigger in the window parks the job for admin repair rather than
 * a silent skip-over.
 */
export const simTimeJobs = pgTable(
  "sim_time_jobs",
  {
    id: text("id").primaryKey(),
    worldId: text("world_id").notNull(),
    branchId: text("branch_id").notNull(),
    /** The conversation that requested the skip — for the landing beat + the catch-up UI. */
    chatId: text("chat_id").notNull(),
    /** Where the drain must reach. */
    targetStorySecond: bigint("target_story_second", { mode: "number" }).notNull(),
    /** How far the drain has actually reached (progress; drives the "Day 12 of 30…" UI). */
    reachedStorySecond: bigint("reached_story_second", { mode: "number" }).notNull(),
    state: text("state", { enum: ["pending", "processing", "completed", "failed", "blocked"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** When the job may next be claimed — bumped past a `trigger_backoff` so the runner waits it out. */
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
      name: "sim_time_jobs_branch_world_fk",
      columns: [t.branchId, t.worldId],
      foreignColumns: [simBranches.id, simBranches.worldId],
    }).onDelete("cascade"),
    // At most one ACTIVE (pending/processing) job per branch — a partial unique index is the
    // one-job-per-branch guarantee at the storage layer, so a race to escalate cannot create two.
    uniqueIndex("sim_time_jobs_one_active_per_branch")
      .on(t.branchId)
      .where(sql`state in ('pending', 'processing')`),
    // The runner's claim query: due, claimable, oldest first.
    index("sim_time_jobs_claim_idx").on(t.state, t.availableAt, t.createdAt),
    index("sim_time_jobs_branch_idx").on(t.branchId, t.state),
    check(
      "sim_time_jobs_seconds_safe",
      sql`${t.reachedStorySecond} >= 0 AND ${t.reachedStorySecond} <= ${t.targetStorySecond} AND ${t.targetStorySecond} <= 9007199254740991`,
    ),
    check("sim_time_jobs_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "sim_time_jobs_processing_has_lease",
      sql`${t.state} <> 'processing' OR (${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * First disposable async projection: one stable row per material movement
 * event. E5.3 bumps this to schema version 2 — `eventKind` distinguishes a
 * transfer from a destruction, and `fromLocus`/`toLocus` carry the locus-model
 * placement (a destruction's `toLocus` is its terminal `gone` locus).
 */
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
    eventKind: text("event_kind", { enum: itemMaterialFeedEventKinds }).notNull(),
    fromLocus: jsonb("from_locus").$type<ItemLocus>().notNull(),
    toLocus: jsonb("to_locus").$type<ItemLocus>().notNull(),
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
    // The contract's kind list verbatim (type-level only — text emits no SQL),
    // so a new trigger kind can never drift out of this column's typing.
    kind: text("kind", { enum: [...simulationTriggerKinds] }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    dueStorySecond: bigint("due_story_second", { mode: "number" }).notNull(),
    /** Queue order: lower is more urgent. No producer sets it above 0 yet. */
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
     * Which scheduler ruleset produced this trigger's terminal outcome. Queue
     * order is part of the ruleset version, so a later scheduler
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
 * Replay checkpoints. A snapshot carries the full projection
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
 * E3.1 authoritative space. Topology rows are branch-scoped
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
 * Exactly one physical locus per actor per branch — the primary key IS that
 * invariant. Shape checks keep an `at` row from carrying journey fields
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
 * E3.2 activity instances. Claims are projected from
 * these rows — an actor's held claims are the claims of their non-terminal
 * activities — so a crashed worker can never orphan a claim.
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
    /** Items reserved at start, held across every claim-holding phase. */
    reservedItemIds: jsonb("reserved_item_ids").$type<string[]>().notNull().default([]),
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
 * E3.3 commitments. The window and derivation columns are
 * captured at creation (the creating event records them too); status is the
 * state machine driven by the notice and deadline triggers.
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
    /** Nullable (E5.5 slice 2): a destinationless commitment carries no spatial obligation. */
    destinationZoneId: text("destination_zone_id"),
    /** E5.5 slice 2: the counterpart a promise runs toward. */
    promisedToActorId: text("promised_to_actor_id"),
    /** E5.5 slice 2: the `missed` commitment this one repairs (self-referential). */
    repairsCommitmentId: text("repairs_commitment_id"),
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
    foreignKey({
      name: "sim_commitments_repairs_commitment_fk",
      columns: [t.branchId, t.repairsCommitmentId],
      foreignColumns: [t.branchId, t.commitmentId],
      // Self-referential — DEFERRABLE INITIALLY DEFERRED hand-edit, 0069/0076 precedent.
    }).onDelete("no action"),
    index("sim_commitments_branch_status_idx").on(t.branchId, t.status),
    check(
      "sim_commitments_latest_arrival_safe",
      sql`${t.latestArrival} >= 0 AND ${t.latestArrival} <= 9007199254740991`,
    ),
  ],
);

/** E3.3 temporal pressures, one per commitment notice. */
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
    /** E5.5 slice 3: severity captured at acknowledgment time. */
    acknowledgedSeverity: text("acknowledged_severity", {
      enum: ["background", "salient", "urgent", "hard"],
    }),
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
 * E3.4 engagements. Attention claims are projected from
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
    /** E5.5 slice 3: temporal-pressure ids acknowledged within this engagement. */
    acknowledgedPressureIds: jsonb("acknowledged_pressure_ids").$type<string[]>().notNull().default([]),
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
 * R4 shadow divergences: one row per compared domain
 * per shadowed exchange — the queryable substrate the shadow-parity report is
 * computed from. `legacy`/`successor` hold each lane's raw view of the domain;
 * `verdict` is the durable triage state ("ruled intentional" survives here,
 * not in a doc). Rows are observations, never effects — deleting them all
 * changes nothing about either lane.
 *
 * Retention is chat-scoped: rows outlive the mirror branch/world they were
 * recorded against, so stopping a comparison session (which deletes a managed
 * mirror world) keeps every recorded comparison and ruling. `branch_id` is
 * provenance only — nothing reads it back — and goes null when its branch is
 * deleted.
 */
export const simShadowDivergences = pgTable(
  "sim_shadow_divergences",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => characterChats.id, { onDelete: "cascade" }),
    /** The settled assistant message this comparison anchors to. */
    messageId: text("message_id").notNull(),
    /** Provenance of the successor side. Null once the mirror branch is gone. */
    branchId: text("branch_id").references(() => simBranches.id, { onDelete: "set null" }),
    /** Compared domain: prose | presence | meters | clock — vocabulary grows without migration. */
    domain: text("domain").notNull(),
    legacy: jsonb("legacy").notNull(),
    successor: jsonb("successor").notNull(),
    /** One-line human summary of what differs (or "" when the row is informational). */
    detail: text("detail").notNull().default(""),
    verdict: text("verdict", { enum: ["open", "intentional", "fixed"] })
      .notNull()
      .default("open"),
    createdAt: createdAt(),
  },
  (t) => [
    index("sim_shadow_divergences_chat_idx").on(t.chatId, t.createdAt),
    index("sim_shadow_divergences_verdict_idx").on(t.verdict),
  ],
);

/**
 * E3.5 access grants. Malformed rows fail closed at read
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
 * E4.1 observation log: one row per (event, witness),
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
 * E4.2 assertions: claims made on a branch — possibly
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
 * E4.2 beliefs: one actor's held stance toward an
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
 * E4.3 persisted NarrativeCuts. A cut row is IMMUTABLE and
 * addressable: rerender re-reads it and creates nothing; a failed narrator
 * render retries from the same row (ruling 8); armed speech acts confirm
 * against it by id. There is deliberately no update path and no
 * updated_at — recompiling the same cut id must reproduce semantic_hash or
 * fail with a version diagnostic.
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
    /** The full parsed cut — the row IS the render input, bit for bit. */
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
 * E4.3 soft canon (ruling 14): the bounded expiring store
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
 * E4.4 memory documents: redacted, indexable recall
 * representations derived from persisted source rows by the memory-index
 * outbox consumer. Eligibility, validity, and privacy are resolved
 * relationally at query time — this table never widens what any
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
 * E5.1 body meters. One row per actor × meter; the value
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

/** E5.1 body conditions: categorical, sourced, self-expiring. */
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
 * E5.2 rhythm rows — authored branch-scoped daily
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
    kind: text("kind", { enum: ["sleep", "wash", "meal"] }).notNull(),
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
 * E5.1 body modifiers — the one modifier contract. Validity boundaries are
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

/**
 * E5.3 slice 3 item condition meters. Wear and
 * cleanliness ride the SAME fixed-point kernel `sim_body_meters` does —
 * this is an item-scoped mirror, not a reuse of that table: one row per item
 * × meter, value fixed-point (10 000 ≡ 1.0), `last_integrated_at` the last
 * MATERIAL write. Queries integrate analytically from here and never
 * persist, same partition-invariance property as bodies. Rows appear lazily
 * — the first condition-touching operation on a tracked item initializes
 * them (`item_condition_initialized`), there is no dedicated command.
 */
export const simItemConditionMeters = pgTable(
  "sim_item_condition_meters",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    meterKey: text("meter_key").notNull(),
    valueFixedPoint: integer("value_fixed_point").notNull(),
    baselineFixedPoint: integer("baseline_fixed_point").notNull(),
    lastIntegratedAt: bigint("last_integrated_at", { mode: "number" }).notNull(),
    registryVersion: text("registry_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_item_condition_meters_branch_item_meter_pk",
      columns: [t.branchId, t.itemId, t.meterKey],
    }),
    check(
      "sim_item_condition_meters_value_fixed_point_range",
      sql`${t.valueFixedPoint} >= 0 AND ${t.valueFixedPoint} <= 10000`,
    ),
    check(
      "sim_item_condition_meters_baseline_fixed_point_range",
      sql`${t.baselineFixedPoint} >= 0 AND ${t.baselineFixedPoint} <= 10000`,
    ),
    check(
      "sim_item_condition_meters_last_integrated_safe",
      sql`${t.lastIntegratedAt} >= 0 AND ${t.lastIntegratedAt} <= 9007199254740991`,
    ),
  ],
);

/**
 * E5.3 slice 3 item condition modifiers — the same modifier contract,
 * item-scoped, mirroring `sim_body_modifiers` minus `condition_id` AND
 * `visibility`: items have no categorical conditions in v1, so every
 * modifier is applied and retired directly (e.g. the
 * worn-window cleanliness modifier `buildWornWindowTransition` builds), and
 * every modifier this substrate ever creates is hard-coded `"obvious"`
 * visibility (see the registry doc comment in
 * `@/contracts/simulation/material-condition`) — so the column is dropped
 * and the pure `ItemConditionModifier.visibility` field is reconstructed as
 * the literal `"obvious"` at read time instead of persisted (mirrors
 * `item-condition-store.ts`'s `itemConditionModifierFromRow`/
 * `itemConditionModifierRowInsert`, the canonical row mappers). The
 * `(branch_id, item_id)` FK is DEFERRABLE INITIALLY DEFERRED — drizzle
 * cannot express deferrability (hand-edited in the migration, the 0069
 * `sim_item_holdings` precedent): a branch teardown cascades `sim_items` and
 * this table from the SAME `sim_branches` delete, and Postgres does not
 * order sibling cascades against each other.
 */
export const simItemConditionModifiers = pgTable(
  "sim_item_condition_modifiers",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    modifierId: text("modifier_id").notNull(),
    itemId: text("item_id").notNull(),
    meterKey: text("meter_key").notNull(),
    operation: jsonb("operation").$type<BodyModifierOperation>().notNull(),
    stackingGroup: text("stacking_group").notNull(),
    priority: integer("priority").notNull().default(0),
    validFrom: bigint("valid_from", { mode: "number" }).notNull(),
    validUntil: bigint("valid_until", { mode: "number" }),
    sourceEventId: text("source_event_id").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_item_condition_modifiers_branch_modifier_pk", columns: [t.branchId, t.modifierId] }),
    foreignKey({
      name: "sim_item_condition_modifiers_item_fk",
      columns: [t.branchId, t.itemId],
      foreignColumns: [simItems.branchId, simItems.itemId],
      // Drizzle cannot express FK deferrability — hand-edited in the migration
      // to DEFERRABLE INITIALLY DEFERRED (see the table doc comment above).
      // "no action" (not cascade), mirroring sim_item_holdings' three deferred
      // FKs: this row and its referenced sim_items row cascade from the SAME
      // sim_branches delete rather than one cascading the other directly.
    }).onDelete("no action"),
    index("sim_item_condition_modifiers_branch_item_meter_idx").on(t.branchId, t.itemId, t.meterKey),
    check(
      "sim_item_condition_modifiers_validity_order",
      sql`${t.validUntil} IS NULL OR ${t.validUntil} > ${t.validFrom}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// E5.4 — households, fungible lots, conservation, means bands, and the
// restock routine.
//
// Why lots and means-bands get a synthetic persistence-layer key but
// households and membership don't: a lot's locus is a *discriminated*
// reference (household XOR actor XOR zone) that needs three separate
// nullable columns so each can carry its own typed foreign key — mirroring
// `sim_item_holdings`. But Postgres primary-key columns cannot be NULL, so
// `(branch_id, locus_kind, household_id, actor_id, zone_id,
// material_kind_key)` cannot be the primary key when three of those columns
// are nullable by construction. `sim_items` sidesteps this because `item_id`
// is a caller-supplied identity independent of locus; lots have no such
// identity in the domain model (they're addressed by `(locus,
// materialKindKey)` everywhere in contracts/events — see
// `packages/simulation-core/src/lib/households/lots.ts`'s
// `deriveMaterialLotRowKey`), so the STORE
// layer synthesizes one deterministic string purely to have a non-null PK
// column. The same nullable-discriminant problem applies to means-band
// subjects (`actor` XOR `household`), solved the same way
// (`deriveMeansSubjectRowKey`). Households and membership rows have no such
// discriminant — a household's own id is caller-supplied (like an item), and
// a membership row's `(household_id, actor_id)` pair is always fully
// populated (no branching) — so they use ordinary composite PKs, no
// synthetic key needed.
// ---------------------------------------------------------------------------

/**
 * E5.4 households — a shared domestic unit. `residence_zone_ids`
 * is a sorted-unique jsonb array (small, v1 households are small; mirrors how
 * `container_access`'s allow-list is stored inline rather than as a join table).
 */
export const simHouseholds = pgTable(
  "sim_households",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    householdId: text("household_id").notNull(),
    name: text("name").notNull(),
    residenceZoneIds: jsonb("residence_zone_ids").$type<string[]>().notNull(),
    stockAccessPolicy: jsonb("stock_access_policy").$type<HouseholdStockAccessPolicy>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_households_branch_household_pk", columns: [t.branchId, t.householdId] }),
  ],
);

/**
 * E5.4 household membership. `status = 'ended'` iff `ended_at_story_second` is
 * set (mirrors `sim_body_conditions`' end-basis-matches-status check). The
 * household and actor FKs are DEFERRABLE INITIALLY DEFERRED (hand-edited in
 * the migration, the 0069 precedent): a branch teardown cascades
 * `sim_households`/`sim_characters` and this table from the SAME
 * `sim_branches` delete.
 */
export const simHouseholdMembers = pgTable(
  "sim_household_members",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    householdId: text("household_id").notNull(),
    actorId: text("actor_id").notNull(),
    role: text("role", { enum: householdMemberRoles }).notNull(),
    status: text("status", { enum: householdMembershipStatuses }).notNull(),
    endedAtStorySecond: bigint("ended_at_story_second", { mode: "number" }),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_household_members_branch_household_actor_pk",
      columns: [t.branchId, t.householdId, t.actorId],
    }),
    foreignKey({
      name: "sim_household_members_household_fk",
      columns: [t.branchId, t.householdId],
      foreignColumns: [simHouseholds.branchId, simHouseholds.householdId],
    }).onDelete("no action"),
    foreignKey({
      name: "sim_household_members_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
    index("sim_household_members_branch_actor_idx").on(t.branchId, t.actorId),
    check(
      "sim_household_members_end_basis_matches_status",
      sql`(${t.status} = 'ended') = (${t.endedAtStorySecond} IS NOT NULL)`,
    ),
  ],
);

/**
 * E5.4 fungible material lots. `lot_key` is a synthetic, deterministic,
 * content-addressed persistence-layer key (`deriveMaterialLotRowKey`,
 * `packages/simulation-core/src/lib/households/lots.ts`) — NOT a domain id;
 * contracts/events address a lot by
 * `(locus, materialKindKey)` directly. It exists only because Postgres cannot make a
 * discriminated nullable-column tuple a primary key (see the migration-note comment
 * above `simHouseholds`). Zero quantity is NOT terminal (unlike item holdings' `gone`).
 * The household/actor/zone FKs are DEFERRABLE INITIALLY DEFERRED (hand-edited, 0069
 * precedent).
 */
export const simMaterialLots = pgTable(
  "sim_material_lots",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    lotKey: text("lot_key").notNull(),
    locusKind: text("locus_kind", { enum: ["household", "actor", "zone"] }).notNull(),
    householdId: text("household_id"),
    actorId: text("actor_id"),
    zoneId: text("zone_id"),
    materialKindKey: text("material_kind_key").notNull(),
    quantityKind: text("quantity_kind", { enum: materialQuantityKinds }).notNull(),
    quantityRaw: bigint("quantity_raw", { mode: "number" }).notNull().default(0),
    registryVersion: text("registry_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_material_lots_branch_lot_pk", columns: [t.branchId, t.lotKey] }),
    foreignKey({
      name: "sim_material_lots_household_fk",
      columns: [t.branchId, t.householdId],
      foreignColumns: [simHouseholds.branchId, simHouseholds.householdId],
    }).onDelete("no action"),
    foreignKey({
      name: "sim_material_lots_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
    foreignKey({
      name: "sim_material_lots_zone_fk",
      columns: [t.branchId, t.zoneId],
      foreignColumns: [simZones.branchId, simZones.zoneId],
    }).onDelete("no action"),
    index("sim_material_lots_household_kind_idx").on(t.branchId, t.householdId, t.materialKindKey),
    index("sim_material_lots_actor_kind_idx").on(t.branchId, t.actorId, t.materialKindKey),
    index("sim_material_lots_zone_kind_idx").on(t.branchId, t.zoneId, t.materialKindKey),
    check(
      "sim_material_lots_quantity_safe",
      sql`${t.quantityRaw} >= 0 AND ${t.quantityRaw} <= 9007199254740991`,
    ),
    check(
      "sim_material_lots_household_shape",
      sql`${t.locusKind} <> 'household' OR (${t.householdId} IS NOT NULL AND ${t.actorId} IS NULL AND ${t.zoneId} IS NULL)`,
    ),
    check(
      "sim_material_lots_actor_shape",
      sql`${t.locusKind} <> 'actor' OR (${t.actorId} IS NOT NULL AND ${t.householdId} IS NULL AND ${t.zoneId} IS NULL)`,
    ),
    check(
      "sim_material_lots_zone_shape",
      sql`${t.locusKind} <> 'zone' OR (${t.zoneId} IS NOT NULL AND ${t.householdId} IS NULL AND ${t.actorId} IS NULL)`,
    ),
  ],
);

/**
 * E5.4 means bands. `subject_key` is the same kind of synthetic
 * persistence-layer key as `sim_material_lots.lot_key`, for the same reason (the
 * actor-XOR-household discriminant cannot be a nullable primary key). The actor/
 * household FKs are DEFERRABLE INITIALLY DEFERRED (hand-edited, 0069 precedent).
 */
export const simMeansBands = pgTable(
  "sim_means_bands",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    subjectKey: text("subject_key").notNull(),
    subjectKind: text("subject_kind", { enum: ["actor", "household", "cohort"] }).notNull(),
    actorId: text("actor_id"),
    householdId: text("household_id"),
    cohortId: text("cohort_id"),
    bandKey: text("band_key", { enum: meansBandKeys }).notNull(),
    registryVersion: text("registry_version").notNull(),
    setAtStorySecond: bigint("set_at_story_second", { mode: "number" }).notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_means_bands_branch_subject_pk", columns: [t.branchId, t.subjectKey] }),
    foreignKey({
      name: "sim_means_bands_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
    foreignKey({
      name: "sim_means_bands_household_fk",
      columns: [t.branchId, t.householdId],
      foreignColumns: [simHouseholds.branchId, simHouseholds.householdId],
    }).onDelete("no action"),
    check(
      "sim_means_bands_actor_shape",
      sql`${t.subjectKind} <> 'actor' OR (${t.actorId} IS NOT NULL AND ${t.householdId} IS NULL)`,
    ),
    check(
      "sim_means_bands_household_shape",
      sql`${t.subjectKind} <> 'household' OR (${t.householdId} IS NOT NULL AND ${t.actorId} IS NULL)`,
    ),
  ],
);

/**
 * E5.4 slice 2 restock routines — authored per household × material
 * kind, natural composite key (no branching discriminant, so no synthetic key
 * needed — mirrors `sim_body_rhythms`). Live/evented (unlike rhythms):
 * `configure_restock_routine` upserts this row. The household FK is
 * DEFERRABLE INITIALLY DEFERRED (hand-edited, 0069 precedent).
 */
export const simHouseholdRestockRoutines = pgTable(
  "sim_household_restock_routines",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    householdId: text("household_id").notNull(),
    materialKindKey: text("material_kind_key").notNull(),
    targetQuantityRaw: bigint("target_quantity_raw", { mode: "number" }).notNull(),
    lowWaterThresholdRaw: bigint("low_water_threshold_raw", { mode: "number" }).notNull(),
    cadenceSeconds: integer("cadence_seconds").notNull(),
    funding: jsonb("funding").$type<RestockFunding>().notNull(),
    active: boolean("active").notNull().default(true),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "sim_household_restock_routines_branch_household_kind_pk",
      columns: [t.branchId, t.householdId, t.materialKindKey],
    }),
    foreignKey({
      name: "sim_household_restock_routines_household_fk",
      columns: [t.branchId, t.householdId],
      foreignColumns: [simHouseholds.branchId, simHouseholds.householdId],
    }).onDelete("no action"),
    check(
      "sim_household_restock_routines_threshold_order",
      sql`${t.lowWaterThresholdRaw} <= ${t.targetQuantityRaw}`,
    ),
    check("sim_household_restock_routines_cadence_positive", sql`${t.cadenceSeconds} > 0`),
  ],
);

/**
 * E5.5 relationship ledger. Append-only — no update path
 * except the derived-vs-authored distinction and payload are fixed at insert.
 * `entry_id` is derived (never caller identity) but IS the natural PK
 * (unlike E5.4's lots/means-bands, an entry has no discriminated-nullable-
 * column locus problem — `from_actor_id`/`to_actor_id` are always populated).
 */
export const simRelationshipLedger = pgTable(
  "sim_relationship_ledger",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    entryId: text("entry_id").notNull(),
    kind: text("kind", { enum: relationshipLedgerKinds }).notNull(),
    fromActorId: text("from_actor_id").notNull(),
    toActorId: text("to_actor_id").notNull(),
    provenance: text("provenance", { enum: relationshipLedgerProvenances }).notNull(),
    payload: jsonb("payload").$type<RelationshipLedgerPayload>().notNull(),
    detail: text("detail"),
    sourceEventId: text("source_event_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    storySecond: bigint("story_second", { mode: "number" }).notNull(),
    derivationVersion: text("derivation_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "sim_relationship_ledger_branch_entry_pk", columns: [t.branchId, t.entryId] }),
    foreignKey({
      name: "sim_relationship_ledger_from_actor_fk",
      columns: [t.branchId, t.fromActorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
    foreignKey({
      name: "sim_relationship_ledger_to_actor_fk",
      columns: [t.branchId, t.toActorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
    index("sim_relationship_ledger_branch_dyad_idx").on(t.branchId, t.fromActorId, t.toActorId),
    index("sim_relationship_ledger_branch_kind_idx").on(t.branchId, t.kind),
    check("sim_relationship_ledger_distinct_actors", sql`${t.fromActorId} <> ${t.toActorId}`),
  ],
);

/**
 * E6.1 actor LOD ledger. One row per assigned actor —
 * an actor with no row reads the versioned registry defaults, so the table
 * stays sparse (background casts arm nothing, mirrors `sim_body_rhythms`'
 * assumed-rhythm rule). Live/evented: `assign_actor_lod` upserts this row and
 * appends `actor_lod_assigned`; fork children rebuild it from inherited events.
 */
export const simActorLods = pgTable(
  "sim_actor_lods",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    simulationLod: text("simulation_lod", { enum: simulationLods }).notNull(),
    inferenceLod: text("inference_lod", { enum: inferenceLods }).notNull(),
    registryVersion: text("registry_version").notNull(),
    assignedAtStorySecond: bigint("assigned_at_story_second", { mode: "number" }).notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_actor_lods_branch_actor_pk", columns: [t.branchId, t.actorId] }),
    foreignKey({
      name: "sim_actor_lods_actor_fk",
      columns: [t.branchId, t.actorId],
      foreignColumns: [simCharacters.branchId, simCharacters.characterId],
    }).onDelete("no action"),
  ],
);

/**
 * E6.3 population cohorts: one branch-scoped row per
 * conserved background count. State is fully evented (`cohort_created` /
 * `cohort_adjusted`); fork children rebuild rows from inherited events, and
 * presence at a zone is an analytic read over `presence_windows` — never a
 * row write. Presence-window zones are validated at command time against
 * live zones, not FK-enforced: zone rows are branch-seeded topology while
 * cohorts arrive later by command, and a fail-closed resolver check keeps
 * the integrity without coupling the two seeding orders.
 */
export const simCohorts = pgTable(
  "sim_cohorts",
  {
    branchId: text("branch_id")
      .notNull()
      .references(() => simBranches.id, { onDelete: "cascade" }),
    cohortId: text("cohort_id").notNull(),
    name: text("name").notNull(),
    population: integer("population").notNull(),
    presenceWindows: jsonb("presence_windows").$type<CohortPresenceWindow[]>().notNull(),
    registryVersion: text("registry_version").notNull(),
    updatedSequence: bigint("updated_sequence", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "sim_cohorts_branch_cohort_pk", columns: [t.branchId, t.cohortId] }),
    check("sim_cohorts_population_nonnegative", sql`${t.population} >= 0`),
  ],
);
