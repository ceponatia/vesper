import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { deleteMessage, editMessage } from "@/server/engine";
import { engineErrorStatus } from "../../../_shared/sse";

type Params = { id: string; messageId: string };

const editBodySchema = z.object({
  content: z.string().trim().min(1).max(20_000),
});

/** PATCH — edit a message; narration edits queue a reconcile job (docs/turn-engine.md §Edit / rerun). */
export const PATCH = withUser<Params>(async (user, req, ctx) => {
  const { id, messageId } = await ctx.params;
  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;
  const result = await editMessage({ sessionId: id, userId: user.id, messageId, content: body.value.content });
  if (!result.ok) return jsonError(result.code, result.message, engineErrorStatus(result.code));
  return jsonOk({ ok: true });
});

/** DELETE — remove a message; an emptied turn is removed entirely. */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id, messageId } = await ctx.params;
  const result = await deleteMessage({ sessionId: id, userId: user.id, messageId });
  if (!result.ok) return jsonError(result.code, result.message, engineErrorStatus(result.code));
  return jsonOk({ ok: true });
});
