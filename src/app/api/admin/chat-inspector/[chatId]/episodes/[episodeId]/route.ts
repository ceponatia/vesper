import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, episodes } from "@/server/db";
import { loadOwnedChat } from "../../../../../chats/owned";
import { serializeEpisodeRow, tryEmbed } from "../../../shared";

type Params = { chatId: string; episodeId: string };

const patchBodySchema = z.object({
  summary: z.string().trim().min(1).max(4000),
});

const episodeReturning = {
  id: episodes.id,
  turnNumber: episodes.turnNumber,
  summary: episodes.summary,
  sourceMessageId: episodes.sourceMessageId,
  createdAt: episodes.createdAt,
} as const;

/**
 * Dev episode edit (character-chat-standalone.spec.md §6.1): overwrite one
 * episode's summary and re-embed it (an embed failure still saves the text but
 * nulls the vector — the row honestly leaves similarity retrieval, flagged
 * `embedDegraded`). Keyed on `(id, chat_memory_group_id)` so an episode outside
 * this chat's memory group is a 404, never touched. Admin-only: **404 for non-admin roles**.
 */
export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId, episodeId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const embed = await tryEmbed(body.value.summary);
  const [updated] = await db()
    .update(episodes)
    .set({ summary: body.value.summary, embedding: embed.vector, embedder: embed.embedder })
    .where(and(eq(episodes.id, episodeId), eq(episodes.chatMemoryGroupId, owned.participant.memoryGroupId)))
    .returning(episodeReturning);
  if (!updated) return jsonError("not_found", "episode not found", 404);

  return jsonOk({
    episode: serializeEpisodeRow({ ...updated, embedded: !embed.degraded }),
    embedDegraded: embed.degraded,
  });
});

/**
 * Dev episode delete (spec §6.1) — a hard delete, unlike fact retraction:
 * episodes carry no supersedence audit trail, and the inspector's use case is
 * pruning a bad summary outright. Scope-checked the same way as PATCH.
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { chatId, episodeId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const [deleted] = await db()
    .delete(episodes)
    .where(and(eq(episodes.id, episodeId), eq(episodes.chatMemoryGroupId, owned.participant.memoryGroupId)))
    .returning({ id: episodes.id });
  if (!deleted) return jsonError("not_found", "episode not found", 404);
  return jsonOk({ deleted: true });
});
