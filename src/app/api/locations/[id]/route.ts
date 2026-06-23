import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, locations } from "@/server/db";
import {
  deleteEntityImages,
  findViewable,
  jsonError,
  jsonOk,
  loadLocationLinks,
  locationPatchSchema,
  queueEmbedRefresh,
  readBody,
  setLocationLinks,
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
  // Owner-or-public read (the browse/preview/copy path); private non-owned ⇒ 404.
  const row = await findViewable("location", id, user.id);
  if (!row) return jsonError("not_found", "location not found", 404);
  // Links scope to the entity owner so a public preview shows the author's map.
  const links = await loadLocationLinks(row.ownerId, id);
  return jsonOk({ location: { ...row, links } });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, locationPatchSchema);
  if (!body.ok) return body.response;
  const existing = await findLocation(user.id, id);
  if (!existing) return jsonError("not_found", "location not found", 404);

  // `links` is reconciled into location_links; everything else maps to columns.
  const { links, ...columns } = body.value;
  if (Object.keys(columns).length > 0) {
    await db().update(locations).set(columns).where(and(eq(locations.id, id), eq(locations.ownerId, user.id)));
    queueEmbedRefresh("location", id);
  }
  if (links !== undefined) await setLocationLinks(user.id, id, links);

  const row = (await findLocation(user.id, id)) ?? existing;
  return jsonOk({ location: { ...row, links: await loadLocationLinks(user.id, id) } });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const existing = await findLocation(user.id, id);
  if (!existing) return jsonError("not_found", "location not found", 404);
  // Worlds/sessions hold their own snapshots (world-instances.plan.md), so a
  // library delete never breaks them and never hits a FK — no in-use guard.
  await db().delete(locations).where(and(eq(locations.id, id), eq(locations.ownerId, user.id)));
  void deleteEntityImages("location", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
