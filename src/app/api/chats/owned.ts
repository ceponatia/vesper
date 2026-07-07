import { and, asc, eq } from "drizzle-orm";
import { characterChats, characters, chatParticipants, db } from "@/server/db";
import { keyedLockBusy } from "@/server/engine";
import { jsonError } from "@/server/api";

/**
 * Resolve a conversation the user owns, with its PRIMARY participant (sort 0) and
 * that participant's character row slice — the one indexed lookup every
 * /api/chats/[chatId] route runs before doing anything (ownership lives on the chat
 * row; character-chat-standalone.spec.md §1.2). A conversation can now hold a
 * multi-character roster (multi-character-chat.plan.md — creation groundwork), but
 * the whole exchange pipeline is still 1-on-1 with the primary until the
 * multi-character substrate ships; extra participants are inert.
 */
export interface OwnedChat {
  chat: { id: string; ownerId: string; title: string; archivedAt: Date | null; lastMessageAt: Date };
  participant: { characterId: string; memoryGroupId: string };
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null; chatModel: string };
}

export async function loadOwnedChat(chatId: string, userId: string): Promise<OwnedChat | null> {
  const [row] = await db()
    .select({
      chatId: characterChats.id,
      ownerId: characterChats.ownerId,
      title: characterChats.title,
      archivedAt: characterChats.archivedAt,
      lastMessageAt: characterChats.lastMessageAt,
      memoryGroupId: chatParticipants.memoryGroupId,
      characterId: characters.id,
      characterName: characters.name,
      profile: characters.profile,
      avatarImageId: characters.avatarImageId,
      chatModel: characters.chatModel,
    })
    .from(characterChats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, characterChats.id))
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, userId)))
    .orderBy(asc(chatParticipants.sort))
    .limit(1);
  if (!row) return null;
  return {
    chat: {
      id: row.chatId,
      ownerId: row.ownerId,
      title: row.title,
      archivedAt: row.archivedAt,
      lastMessageAt: row.lastMessageAt,
    },
    participant: { characterId: row.characterId, memoryGroupId: row.memoryGroupId },
    character: {
      id: row.characterId,
      name: row.characterName,
      profile: row.profile,
      avatarImageId: row.avatarImageId,
      chatModel: row.chatModel,
    },
  };
}

/**
 * 409 while a reply is streaming for this chat (character-chat-standalone.followups
 * F1): the exchange holds the `chat_exchange:<id>` lock across the whole stream, and
 * its finalizer rewrites the full state-row column list from the pre-exchange
 * snapshot. So a state mutation that lands mid-stream — a time skip, a marked moment,
 * an author edit, an action chip — would be silently clobbered by the finalize save
 * (the skip note cleared unrendered, the clock reverted). The mutation routes call
 * this before touching the state row; `null` ⇒ clear to proceed. Matches the
 * exchange's own `chat_busy` code so the client handles both the same way.
 */
export function chatBusyResponse(chatId: string): ReturnType<typeof jsonError> | null {
  return keyedLockBusy(`chat_exchange:${chatId}`)
    ? jsonError("chat_busy", "a reply is still streaming; wait for it to finish before changing the scene", 409)
    : null;
}
