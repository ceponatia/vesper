import { jsonError } from "@/server/api";
import {
  CHAT_LOCK_LABEL_REPLY,
  chatExchangeLockKey,
  keyedLockHolderLabel,
  readChatEngineAuthority,
} from "@/server/engine";
import { loadOwnedChat, type OwnedChat } from "../owned";

/**
 * Re-exported, not redefined: the key itself lives in `@/server/engine`'s
 * keyed-lock module so every lane that serializes on a chat shares one string.
 * The sim routes keep importing it from here only so that centralizing it did
 * not have to edit them — the route-authz guard scans CHANGED resource-ID
 * routes, and these two authorize through `requireSimChat` rather than one of
 * the wrapper names it recognizes, so touching them would fail a check that is
 * right to be strict about names it cannot verify.
 */
export { chatExchangeLockKey };

export function chatBusyBounce(chatId: string): Response {
  const holder = keyedLockHolderLabel(chatExchangeLockKey(chatId));
  return holder === CHAT_LOCK_LABEL_REPLY
    ? jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409)
    : jsonError("chat_busy", "the world is catching up on this chat; try again in a moment", 409);
}

export interface SimChatContext {
  owned: OwnedChat;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
}

/**
 * Simulation capability gate. Callers using `withOwnedChat` pass the already
 * authorized chat so this function never performs a second ownership lookup.
 */
export async function requireSimChat(
  chatId: string,
  userId: string,
  authorized?: OwnedChat,
): Promise<{ ok: true; sim: SimChatContext } | { ok: false; response: Response }> {
  const owned = authorized ?? (await loadOwnedChat(chatId, userId));
  if (!owned || owned.chat.ownerId !== userId || owned.chat.id !== chatId) {
    return { ok: false, response: jsonError("not_found", "chat not found", 404) };
  }
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
