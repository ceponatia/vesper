import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  authoredRecordToLive,
  authoredRelationshipRecordSchema,
  characterProfileSchema,
  emptyCharacterProfile,
  relationshipTextureSchema,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characterChatState, db } from "@/server/db";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { editChatState, loadChatRelationships, upsertChatRelationship } from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The conversation's relationship matrix. GET returns every stored NPC↔NPC
 * directed edge, the roster, AND each member's player edge (their state row's record) —
 * the matrix menu's full grid including the "them → you" column. PUT upserts
 * authored NPC↔NPC edges and/or player edges (band picks + texture → live
 * scalars at band midpoints; player edges write through `editChatState`, so
 * they are refused mid-stream like every state mutation).
 */

const putBodySchema = z
  .object({
    edges: z
      .array(
        z.object({
          fromCharacterId: z.string().min(1),
          toCharacterId: z.string().min(1),
          record: authoredRelationshipRecordSchema,
        }),
      )
      .max(24)
      .default([]),
    /** "Them → you" rows: one per roster character. */
    playerEdges: z
      .array(z.object({ characterId: z.string().min(1), record: authoredRelationshipRecordSchema }))
      .max(4)
      .default([]),
  })
  .refine((b) => b.edges.length + b.playerEdges.length > 0, { message: "nothing to save" });

/** Each member's live player edge off their state row (defaults for rowless members). */
async function loadPlayerEdges(owned: OwnedChat) {
  const rows = await db()
    .select({
      characterId: characterChatState.characterId,
      regard: characterChatState.regard,
      familiarity: characterChatState.familiarity,
      relationship: characterChatState.relationshipRecord,
    })
    .from(characterChatState)
    .where(eq(characterChatState.chatId, owned.chat.id));
  const byId = new Map(rows.map((r) => [r.characterId, r]));
  return owned.roster.map((m) => {
    const row = byId.get(m.characterId);
    const texture = parseOr(
      relationshipTextureSchema,
      row?.relationship ?? {},
      relationshipTextureSchema.parse({}),
      undefined,
      "character_chat_state.relationship_record",
    );
    return {
      characterId: m.characterId,
      record: { familiarity: row?.familiarity ?? 0, regard: row?.regard ?? 0, ...texture },
    };
  });
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const edges = await loadChatRelationships(chatId);
  return jsonOk({
    edges,
    playerEdges: await loadPlayerEdges(owned),
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
  for (const edge of body.value.playerEdges) {
    if (!rosterIds.has(edge.characterId)) {
      return jsonError("not_found", "that character is not in this conversation", 404);
    }
  }
  // Player edges rewrite state rows — refuse mid-stream (the finalizer's
  // full-column save would clobber them); pure matrix edges are stream-safe.
  if (body.value.playerEdges.length) {
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;
  }

  for (const edge of body.value.edges) {
    await upsertChatRelationship(chatId, edge.fromCharacterId, edge.toCharacterId, authoredRecordToLive(edge.record));
  }
  for (const edge of body.value.playerEdges) {
    const member = owned.roster.find((m) => m.characterId === edge.characterId);
    if (!member) continue;
    const profile = parseOr(
      characterProfileSchema,
      member.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const live = authoredRecordToLive(edge.record);
    await editChatState({
      chatId,
      characterId: edge.characterId,
      ownerId: user.id,
      profile,
      patch: {
        regard: live.regard,
        familiarity: live.familiarity,
        relationship: { kind: live.kind, history: live.history, presented: live.presented, looming: live.looming },
      },
    });
  }
  return jsonOk({ edges: await loadChatRelationships(chatId), playerEdges: await loadPlayerEdges(owned) });
});
