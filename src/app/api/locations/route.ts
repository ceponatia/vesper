import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, locations } from "@/server/db";
import {
  jsonError,
  jsonOk,
  locationCreateSchema,
  parseTagsParam,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  withUser,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tags = parseTagsParam(req.nextUrl.searchParams.get("tag"));
  const ids = await searchLibraryIds("location", user.id, { q, tags });
  if (ids.length === 0) return jsonOk({ locations: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  const rows = await db()
    .select({
      id: locations.id,
      name: locations.name,
      description: locations.description,
      tags: locations.tags,
      imageId: locations.imageId,
    })
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
