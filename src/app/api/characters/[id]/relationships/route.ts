import type { NextRequest } from "next/server";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { authoredRelationshipRecordSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterRelationships, characters, db } from "@/server/db";

type Params = { id: string };

/**
 * Library-level default relationship edges (relationship-model.plan.md, owner
 * ruling 2026-07-07): the character editor's Relationships tab. Edges are
 * directed FROM this character toward other library characters; conversation
 * creation seeds its matrix from these for every roster pair. PUT is
 * replace-set: the sent list becomes the character's outgoing edges.
 */

const putBodySchema = z.object({
  edges: z
    .array(
      z.object({
        toCharacterId: z.string().min(1),
        record: authoredRelationshipRecordSchema,
      }),
    )
    .max(24),
});

async function ownedCharacter(id: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, ownerId)))
    .limit(1);
  return Boolean(row);
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await ownedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  const rows = await db()
    .select({
      toCharacterId: characterRelationships.toCharacterId,
      toName: characters.name,
      record: characterRelationships.record,
    })
    .from(characterRelationships)
    .innerJoin(characters, eq(characters.id, characterRelationships.toCharacterId))
    .where(eq(characterRelationships.fromCharacterId, id));
  return jsonOk({
    edges: rows.map((row) => ({
      toCharacterId: row.toCharacterId,
      toName: row.toName,
      record: parseOr(
        authoredRelationshipRecordSchema,
        row.record,
        authoredRelationshipRecordSchema.parse({}),
        undefined,
        "character_relationships.record",
      ),
    })),
  });
});

export const PUT = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  if (!(await ownedCharacter(id, user.id))) return jsonError("not_found", "character not found", 404);
  const body = await readBody(req, putBodySchema);
  if (!body.ok) return body.response;

  const targetIds = [...new Set(body.value.edges.map((e) => e.toCharacterId))];
  if (targetIds.some((t) => t === id)) return jsonError("invalid_edge", "a character can't relate to themself", 400);
  if (targetIds.length !== body.value.edges.length) {
    return jsonError("invalid_edge", "one edge per target character", 400);
  }
  if (targetIds.length) {
    const owned = await db()
      .select({ id: characters.id })
      .from(characters)
      .where(and(inArray(characters.id, targetIds), eq(characters.ownerId, user.id)));
    if (owned.length !== targetIds.length) return jsonError("not_found", "target character not found", 404);
  }

  // Replace-set: drop edges no longer listed, upsert the rest.
  await db()
    .delete(characterRelationships)
    .where(
      targetIds.length
        ? and(eq(characterRelationships.fromCharacterId, id), notInArray(characterRelationships.toCharacterId, targetIds))
        : eq(characterRelationships.fromCharacterId, id),
    );
  for (const edge of body.value.edges) {
    await db()
      .insert(characterRelationships)
      .values({ fromCharacterId: id, toCharacterId: edge.toCharacterId, record: edge.record, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [characterRelationships.fromCharacterId, characterRelationships.toCharacterId],
        set: { record: edge.record, updatedAt: new Date() },
      });
  }
  return jsonOk({ saved: body.value.edges.length });
});
