import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { runSimChatExchange } from "@/server/engine";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * R3 slice 1 (engine.rollout.plan.md) — the explicit successor turn route.
 * Thin over `runSimChatExchange` (the shared core the ordinary send path
 * also forks into for sim-routed chats); kept for headless/API play and the
 * int suites.
 */

const bodySchema = z.object({ message: z.string().trim().min(1).max(4_000) }).strict();

export const POST = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const result = await runSimChatExchange({
    chatId,
    userId: user.id,
    speakerCharacterId: owned.character.id,
    message: body.value.message,
  });
  if (!result.ok) return jsonError(result.code, result.message, result.status);
  const { ok, ...payload } = result;
  void ok;
  return jsonOk(payload);
});
