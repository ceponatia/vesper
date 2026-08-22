import { and, asc, eq, sql } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import {
  characterChats,
  characters,
  chatParticipants,
  db,
  simBranches,
  simShadowDivergences,
  simWorlds,
} from "@/server/db";
import { log } from "@/server/log";
import { resolveChatPersona } from "@/server/players/persona";
import { readChatEngineAuthority, setChatEngineAuthority } from "./chat-authority";
import { loadChatScenario, loadChatState, seedChatState } from "./chat-state";
import { loadChatWardrobeWithStatus } from "./chat-wardrobe";
import { chatExchangeLockKey, withKeyedLock } from "./keyed-lock";
import {
  COMPARISON_WORLD_TYPE_ID,
  deleteSimWorldGraph,
  provisionComparisonWorld,
} from "./simulation";

export interface EngineComparisonStatus {
  active: boolean;
  canStart: boolean;
  reason: string | null;
  rows: number;
}

export type EngineComparisonMutationResult =
  | { ok: true; status: EngineComparisonStatus }
  | { ok: false; code: string; message: string; status: EngineComparisonStatus };

async function participantCount(chatId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId));
  return row?.count ?? 0;
}

async function comparisonRowCount(chatId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(simShadowDivergences)
    .where(eq(simShadowDivergences.chatId, chatId));
  return row?.count ?? 0;
}

async function comparisonBranchRowCount(chatId: string, branchId: string): Promise<number> {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(simShadowDivergences)
    .where(and(eq(simShadowDivergences.chatId, chatId), eq(simShadowDivergences.branchId, branchId)));
  return row?.count ?? 0;
}

/**
 * Browser-facing status. `open`/`legacy_chat` alone is not enough: comparison
 * requires a complete mirror mapping, and today the recorder is pair-based so
 * group chats are intentionally ineligible rather than partially compared.
 */
export async function readEngineComparisonStatus(chatId: string): Promise<EngineComparisonStatus> {
  const [authority, count, rows] = await Promise.all([
    readChatEngineAuthority(chatId),
    participantCount(chatId),
    comparisonRowCount(chatId),
  ]);
  if (!authority) return { active: false, canStart: false, reason: "Conversation not found.", rows };

  const active =
    authority.authority === "successor_shadow" &&
    Boolean(authority.simBranchId && authority.simPlayerActorId && authority.simPrimaryActorId);
  if (active) return { active: true, canStart: false, reason: null, rows };
  if (authority.authority !== "legacy_chat") {
    return {
      active: false,
      canStart: false,
      reason: "Engine Comparison is only available while the legacy chat engine is authoritative.",
      rows,
    };
  }
  if (count !== 1) {
    return {
      active: false,
      canStart: false,
      reason: "Engine Comparison currently supports one-on-one conversations only.",
      rows,
    };
  }
  if (authority.simBranchId || authority.simPlayerActorId || authority.simPrimaryActorId) {
    return {
      active: false,
      canStart: false,
      reason: "This legacy chat already has a simulation mapping that must be cleared before comparison can start.",
      rows,
    };
  }
  return { active: false, canStart: true, reason: null, rows };
}

async function mirrorWorldForBranch(branchId: string): Promise<{ worldId: string; managed: boolean } | null> {
  const [row] = await db()
    .select({ worldId: simBranches.worldId, worldTypeId: simWorlds.worldTypeId })
    .from(simBranches)
    .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
    .where(eq(simBranches.id, branchId))
    .limit(1);
  return row ? { worldId: row.worldId, managed: row.worldTypeId === COMPARISON_WORLD_TYPE_ID } : null;
}

function failure(code: string, message: string, status: EngineComparisonStatus): EngineComparisonMutationResult {
  return { ok: false, code, message, status };
}

/**
 * Create a fresh mirror from the legacy chat's CURRENT comparable state and
 * atomically switch the chat into the internal `successor_shadow` authority.
 * The legacy lane remains player-visible and authoritative.
 */
