import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/server/api";
import { db, episodes } from "@/server/db";
import { serializeEpisodeRow, tryEmbed } from "../../../shared";
import { withSelfOwnedChat } from "../../../owned";

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

/** Edit one episode inside an owner-admin's own chat memory group. */
export const PATCH = withSelfOwnedChat<Params>(async (_user, owned, req, ctx) => {
  const { episodeId } = await ctx.params;
  const body = await readBody(req, patchBodySchema);
  if (!body.ok) return body.response;

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

/** Hard-delete one episode inside an owner-admin's own chat memory group. */
export const DELETE = withSelfOwnedChat<Params>(async (_user, owned, _req, ctx) => {
  const { episodeId } = await ctx.params;
  const [deleted] = await db()
    .delete(episodes)
    .where(and(eq(episodes.id, episodeId), eq(episodes.chatMemoryGroupId, owned.participant.memoryGroupId)))
    .returning({ id: episodes.id });
  if (!deleted) return jsonError("not_found", "episode not found", 404);
  return jsonOk({ deleted: true });
});
