import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, locations } from "@/server/db";
import {
  jsonError,
  jsonOk,
  locationCreateSchema,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  withUser,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tag = req.nextUrl.searchParams.get("tag") ?? undefined;
  const ids = await searchLibraryIds("location", user.id, { q, tag });
  if (ids.length === 0) return jsonOk({ locations: [] });
  const rows = await db()
    .select()
    .from(locations)
    .where(and(eq(locations.ownerId, user.id), inArray(locations.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return jsonOk({ locations: ids.flatMap((id) => byId.get(id) ?? []) });
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, locationCreateSchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .insert(locations)
    .values({ ownerId: user.id, ...body.value })
    .returning();
  if (!row) return jsonError("create_failed", "location insert returned no row", 500);
  queueEmbedRefresh("location", row.id);
  return jsonOk({ location: row }, 201);
});
