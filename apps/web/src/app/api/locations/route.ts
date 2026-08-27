import type { NextRequest } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
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
  const params = req.nextUrl.searchParams;
  const q = params.get("q") ?? undefined;
  const tags = parseTagsParam(params.get("tag"));
  const sort = parseOrNull(z.enum(["updated", "name"]), params.get("sort"));
  // Discovery scope: all|public|owned; default owner-only.
  const scopeParam = params.get("scope");
  const scope = scopeParam === "all" || scopeParam === "public" ? scopeParam : "owned";
  const ids = await searchLibraryIds("location", user.id, { q, tags, sort: sort ?? undefined, scope });
  if (ids.length === 0) return jsonOk({ locations: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  // `scale` is the library facet column.
  const rows = await db()
    .select({
      id: locations.id,
      name: locations.name,
      description: locations.description,
      tags: locations.tags,
      imageId: locations.imageId,
      scale: locations.scale,
    })
    .from(locations)
    // Non-owned rows are reachable only when the scoped search returned them.
    .where(and(inArray(locations.id, ids), or(eq(locations.ownerId, user.id), eq(locations.visibility, "public"))));
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
