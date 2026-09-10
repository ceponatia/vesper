import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { CHAT_CAPABILITY_UNAVAILABLE_CODE } from "@/contracts";
import { jsonError, jsonOk, MESSAGE_CONTENT_MAX, readBody, withOwnedChat } from "@/server/api";
import { characterChatMessages, db } from "@/server/db";
import {
  CHAT_LOCK_LABEL_REPAIR,
  CHAT_PERMISSION_SOURCE_MESSAGE_IMMUTABLE,
  chatExchangeLockKey,
  chatMessageHasNpcPermissionAuthority,
  isSimRoutedAuthority,
  readChatEngineAuthority,
  repairChatContinuityAfterEdit,
  tryKeyedLock,
} from "@/server/engine";
import { deleteOwnedChatUploads } from "@/server/images";
import { resolveChatPersona } from "@/server/players";
import { chatBusyResponse, loadOwnedChat } from "../../../owned";

type Params = { chatId: string; messageId: string };
type OwnedChat = NonNullable<Awaited<ReturnType<typeof loadOwnedChat>>>;

const ownedChat = (user: { id: string }, params: Params) => loadOwnedChat(params.chatId, user.id);

/**
 * Per-message edits on a conversation transcript (docs/character-chat/api.md). PATCH
 * overwrites one message's text in place; DELETE removes a single message. Both are
 * the recovery levers for a "poisoned" transcript: a single refusal persisted into
 * the window primes more refusals on every later turn — snipping or rewriting the
 * offending line restores the conversation without nuking it (the whole-conversation
 * DELETE lives on the parent route). Ownership resolves through the chat row; a miss
 * is a 404, never a silent no-op.
 *
 * The transcript row is not the only place the old wording lives, so both verbs run
 * the continuity repair (`repairChatContinuityAfterEdit`) BEFORE answering: the
 * exchange the line belonged to has its extracted memory retracted and re-filed from
 * the current transcript, the rolling summary is re-folded when the line is at or
 * before its watermark, and any voice exemplar quoting the line is dropped from the
 * state rows. A player line counts here too — its wording reached memory through the
 * reply that answered it. All of it is awaited — a fire-and-forget repair lets an
 * immediate next send retrieve the wording the player just removed — and all of it
 * runs under the chat exchange lock, because the exchange finalizer rewrites the
 * state row's rings wholesale and would clobber a concurrent scrub. A chat that is already streaming (or already repairing) answers
 * 409 `chat_busy` with nothing written. The response carries a `continuity` block
 * reporting what each step did; a step that failed is reported there rather than
 * failing the write that already committed.
 *
 * Everything the repair needs from OTHER stores — the player persona the scribe
 * addresses — is resolved before the lock is taken and before the row is written, so
 * a persona-store failure answers with the transcript and its derivatives still
 * consistent instead of 500-ing over a committed write no leg ever repaired.
 */

const editBodySchema = z.object({
  // MESSAGE_CONTENT_MAX is an anti-abuse backstop, not a length policy — the
  // edit must accept any reply the model legitimately produced.
  content: z.string().trim().min(1).max(MESSAGE_CONTENT_MAX),
});

/**
 * The refusal when the exchange key could not be taken between the fast-path probe
 * and the acquire — the same `chat_busy` code and status the probe answers, so a
 * caller cannot tell (and need not care) which of the two bounced it. Both mean
 * "another writer owns this chat; nothing was written; try again". Precedent:
 * `overrideChatBusyResponse` on the permission override.
 */
const repairRaceBusyResponse = () =>
  jsonError("chat_busy", "a reply is still streaming for this chat; wait for it to finish", 409);

/**
 * What the continuity repair's memory leg needs, for BOTH roles: a player line's
 * wording reached memory through the reply that answered it, so an edited or
 * snipped user row re-files that reply just as an edited assistant row re-files
 * itself.
 *
 * The primary participant's group and character — the pre-existing 1-on-1 shape of
 * the memory anchor, unchanged here.
 */
async function repairMemoryContext(ownerId: string, chatId: string, owned: OwnedChat) {
  const player = await resolveChatPersona({ ownerId, chatId });
  return {
    memoryGroupId: owned.participant.memoryGroupId,
    characterId: owned.participant.characterId,
    characterName: owned.character.name,
    playerName: player.name,
  };
}

