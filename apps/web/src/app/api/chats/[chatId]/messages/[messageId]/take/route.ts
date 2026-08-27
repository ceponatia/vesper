import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { switchReplyTake } from "@/server/engine";
import { loadOwnedChat } from "../../../../owned";

type Params = { chatId: string; messageId: string };

const bodySchema = z.object({ takeId: z.string().min(1) });

/**
 * PATCH /api/chats/:chatId/messages/:messageId/take — make one recorded take the
 * displayed reply. Display-only: the row's `content` mirrors the pick;
 * state/memory keep reflecting the last GENERATED take (regenerate to re-run
 * effects).
 */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId, messageId } = await ctx.params;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  if (!(await loadOwnedChat(chatId, user.id))) return jsonError("not_found", "chat not found", 404);

  const content = await switchReplyTake(chatId, messageId, body.value.takeId);
  if (content === null) return jsonError("not_found", "take not found", 404);
  return jsonOk({ content });
});
