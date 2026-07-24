import { jsonError } from "@/server/api";
import { CHAT_LOCK_LABEL_REPLY, keyedLockHolderLabel, readChatEngineAuthority } from "@/server/engine";
import { loadOwnedChat, type OwnedChat } from "../owned";

/**
 * The per-chat serialization key both reply lanes (send pipeline, sim turn) and
 * the successor sim-commands hold (command-integrity A1-2): one exchange in
 * flight per conversation from any tab, lane, or headless caller.
 */
export function chatExchangeLockKey(chatId: string): string {
  return `chat_exchange:${chatId}`;
}

/**
 * The A1-1 / A2-2 busy bounce: contention turns away immediately (never queues),
 * and the copy names the cause from the current holder's label — a streaming
 * reply vs. the world catching up (fallback: catching up). Shared 409 `chat_busy`
 * code so the client handles every lane the same way.
 */
export function chatBusyBounce(chatId: string): Response {
  const holder = keyedLockHolderLabel(chatExchangeLockKey(chatId));
  return holder === CHAT_LOCK_LABEL_REPLY
    ? jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409)
    : jsonError("chat_busy", "the world is catching up on this chat; try again in a moment", 409);
}

/**
 * R3 (engine.rollout.plan.md) — the one gate every sim route shares: the chat
 * must be owned, flipped past the view threshold, branch-linked, and
 * actor-mapped. Returns the resolved sim context or the response to send.
 * The standing scene is deliberately NOT derived here: engagement identity
 * belongs to the actor pair in the world, not to a chat — resolve it live
 * via `findStandingEngagement` (engine `sim-exchange`).
 */
export interface SimChatContext {
  owned: OwnedChat;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
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
  return {
    ok: true,
    sim: {
      owned,
      branchId: authority.simBranchId,
      playerActorId: authority.simPlayerActorId,
      primaryActorId: authority.simPrimaryActorId,
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
