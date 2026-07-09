import type { NextRequest } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { embedText, toVectorLiteral, type Embedded } from "@/server/ai";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, episodes } from "@/server/db";
import { loadOwnedChat } from "../../../../../chats/owned";

type Params = { chatId: string };

/**
 * Retrieval-quality probe (character-chat-standalone.spec.md §6.1): score every
 * embedded episode in this chat's memory group against an arbitrary test query —
 * the same cosine (`1 - (embedding <=> vec)`) and embedder-isolation filter the
 * live retrieval uses, but with no window cutoff, no floor, and no limit, so the
 * dev can see exactly where each episode lands. An embed failure degrades to
 * `{ scores: [], degraded: true }`, never an error (docs/resilience.md).
 * Admin-only: **404 for non-admin roles**.
 */
export const GET = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId } = await ctx.params;
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return jsonError("invalid_query", "q is required", 400);
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

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
