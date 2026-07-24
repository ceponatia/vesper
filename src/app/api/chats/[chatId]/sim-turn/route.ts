import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { CHAT_LOCK_LABEL_REPLY, runSimChatExchange, tryKeyedLock } from "@/server/engine";
import { loadOwnedChat } from "../../owned";
import { chatBusyBounce, chatExchangeLockKey } from "../sim-shared";

type Params = { chatId: string };

/**
 * R3 slice 1 (engine.rollout.plan.md) — the explicit successor turn route.
 * Thin over `runSimChatExchange` (the shared core the ordinary send path
 * also forks into for sim-routed chats); kept for headless/API play and the
 * int suites.
 *
 * command-integrity A1 (slice 1): the turn holds the SAME per-chat
 * `chat_exchange` lock the reply lanes and sim-commands take — one exchange in
 * flight per conversation from any tab or headless caller. Contention bounces as
 * `chat_busy` (A1-1) rather than interleaving with a live reply or world command.
 */

const bodySchema = z.object({ message: z.string().trim().min(1).max(4_000) }).strict();

export const POST = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const held = tryKeyedLock(
    chatExchangeLockKey(chatId),
    async (): Promise<Response> => {
      const result = await runSimChatExchange({
        chatId,
        userId: user.id,
        speakerCharacterId: owned.character.id,
        speakerName: owned.character.name,
        message: body.value.message,
      });
      if (!result.ok) return jsonError(result.code, result.message, result.status);
      const { ok, ...payload } = result;
      void ok;
      return jsonOk(payload);
    },
    CHAT_LOCK_LABEL_REPLY,
  );
  if (held === null) return chatBusyBounce(chatId);
  return held;
});
