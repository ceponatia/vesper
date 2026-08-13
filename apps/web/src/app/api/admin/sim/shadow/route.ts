import { desc, eq, inArray, sql } from "drizzle-orm";
import { jsonOk, withOwnerAdmin } from "@/server/api";
import { characterChats, characters, chatParticipants, db, simShadowDivergences } from "@/server/db";

/**
 * Self-scoped shadow-parity index. It enumerates only the administrator's own
 * chats and keeps the result bounded; cross-account or unrestricted search is
 * deliberately absent.
 */
const PAGE_LIMIT = 50;

export const GET = withOwnerAdmin(async (user) => {
  const grouped = await db()
    .select({
      chatId: simShadowDivergences.chatId,
      title: characterChats.title,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${simShadowDivergences.verdict} = 'open')::int`,
      lastAt: sql<string>`max(${simShadowDivergences.createdAt})`,
    })
    .from(simShadowDivergences)
    .innerJoin(characterChats, eq(characterChats.id, simShadowDivergences.chatId))
    .where(eq(characterChats.ownerId, user.id))
    .groupBy(simShadowDivergences.chatId, characterChats.title)
    .orderBy(desc(sql`max(${simShadowDivergences.createdAt})`))
    .limit(PAGE_LIMIT);
  if (grouped.length === 0) return jsonOk({ chats: [] });

  const chatIds = grouped.map((row) => row.chatId);
  const primaryRows = await db()
    .select({ chatId: chatParticipants.chatId, sort: chatParticipants.sort, name: characters.name })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(inArray(chatParticipants.chatId, chatIds));
  const primaryName = new Map<string, string>();
  for (const row of primaryRows.sort((a, b) => b.sort - a.sort)) primaryName.set(row.chatId, row.name);

  return jsonOk({
    chats: grouped.map((row) => ({
      chatId: row.chatId,
      title: row.title,
      characterName: primaryName.get(row.chatId) ?? "",
      total: row.total,
      open: row.open,
      lastAt: row.lastAt,
    })),
  });
});
