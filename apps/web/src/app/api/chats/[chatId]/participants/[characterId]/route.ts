import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { chatParticipants, db } from "@/server/db";
import { editChatState } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat } from "../../../owned";

type Params = { chatId: string; characterId: string };

const patchBodySchema = z.object({
  /** The roster panel's manual presence override (multi-character-chat.plan.md). */
  presence: z.enum(["present", "away"]),
});

/**
 * PATCH /api/chats/:chatId/participants/:characterId — flip a roster member's
 * narrative presence (present ⇄ away). Goes through the author-edit state path,
 * so a member with no state row yet seeds properly from their authored defaults
 * first. Refused mid-stream — the finalizer's full-column save would clobber it.
 */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) return jsonError("chat_archived", "restore this conversation to change its roster", 409);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const member = owned.roster.find((m) => m.characterId === characterId);
  if (!member) return jsonError("not_found", "that character is not in this conversation", 404);
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

  const profile = parseOr(
    characterProfileSchema,
    member.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
  const { state } = await editChatState({
    chatId,
    characterId,
    ownerId: user.id,
    profile,
    patch: { presence: body.value.presence },
  });
  return jsonOk({ characterId, presence: state.presence });
});

/**
 * DELETE /api/chats/:chatId/participants/:characterId — remove a roster member
 * (multi-character-chat.plan.md slice 1). The last member can't leave (a
 * conversation always has a character); removing the primary promotes the next
 * member by re-numbering sorts 0..n-1, so the Chats list (which joins sort 0)
 * never loses the row. The member's state row and memory stay — re-adding the
 * character resumes where they left off; Clear Chat / deleteChat remain the
 * destructive levers.
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { chatId, characterId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) return jsonError("chat_archived", "restore this conversation to change its roster", 409);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  if (!owned.roster.some((m) => m.characterId === characterId)) {
    return jsonError("not_found", "that character is not in this conversation", 404);
  }
  if (owned.roster.length === 1) {
    return jsonError("last_member", "a conversation needs at least one character — delete the chat instead", 409);
  }

  const remaining = owned.roster.filter((m) => m.characterId !== characterId);
  await db().transaction(async (tx) => {
    await tx
      .delete(chatParticipants)
      .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.characterId, characterId)));
    // Close sort gaps so sort 0 always exists (the list join + primary resolution).
    for (const [sort, member] of remaining.entries()) {
      if (member.sort !== sort) {
        await tx
          .update(chatParticipants)
          .set({ sort })
          .where(and(eq(chatParticipants.chatId, chatId), eq(chatParticipants.characterId, member.characterId)));
      }
    }
  });
  return jsonOk({ removed: characterId });
});
