import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { parseOr } from "@/lib/parse";
import { db, items } from "@/server/db";
import {
  deleteEntityImages,
  emptyItemExtras,
  invalidCoverageIds,
  itemExtrasSchema,
  itemPatchSchema,
  jsonError,
  jsonOk,
  queueEmbedRefresh,
  readBody,
  withUser,
} from "@/server/api";

type Params = { id: string };

async function findItem(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.ownerId, ownerId)))
    .limit(1);
  return row;
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findItem(user.id, id);
  if (!row) return jsonError("not_found", "item not found", 404);
  return jsonOk({ item: row });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, itemPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findItem(user.id, id);
  if (!existing) return jsonError("not_found", "item not found", 404);

  const update: Partial<typeof items.$inferInsert> = {};
  if (body.value.name !== undefined) update.name = body.value.name;
  if (body.value.kind !== undefined) update.kind = body.value.kind;
  if (body.value.description !== undefined) update.description = body.value.description;
  if (body.value.tags !== undefined) update.tags = body.value.tags;
  if (body.value.definition !== undefined) {
    const current = parseOr(itemExtrasSchema, existing.definition, emptyItemExtras(), undefined, "items.definition");
    const merged = { ...current, ...body.value.definition };
    const invalid = invalidCoverageIds(merged.coverage);
    if (invalid.length > 0) {
      return jsonError("invalid_coverage", `unknown body locations: ${invalid.join(", ")}`, 400);
    }
    update.definition = merged;
  }
  if (Object.keys(update).length === 0) return jsonOk({ item: existing });

  const [row] = await db()
    .update(items)
    .set(update)
    .where(and(eq(items.id, id), eq(items.ownerId, user.id)))
    .returning();
  if (!row) return jsonError("not_found", "item not found", 404);
  queueEmbedRefresh("item", id);
  return jsonOk({ item: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findItem(user.id, id);
  if (!existing) return jsonError("not_found", "item not found", 404);
  // Worlds/sessions hold their own snapshots (world-instances.plan.md), so a
  // library delete never breaks them and never hits a FK — no in-use guard.
  await db().delete(items).where(and(eq(items.id, id), eq(items.ownerId, user.id)));
  void deleteEntityImages("item", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
