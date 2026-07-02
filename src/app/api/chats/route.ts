import type { NextRequest } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChats, characters, chatParticipants, db } from "@/server/db";
import { newId } from "@/lib/ids";

/**
 * The conversations collection (docs/character-chat.md; character-chat-standalone.spec.md
 * §2.1). GET lists the user's conversations (the Chats page / the editor tab's picker);
 * POST creates one — with the D7 memory choice: "shared" reuses the character's existing
 * memory group (the relationship remembers), "fresh" mints a clean island (an alternate
 * universe). One character can host many conversations.
 */

/** Cap on listed conversations (recency-ordered; nobody scrolls past this in v1). */
const LIST_LIMIT = 100;

const createBodySchema = z.object({
  characterId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  /** D7: continue the shared history, or a vanilla fresh start. */
  memory: z.enum(["shared", "fresh"]),
});

/** GET /api/chats?characterId=…&archived=1 — the user's conversations, newest first. */
export const GET = withUser(async (user, req: NextRequest) => {
  const url = new URL(req.url);
  const characterId = url.searchParams.get("characterId") ?? undefined;
  const archived = url.searchParams.get("archived") === "1";

  const rows = await db()
    .select({
      id: characterChats.id,
      title: characterChats.title,
      archivedAt: characterChats.archivedAt,
      lastMessageAt: characterChats.lastMessageAt,
      characterId: characters.id,
      characterName: characters.name,
      avatarImageId: characters.avatarImageId,
      lastLine: sql<string | null>`(
        select left(m.content, 160) from character_chat_messages m
        where m.chat_id = ${characterChats.id}
        order by m.created_at desc limit 1
      )`,
    })
    .from(characterChats)
    .innerJoin(chatParticipants, eq(chatParticipants.chatId, characterChats.id))
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(
      and(
        eq(characterChats.ownerId, user.id),
        archived ? sql`${characterChats.archivedAt} is not null` : isNull(characterChats.archivedAt),
        ...(characterId ? [eq(chatParticipants.characterId, characterId)] : []),
      ),
    )
    .orderBy(desc(characterChats.lastMessageAt))
    .limit(LIST_LIMIT);

  return jsonOk({ chats: rows });
});

/** POST /api/chats — create a conversation with the D7 memory choice. */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const { characterId, memory } = body.value;

  const [character] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!character) return jsonError("not_found", "character not found", 404);

  // "shared" reuses the character's existing group (any of the user's chats with this
  // character carries it); no prior chat — or "fresh" — mints a new island.
  let memoryGroupId = newId();
  if (memory === "shared") {
    const [existing] = await db()
      .select({ memoryGroupId: chatParticipants.memoryGroupId })
      .from(chatParticipants)
      .innerJoin(characterChats, eq(characterChats.id, chatParticipants.chatId))
      .where(and(eq(characterChats.ownerId, user.id), eq(chatParticipants.characterId, characterId)))
      .orderBy(desc(characterChats.createdAt))
      .limit(1);
    if (existing) memoryGroupId = existing.memoryGroupId;
  }

  const chatId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(characterChats).values({ id: chatId, ownerId: user.id, title: body.value.title ?? "" });
    await tx.insert(chatParticipants).values({ chatId, characterId, memoryGroupId, sort: 0 });
  });

  return jsonOk({ id: chatId, memoryGroupId }, 201);
});
