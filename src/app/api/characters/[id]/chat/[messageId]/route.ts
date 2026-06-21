import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";

type Params = { id: string; messageId: string };

/**
 * Per-message edits on the sessionless character-chat transcript
 * (docs/developer-notes/character-chat.plan.md). PATCH overwrites one message's
 * text in place; DELETE removes a single message. Both are the recovery levers
 * for a "poisoned" transcript: the flat window is the model's only memory, so a
 * single refusal persisted into the history primes more refusals on every later
 * turn — snipping or rewriting the offending line restores the conversation
 * without nuking it (the whole-conversation DELETE lives on the parent route).
 * Every mutation is scoped by ownerId + characterId, so a user can only ever
 * touch their own rows; a miss is a 404, never a silent no-op.
 */

const editBodySchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

/** PATCH /api/characters/:id/chat/:messageId — overwrite one message's text. */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id, messageId } = await ctx.params;
  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;

  const [updated] = await db()
    .update(characterChatMessages)
    .set({ content: body.value.content })
    .where(
      and(
        eq(characterChatMessages.id, messageId),
        eq(characterChatMessages.ownerId, user.id),
        eq(characterChatMessages.characterId, id),
      ),
    )
    .returning({ id: characterChatMessages.id });

  if (!updated) return jsonError("not_found", "message not found", 404);
  return jsonOk({ id: updated.id });
});

/** DELETE /api/characters/:id/chat/:messageId — remove a single message. */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id, messageId } = await ctx.params;

  const [deleted] = await db()
    .delete(characterChatMessages)
    .where(
      and(
        eq(characterChatMessages.id, messageId),
        eq(characterChatMessages.ownerId, user.id),
        eq(characterChatMessages.characterId, id),
      ),
    )
    .returning({ id: characterChatMessages.id });

  if (!deleted) return jsonError("not_found", "message not found", 404);
  return jsonOk({ deleted: true });
});
