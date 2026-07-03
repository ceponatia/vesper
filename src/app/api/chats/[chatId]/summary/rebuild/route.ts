import { HEAVY_WRITE_RATE_LIMIT, jsonError, jsonOk, rateLimit, withUser } from "@/server/api";
import { rebuildChatSummary } from "@/server/engine";
import { loadOwnedChat } from "../../../owned";

type Params = { chatId: string };

/**
 * Rebuild the rolling summary from the full transcript (character-chat-standalone.spec.md
 * §7.3) — the recovery lever for folded-then-deleted lines. Runs inline (a handful of
 * fold calls under the per-chat summary lock); heavy-write rate limited since each fold
 * is a model call.
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (!rateLimit(`chat_summary_rebuild:${user.id}`, HEAVY_WRITE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many rebuilds; try again in a minute", 429);
  }
  const result = await rebuildChatSummary(chatId);
  return jsonOk(result);
});
