import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, locations } from "@/server/db";
import {
  deleteEntityImages,
  isForeignKeyViolation,
  jsonError,
  jsonOk,
  locationPatchSchema,
  queueEmbedRefresh,
  readBody,
  withUser,
} from "@/server/api";

type Params = { id: string };

async function findLocation(ownerId: string, id: string) {
  const [row] = await db()
    .select()
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.ownerId, ownerId)))
    .limit(1);
  return row;
}

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await findLocation(user.id, id);
  if (!row) return jsonError("not_found", "location not found", 404);
  return jsonOk({ location: row });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, locationPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findLocation(user.id, id);
  if (!existing) return jsonError("not_found", "location not found", 404);
  if (Object.keys(body.value).length === 0) return jsonOk({ location: existing });

  const [row] = await db()
    .update(locations)
    .set(body.value)
    .where(and(eq(locations.id, id), eq(locations.ownerId, user.id)))
    .returning();
  if (!row) return jsonError("not_found", "location not found", 404);
  queueEmbedRefresh("location", id);
  return jsonOk({ location: row });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findLocation(user.id, id);
  if (!existing) return jsonError("not_found", "location not found", 404);
  try {
    await db().delete(locations).where(and(eq(locations.id, id), eq(locations.ownerId, user.id)));
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return jsonError("in_use", "location is used by a world or session", 409);
    }
    throw err;
  }
  void deleteEntityImages("location", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
