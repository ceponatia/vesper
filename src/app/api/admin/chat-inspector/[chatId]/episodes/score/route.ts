import { and, eq, isNotNull, sql } from "drizzle-orm";
import { embedText, toVectorLiteral, type Embedded } from "@/server/ai";
import { jsonError, jsonOk } from "@/server/api";
import { db, episodes } from "@/server/db";
import { withSelfOwnedChat } from "../../../owned";

type Params = { chatId: string };

/** Score episodes only inside an owner-admin's own chat memory group. */
export const GET = withSelfOwnedChat<Params>(async (_user, owned, req) => {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return jsonError("invalid_query", "q is required", 400);

  let embedded: Embedded;
  try {
    embedded = await embedText(q);
  } catch {
    return jsonOk({ scores: [], degraded: true });
  }

  const vec = toVectorLiteral(embedded.vector);
  const scores = await db()
    .select({
      id: episodes.id,
      score: sql<number>`1 - (${episodes.embedding} <=> ${vec}::vector)`,
    })
    .from(episodes)
    .where(
      and(
        eq(episodes.chatMemoryGroupId, owned.participant.memoryGroupId),
        eq(episodes.embedder, embedded.embedder),
        isNotNull(episodes.embedding),
      ),
    )
    .orderBy(sql`${episodes.embedding} <=> ${vec}::vector`);

  return jsonOk({ scores, degraded: false });
});
