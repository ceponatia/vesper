import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { parseOr } from "@/lib/parse";
import { db, socialCards } from "@/server/db";
import {
  emptySocialCardExtras,
  findViewable,
  jsonError,
  jsonOk,
  queueEmbedRefresh,
  readBody,
  socialCardExtrasSchema,
  socialCardPatchSchema,
  toPublicSocialCard,
  withUser,
} from "@/server/api";

type Params = { id: string };

async function findCard(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(socialCards)
    .where(and(eq(socialCards.id, id), eq(socialCards.ownerId, ownerId)))
    .limit(1);
  return row;
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  // Owner-or-public read (the browse/preview/copy path); private non-owned ⇒ 404.
  const row = await findViewable("social_card", id, user.id);
  if (!row) return jsonError("not_found", "social card not found", 404);
  // `mine` tells the builder whether to offer edit/delete or a clone-to-library CTA.
  // A foreign viewer gets the allow-listed public representation, not the row.
  const mine = row.ownerId === user.id;
  return jsonOk({ socialCard: mine ? row : toPublicSocialCard(row), mine });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, socialCardPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findCard(user.id, id);
  if (!existing) return jsonError("not_found", "social card not found", 404);

  const update: Partial<typeof socialCards.$inferInsert> = {};
  if (body.value.name !== undefined) update.name = body.value.name;
  if (body.value.description !== undefined) update.description = body.value.description;
  if (body.value.tags !== undefined) update.tags = body.value.tags;
  if (body.value.visibility !== undefined) update.visibility = body.value.visibility;
  if (body.value.definition !== undefined) {
    const current = parseOr(socialCardExtrasSchema, existing.definition, emptySocialCardExtras(), undefined, "social_cards.definition");
    update.definition = { ...current, ...body.value.definition };
  }
  if (Object.keys(update).length === 0) return jsonOk({ socialCard: existing });

  const [row] = await db()
    .update(socialCards)
    .set(update)
    .where(and(eq(socialCards.id, id), eq(socialCards.ownerId, user.id)))
    .returning();
  if (!row) return jsonError("not_found", "social card not found", 404);
  queueEmbedRefresh("social_card", id);
  return jsonOk({ socialCard: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findCard(user.id, id);
  if (!existing) return jsonError("not_found", "social card not found", 404);
  // Worlds/characters hold their own inline snapshots, so a library delete never
  // breaks them and never hits a FK — no in-use guard.
  await db().delete(socialCards).where(and(eq(socialCards.id, id), eq(socialCards.ownerId, user.id)));
  return jsonOk({ ok: true });
});
