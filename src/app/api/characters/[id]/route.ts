import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { characterProfileSchema, emptyCharacterProfile } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db, images } from "@/server/db";
import {
  characterPatchSchema,
  deleteEntityImages,
  findViewable,
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
  // Owner-or-public read (the browse/preview/copy path); private non-owned ⇒ 404.
  const row = await findViewable("character", id, user.id);
  if (!row) return jsonError("not_found", "character not found", 404);
  // Portraits scope to the entity owner so a public preview shows the author's art.
  const portraits = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, row.ownerId), eq(images.entityKind, "character"), eq(images.entityId, id)))
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
  if (body.value.visibility !== undefined) update.visibility = body.value.visibility;
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
  // Worlds/sessions hold their own snapshots (world-instances.plan.md), so a
  // library delete never breaks them and never hits a FK — no in-use guard.
  await db().delete(characters).where(and(eq(characters.id, id), eq(characters.ownerId, user.id)));
  void deleteEntityImages("character", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
