import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db, images } from "@/server/db";
import {
  characterPatchSchema,
  deleteEntityImages,
  isForeignKeyViolation,
  jsonError,
  jsonOk,
  queueEmbedRefresh,
  readBody,
  withUser,
} from "@/server/api";

type Params = { id: string };

async function findCharacter(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row;
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findCharacter(user.id, id);
  if (!row) return jsonError("not_found", "character not found", 404);
  const portraits = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, user.id), eq(images.entityKind, "character"), eq(images.entityId, id)))
    .orderBy(desc(images.createdAt));
  return jsonOk({ character: row, portraits });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, characterPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findCharacter(user.id, id);
  if (!existing) return jsonError("not_found", "character not found", 404);

  const update: Partial<typeof characters.$inferInsert> = {};
  if (body.value.name !== undefined) update.name = body.value.name;
  if (body.value.tags !== undefined) update.tags = body.value.tags;
  if (body.value.profile !== undefined) {
    const current = parseOr(characterProfileSchema, existing.profile, emptyCharacterProfile(), undefined, "characters.profile");
    update.profile = { ...current, ...body.value.profile };
  }
  if (Object.keys(update).length === 0) return jsonOk({ character: existing });

  const [row] = await db()
    .update(characters)
    .set(update)
    .where(and(eq(characters.id, id), eq(characters.ownerId, user.id)))
    .returning();
  if (!row) return jsonError("not_found", "character not found", 404);
  queueEmbedRefresh("character", id);
  return jsonOk({ character: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findCharacter(user.id, id);
  if (!existing) return jsonError("not_found", "character not found", 404);
  try {
    await db().delete(characters).where(and(eq(characters.id, id), eq(characters.ownerId, user.id)));
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return jsonError("in_use", "character is used by a world or session", 409);
    }
    throw err;
  }
  void deleteEntityImages("character", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
