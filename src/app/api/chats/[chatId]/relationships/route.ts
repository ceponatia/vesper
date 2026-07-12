import type { NextRequest } from "next/server";
import { z } from "zod";
import { authoredRecordToLive, authoredRelationshipRecordSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { loadChatRelationships, upsertChatRelationship } from "@/server/engine";
import { loadOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The conversation's NPC↔NPC relationship matrix (relationship-model.plan.md
 * §The matrix). GET returns every stored directed edge plus the roster (the
 * matrix menu's data); PUT upserts authored edges (band picks + texture →
 * live scalars at band midpoints). The character→player edge lives on the
 * state row and is edited through the existing state PATH — the player column
 * of the matrix menu writes there, not here.
 */

const putBodySchema = z.object({
  edges: z
    .array(
      z.object({
        fromCharacterId: z.string().min(1),
        toCharacterId: z.string().min(1),
        record: authoredRelationshipRecordSchema,
      }),
    )
    .min(1)
    .max(24),
});

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const edges = await loadChatRelationships(chatId);
  return jsonOk({
    edges,
    roster: owned.roster.map((m) => ({ characterId: m.characterId, name: m.character.name, sort: m.sort })),
  });
});

export const PUT = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  if (owned.chat.archivedAt) return jsonError("chat_archived", "restore this conversation to edit relationships", 409);
  const body = await readBody(req, putBodySchema);
  if (!body.ok) return body.response;

  const rosterIds = new Set(owned.roster.map((m) => m.characterId));
  for (const edge of body.value.edges) {
    if (edge.fromCharacterId === edge.toCharacterId) {
      return jsonError("invalid_edge", "an edge needs two different characters", 400);
    }
    if (!rosterIds.has(edge.fromCharacterId) || !rosterIds.has(edge.toCharacterId)) {
      return jsonError("not_found", "both edge characters must be in this conversation", 404);
    }
  }
  for (const edge of body.value.edges) {
    await upsertChatRelationship(chatId, edge.fromCharacterId, edge.toCharacterId, authoredRecordToLive(edge.record));
  }
  return jsonOk({ edges: await loadChatRelationships(chatId) });
});
