import { jsonError, jsonOk, withUser } from "@/server/api";
import { stopChatReply } from "@/server/engine";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * POST /api/chats/:chatId/stop — cut the in-flight reply short
 * (character-chat-standalone.spec.md §4.2). Inference upstream can't be
 * interrupted retroactively, but the stream aborts server-side: whatever already
 * streamed persists as the reply (`meta.stopped`) and the fan-out runs over the
 * truncated text. 404 when nothing is streaming (a settle raced the click).
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  if (!(await loadOwnedChat(chatId, user.id))) return jsonError("not_found", "chat not found", 404);
  if (!stopChatReply(chatId)) return jsonError("not_found", "no reply is streaming for this chat", 404);
  return jsonOk({ stopped: true });
});
