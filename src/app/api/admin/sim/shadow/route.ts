import { desc, eq, inArray, sql } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { characterChats, characters, chatParticipants, db, simShadowDivergences } from "@/server/db";

/**
 * R4 (engine.rollout.plan.md) — the shadow-parity index: every chat that has
 * recorded divergence rows, with open/total counts and the primary character's
 * name, newest activity first. The admin Shadow Parity screen's front page;
 * 404-hidden for non-admins like the rest of the sim family.
 */
export const GET = withUser(async (user) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const grouped = await db()
    .select({
      chatId: simShadowDivergences.chatId,
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${simShadowDivergences.verdict} = 'open')::int`,
      lastAt: sql<string>`max(${simShadowDivergences.createdAt})`,
    })
    .from(simShadowDivergences)
    .groupBy(simShadowDivergences.chatId)
    .orderBy(desc(sql`max(${simShadowDivergences.createdAt})`))
    .limit(100);
  if (grouped.length === 0) return jsonOk({ chats: [] });

  const chatIds = grouped.map((row) => row.chatId);
  const chatRows = await db()
    .select({ id: characterChats.id, title: characterChats.title })
    .from(characterChats)
    .where(inArray(characterChats.id, chatIds));
  const titles = new Map(chatRows.map((row) => [row.id, row.title]));
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
      title: titles.get(row.chatId) ?? "",
      characterName: primaryName.get(row.chatId) ?? "",
      total: row.total,
      open: row.open,
      lastAt: row.lastAt,
    })),
  });
});
