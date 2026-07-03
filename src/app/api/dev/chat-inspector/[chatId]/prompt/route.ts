import { jsonError, jsonOk, withUser } from "@/server/api";
import { previewChatPrompt } from "@/server/engine";
import { loadOwnedChat } from "../../../../chats/owned";

type Params = { chatId: string };

/**
 * "What reaches the narrator now" (character-chat-standalone.spec.md §5 dev
 * affordance + §6.1): rebuild the exact prompt a next exchange would send —
 * stored state (read-only drift), rolling summary, persona, live RAG recall —
 * without touching state, history, or the exchange lock. Dev-only: **404 in
 * production**, ownership-resolved like every /api/chats route.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  if (process.env.NODE_ENV === "production") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  return jsonOk(
    await previewChatPrompt({
      chatId,
      memoryGroupId: owned.participant.memoryGroupId,
      character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    }),
  );
});
