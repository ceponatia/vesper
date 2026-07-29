import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CHAT_CAPABILITY_UNAVAILABLE_CODE } from "@/contracts";
import { jsonError, jsonOk, MESSAGE_CONTENT_MAX, readBody, withUser } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";
import {
  isSimRoutedAuthority,
  readChatEngineAuthority,
  reconcileMessageMemory,
  reextractEditedReply,
} from "@/server/engine";
import { deleteOwnedChatUploads } from "@/server/images";
import { resolveChatPersona } from "@/server/players";
import { loadOwnedChat } from "../../../owned";

type Params = { chatId: string; messageId: string };

/**
 * Per-message edits on a conversation transcript (docs/character-chat/api.md). PATCH
 * overwrites one message's text in place; DELETE removes a single message. Both are
 * the recovery levers for a "poisoned" transcript: a single refusal persisted into
 * the window primes more refusals on every later turn — snipping or rewriting the
 * offending line restores the conversation without nuking it (the whole-conversation
 * DELETE lives on the parent route). Since slice 5 (spec §4.3) both also reconcile
 * the memory extracted from an assistant line: delete retracts it; edit retracts and
 * re-extracts from the edited text (fire-and-forget, same resilience as the live
 * fan-out). Ownership resolves through the chat row; a miss is a 404, never a
 * silent no-op.
 */

const editBodySchema = z.object({
  // MESSAGE_CONTENT_MAX is an anti-abuse backstop, not a length policy — the
  // edit must accept any reply the model legitimately produced.
  content: z.string().trim().min(1).max(MESSAGE_CONTENT_MAX),
});

/** PATCH /api/chats/:chatId/messages/:messageId — overwrite one message's text. */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId, messageId } = await ctx.params;
  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
    return jsonError(
      CHAT_CAPABILITY_UNAVAILABLE_CODE,
      "World-engine chat history can't be edited because its transcript reflects committed world events.",
      409,
    );
  }

  const [updated] = await db()
    .update(characterChatMessages)
    .set({ content: body.value.content })
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .returning({ id: characterChatMessages.id, role: characterChatMessages.role });

  if (!updated) return jsonError("not_found", "message not found", 404);

  if (updated.role === "assistant") {
    const player = await resolveChatPersona({ ownerId: user.id, chatId });
    void reextractEditedReply({
      chatId,
      messageId,
      memoryGroupId: owned.participant.memoryGroupId,
      characterId: owned.participant.characterId,
      characterName: owned.character.name,
      playerName: player.name,
      content: body.value.content,
    });
  }
  return jsonOk({ id: updated.id });
});

/** DELETE /api/chats/:chatId/messages/:messageId — remove a single message. */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { chatId, messageId } = await ctx.params;
  if (!(await loadOwnedChat(chatId, user.id))) return jsonError("not_found", "chat not found", 404);
  if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
    return jsonError(
      CHAT_CAPABILITY_UNAVAILABLE_CODE,
      "World-engine chat history can't be deleted because its transcript reflects committed world events.",
      409,
    );
  }

  const [deleted] = await db()
    .delete(characterChatMessages)
    .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
    .returning({ id: characterChatMessages.id, role: characterChatMessages.role });

  if (!deleted) return jsonError("not_found", "message not found", 404);
  // A snipped assistant line takes its extracted memory with it (spec §4.3) —
  // fire-and-forget; a failure leaves stale memory, never a failed delete.
  if (deleted.role === "assistant") void reconcileMessageMemory(messageId);
  // A snipped user line takes its attached photos with it (chat-image-input.plan.md).
  // The owner id remains part of the helper predicate even after the chat gate above.
  if (deleted.role === "user") void deleteOwnedChatUploads(chatId, user.id, [messageId]);
  return jsonOk({ deleted: true });
});
