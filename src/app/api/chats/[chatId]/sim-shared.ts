import { deriveEngagementId, simulationHash } from "@/lib/simulation";
import { jsonError } from "@/server/api";
import { readChatEngineAuthority } from "@/server/engine";
import { loadOwnedChat, type OwnedChat } from "../owned";

/**
 * R3 (engine.rollout.plan.md) — the one gate every sim route shares: the chat
 * must be owned, flipped past the view threshold, branch-linked, and
 * actor-mapped. Returns the resolved sim context or the response to send.
 */
export interface SimChatContext {
  owned: OwnedChat;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  /** The standing scene between the mapped pair — stable per chat. */
  openCommandId: string;
  engagementId: string;
}

export async function requireSimChat(
  chatId: string,
  userId: string,
): Promise<{ ok: true; sim: SimChatContext } | { ok: false; response: Response }> {
  const owned = await loadOwnedChat(chatId, userId);
  if (!owned) return { ok: false, response: jsonError("not_found", "chat not found", 404) };
  const authority = await readChatEngineAuthority(chatId);
  if (
    !authority ||
    authority.authority === "legacy_chat" ||
    authority.authority === "successor_shadow" ||
    !authority.simBranchId ||
    !authority.simPlayerActorId ||
    !authority.simPrimaryActorId
  ) {
    return {
      ok: false,
      response: jsonError(
        "not_sim_enabled",
        "this chat is not routed to the successor engine (authority + branch + actor mapping required)",
        409,
      ),
    };
  }
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const primaryActorId = authority.simPrimaryActorId;
  const openCommandId = `sim-turn-open-${simulationHash({ chatId, playerActorId, primaryActorId })}`;
  return {
    ok: true,
    sim: {
      owned,
      branchId,
      playerActorId,
      primaryActorId,
      openCommandId,
      engagementId: deriveEngagementId(branchId, openCommandId),
    },
  };
}

/** The player-principal envelope every sim route submits under. */
export function simPlayerEnvelope(sim: SimChatContext, userId: string, commandId: string) {
  return {
    id: commandId,
    branchId: sim.branchId,
    expectedVersion: 0,
    idempotencyKey: commandId,
    principal: { kind: "player" as const, principalId: userId, controlledActorIds: [sim.playerActorId] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-${sim.owned.chat.id}`,
    schemaVersion: 1,
  };
}
