import { and, eq } from "drizzle-orm";
import { characterChats, characters, chatParticipants, db } from "@/server/db";

/**
 * Resolve a conversation the user owns, with its (v1 single) participant and the
 * participant's character row slice — the one indexed lookup every /api/chats/[chatId]
 * route runs before doing anything (ownership lives on the chat row;
 * character-chat-standalone.spec.md §1.2).
 */
export interface OwnedChat {
  chat: { id: string; ownerId: string; title: string; archivedAt: Date | null; lastMessageAt: Date };
  participant: { characterId: string; memoryGroupId: string };
  character: { id: string; name: string; profile: unknown; avatarImageId: string | null };
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
    })
    .from(characterChats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, characterChats.id))
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, userId)))
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
    character: { id: row.characterId, name: row.characterName, profile: row.profile, avatarImageId: row.avatarImageId },
  };
}