export async function startEngineComparison(chatId: string, ownerId: string): Promise<EngineComparisonMutationResult> {
  return withKeyedLock(chatExchangeLockKey(chatId), async () => {
    const status = await readEngineComparisonStatus(chatId);
    if (status.active) return { ok: true, status };
    if (!status.canStart) return failure("comparison_unavailable", status.reason ?? "Engine Comparison is unavailable.", status);

    const participantRows = await db()
      .select({ characterId: chatParticipants.characterId, sort: chatParticipants.sort })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId))
      .orderBy(asc(chatParticipants.sort));
    const primaryCharacterId = participantRows[0]?.characterId;
    if (!primaryCharacterId || participantRows.length !== 1) {
      return failure("comparison_requires_pair", "Engine Comparison currently supports one-on-one conversations only.", status);
    }

    const [chat, character] = await Promise.all([
      db()
        .select({ ownerId: characterChats.ownerId, archivedAt: characterChats.archivedAt })
        .from(characterChats)
        .where(eq(characterChats.id, chatId))
        .limit(1)
        .then((rows) => rows[0]),
      db()
        .select({ name: characters.name, profile: characters.profile })
        .from(characters)
        .where(and(eq(characters.id, primaryCharacterId), eq(characters.ownerId, ownerId)))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!chat || chat.ownerId !== ownerId || !character) {
      return failure("not_found", "Conversation not found.", status);
    }
    if (chat.archivedAt !== null) {
      return failure("chat_archived", "Restore the conversation before starting Engine Comparison.", status);
    }

    const profile = parseOr(
      characterProfileSchema,
      character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const [scenario, storedState, persona] = await Promise.all([
      loadChatScenario(chatId),
      loadChatState(chatId, primaryCharacterId),
      resolveChatPersona({ ownerId, chatId }),
    ]);
    if (!scenario) return failure("not_found", "Conversation not found.", status);
    const state = storedState ?? seedChatState(profile);

    const wardrobeLoad = await loadChatWardrobeWithStatus(ownerId, state.wornItemIds);
    if (wardrobeLoad.failed === true || (wardrobeLoad.coverageUnreliableIds?.length ?? 0) > 0) {
      return failure(
        "comparison_wardrobe_unavailable",
        "The current wardrobe could not be read reliably. Retry before starting Engine Comparison.",
        status,
      );
    }
    const garments = wardrobeLoad.wardrobe.map((item, index) => ({
      name: item.name,
      slotKey: `${item.coverage[0] ?? "garment"}-${index}`,
    }));

    // Sim storySecond 0 is midnight of calendarStart. Legacy clockMinutes is
    // elapsed from an anchor that also carries hour/minute, so fold the anchor's
    // time-of-day into the successor origin to preserve the actual current moment.
    const anchorMinute = scenario.calendarStart.hour * 60 + scenario.calendarStart.minute;
    const storySecond = Math.max(0, Math.floor((anchorMinute + scenario.clockMinutes) * 60));

    let mirror: Awaited<ReturnType<typeof provisionComparisonWorld>>;
    try {
      mirror = await provisionComparisonWorld({
        playerName: persona.name,
        primaryName: character.name,
        storySecond,
        calendarStart: {
          year: scenario.calendarStart.year,
          month: scenario.calendarStart.month,
          day: scenario.calendarStart.day,
        },
        primaryPresent: state.presence === "present",
        primaryMeters: state.meters,
        primaryGarments: garments,
      });
    } catch (error) {
      log.error("engine.comparison", "comparison mirror provisioning failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return failure("comparison_provision_failed", "Could not build the comparison mirror. Try again.", status);
    }

    const flipped = await setChatEngineAuthority({
      chatId,
      byUserId: ownerId,
      authority: "successor_shadow",
      simBranchId: mirror.branchId,
      simPlayerActorId: mirror.playerActorId,
      simPrimaryActorId: mirror.primaryActorId,
    });
    if (!flipped) {
      await deleteSimWorldGraph(mirror.worldId).catch(() => undefined);
      return failure("comparison_flip_failed", "The comparison mirror was built but could not be attached.", status);
    }

    log.info("engine.comparison", "Engine Comparison started", {
      chatId,
      branchId: mirror.branchId,
    });
    return { ok: true, status: await readEngineComparisonStatus(chatId) };
  }, "engine_comparison_setup");
}

/**
 * Return the chat to plain legacy authority and clear its live mirror mapping.
 *
 * Comparison rows retain a required FK to the branch they observed. Therefore a
 * managed mirror is deleted only when that branch produced ZERO rows. Once a
 * session has evidence, its detached world/branch is retained as inert provenance
 * so stopping comparison cannot erase recorded rows or rulings through the FK's
 * ON DELETE CASCADE. Older/manual shadow mappings are likewise never destroyed by
 * this service unless ownership is both known and row-free.
 */
export async function stopEngineComparison(chatId: string, ownerId: string): Promise<EngineComparisonMutationResult> {
  return withKeyedLock(chatExchangeLockKey(chatId), async () => {
    const authority = await readChatEngineAuthority(chatId);
    const status = await readEngineComparisonStatus(chatId);
    if (!authority || authority.authority !== "successor_shadow") {
      return failure("comparison_not_active", "Engine Comparison is not active on this conversation.", status);
    }
    const branchId = authority.simBranchId;
    const [mirror, branchRows] = await Promise.all([
      branchId ? mirrorWorldForBranch(branchId) : Promise.resolve(null),
      branchId ? comparisonBranchRowCount(chatId, branchId) : Promise.resolve(0),
    ]);

    const flipped = await setChatEngineAuthority({
      chatId,
      byUserId: ownerId,
      authority: "legacy_chat",
      simBranchId: null,
      simPlayerActorId: null,
      simPrimaryActorId: null,
    });
    if (!flipped) return failure("comparison_stop_failed", "Could not stop Engine Comparison.", status);

    if (mirror?.managed && branchRows === 0) {
      try {
        await deleteSimWorldGraph(mirror.worldId);
      } catch (error) {
        // The chat is already safely unlinked. The ordinary orphan sweeper can
        // reclaim this row-free failed delete, so this is diagnostic rather than rollback.
        log.warn("engine.comparison", "row-free comparison mirror cleanup failed after unlink", {
          chatId,
          worldId: mirror.worldId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (mirror?.managed && branchRows > 0) {
      log.info("engine.comparison", "comparison mirror retained as evidence provenance", {
        chatId,
        branchId,
        worldId: mirror.worldId,
        rows: branchRows,
      });
    }
    log.info("engine.comparison", "Engine Comparison stopped", { chatId, branchId });
    return { ok: true, status: await readEngineComparisonStatus(chatId) };
  }, "engine_comparison_setup");
}