/** PATCH /api/chats/:chatId/messages/:messageId — overwrite one message's text. */
export const PATCH = withOwnedChat<Params, OwnedChat>(ownedChat, async (user, _owned, req: NextRequest, ctx) => {
  const { chatId, messageId } = await ctx.params;
  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;
  // Re-check immediately beside the write as well as at the route wrapper. The
  // mutation guardrail deliberately requires owner evidence in this handler's
  // own control flow; this also closes an ownership-change race between wrapper
  // resolution and mutation.
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
    return jsonError(
      CHAT_CAPABILITY_UNAVAILABLE_CODE,
      "World-engine chat history can't be edited because its transcript reflects committed world events.",
      409,
    );
  }
  if (await chatMessageHasNpcPermissionAuthority(chatId, messageId)) {
    return jsonError(
      CHAT_PERMISSION_SOURCE_MESSAGE_IMMUTABLE,
      "This reply contains an NPC permission decision. Transcript edits cannot rewrite NPC agency; use a state-aware retake instead.",
      409,
    );
  }
  // Both refusals above are checked before anything is taken or written.

  // Resolved HERE — outside the lock and ahead of the write — because this read hits
  // its own store: a failure after the update commits would 500 past the repair and
  // leave the summary, the memory and the voice ring quoting the old wording.
  const memory = await repairMemoryContext(user.id, chatId, owned);

  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const held = tryKeyedLock(
    chatExchangeLockKey(chatId),
    async () => {
      // The wording BEFORE the write: what the summary folded, the scribe filed,
      // and the voice ring may still quote.
      const [previous] = await db()
        .select({ content: characterChatMessages.content })
        .from(characterChatMessages)
        .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
        .limit(1);

      const [updated] = await db()
        .update(characterChatMessages)
        .set({ content: body.value.content })
        .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
        .returning({
          id: characterChatMessages.id,
          role: characterChatMessages.role,
          createdAt: characterChatMessages.createdAt,
        });
      if (!updated) return null;

      const continuity = await repairChatContinuityAfterEdit({
        chatId,
        operation: "edit",
        message: {
          id: updated.id,
          role: updated.role,
          createdAt: updated.createdAt,
          previousContent: previous?.content ?? "",
          content: body.value.content,
        },
        memory,
      });
      return { id: updated.id, continuity };
    },
    CHAT_LOCK_LABEL_REPAIR,
  );
  if (held === null) return repairRaceBusyResponse();
  const result = await held;
  if (!result) return jsonError("not_found", "message not found", 404);
  return jsonOk(result);
});

/** DELETE /api/chats/:chatId/messages/:messageId — remove a single message. */
export const DELETE = withOwnedChat<Params, OwnedChat>(ownedChat, async (user, _owned, _req, ctx) => {
  const { chatId, messageId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
    return jsonError(
      CHAT_CAPABILITY_UNAVAILABLE_CODE,
      "World-engine chat history can't be deleted because its transcript reflects committed world events.",
      409,
    );
  }
  if (await chatMessageHasNpcPermissionAuthority(chatId, messageId)) {
    return jsonError(
      CHAT_PERMISSION_SOURCE_MESSAGE_IMMUTABLE,
      "This reply contains an NPC permission decision. Transcript deletion cannot rewrite NPC agency; use a state-aware retake instead.",
      409,
    );
  }
  // Resolved before the lock and the delete, for the reason PATCH states above.
  const memory = await repairMemoryContext(user.id, chatId, owned);

  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const held = tryKeyedLock(
    chatExchangeLockKey(chatId),
    async () => {
      // The delete's own `returning()` carries everything the repair needs: the
      // snipped wording, the role, and the timestamp the watermark compares against.
      const [deleted] = await db()
        .delete(characterChatMessages)
        .where(and(eq(characterChatMessages.id, messageId), eq(characterChatMessages.chatId, chatId)))
        .returning({
          id: characterChatMessages.id,
          role: characterChatMessages.role,
          content: characterChatMessages.content,
          createdAt: characterChatMessages.createdAt,
        });
      if (!deleted) return null;

      // A snipped user line takes its attached photos with it.
      // The owner id remains part of the helper predicate even after the chat gate above.
      if (deleted.role === "user") void deleteOwnedChatUploads(chatId, user.id, [messageId]);

      const continuity = await repairChatContinuityAfterEdit({
        chatId,
        operation: "delete",
        message: {
          id: deleted.id,
          role: deleted.role,
          createdAt: deleted.createdAt,
          previousContent: deleted.content,
          content: null,
        },
        memory,
      });
      return { deleted: true as const, continuity };
    },
    CHAT_LOCK_LABEL_REPAIR,
  );
  if (held === null) return repairRaceBusyResponse();
  const result = await held;
  if (!result) return jsonError("not_found", "message not found", 404);
  return jsonOk(result);
});
