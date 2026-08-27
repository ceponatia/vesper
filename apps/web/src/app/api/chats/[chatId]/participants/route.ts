import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characters, chatParticipants, db } from "@/server/db";
import { seedChatRelationships } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, resolveChatMemoryGroupId } from "../../owned";

type Params = { chatId: string };

/** Mirrors POST /api/chats' MAX_CHAT_PARTICIPANTS: 2–4 characters typical, cap 4. */
const MAX_CHAT_PARTICIPANTS = 4;

const addBodySchema = z.object({
  characterId: z.string().min(1),
  /** D7 memory choice for the joiner; defaults to the relationship-remembers reuse. */
  memory: z.enum(["shared", "fresh"]).default("shared"),
});

/**
 * POST /api/chats/:chatId/participants — add a character to the roster. The
 * joiner gets its own `chat_participants` row (next sort) with the D7
 * memory-group resolution, and its `character_chat_state` row seeds lazily from
 * its authored defaults on first load — same as a fresh 1-on-1. Refused
 * mid-stream (`chat_busy`), over the cap, on an archived chat, and for an
 * already-present member.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) return jsonError("chat_archived", "restore this conversation to change its roster", 409);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const body = await readBody(req, addBodySchema);
  if (!body.ok) return body.response;
  if (owned.roster.length >= MAX_CHAT_PARTICIPANTS) {
    return jsonError("roster_full", `a conversation holds at most ${MAX_CHAT_PARTICIPANTS} characters`, 409);
  }
  if (owned.roster.some((m) => m.characterId === body.value.characterId)) {
    return jsonError("already_member", "that character is already in this conversation", 409);
  }

  const [character] = await db()
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(eq(characters.id, body.value.characterId), eq(characters.ownerId, user.id)))
    .limit(1);
  if (!character) return jsonError("not_found", "character not found", 404);

  const memoryGroupId = await resolveChatMemoryGroupId(user.id, character.id, body.value.memory, newId());
  const sort = Math.max(...owned.roster.map((m) => m.sort)) + 1;
  await db().insert(chatParticipants).values({ chatId, characterId: character.id, memoryGroupId, sort });
  // The joiner's pairs inherit library-default edges (existing rows kept).
  await seedChatRelationships(chatId, [...owned.roster.map((m) => m.characterId), character.id]);
  return jsonOk({ characterId: character.id, memoryGroupId, sort }, 201);
});
