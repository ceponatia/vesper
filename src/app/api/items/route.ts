import type { NextRequest } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { clothingLayerSchema, itemKindSchema } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { db, items } from "@/server/db";
import {
  invalidCoverageIds,
  itemCreateSchema,
  jsonError,
  jsonOk,
  parseTagsParam,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  withUser,
} from "@/server/api";

// Explicit list columns: the bare row carries the 1536-dim search embedding —
// megabytes of dead payload across a 100-row list (library-ux.plan.md §2).
const LIST_COLUMNS = {
  id: items.id,
  kind: items.kind,
  name: items.name,
  description: items.description,
  tags: items.tags,
  imageId: items.imageId,
  definition: items.definition,
} as const;

export const GET = withUser(async (user, req: NextRequest) => {
  // Explicit id resolution (e.g. a character's `defaultOutfit`): fetch exactly
  // these owner items, bypassing the search/result cap so a stored reference
  // always resolves no matter how large the library has grown. Order preserved.
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (idsParam !== null) {
    const wanted = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))];
    if (wanted.length === 0) return jsonOk({ items: [] });
    const rows = await db()
      .select(LIST_COLUMNS)
      .from(items)
      .where(and(eq(items.ownerId, user.id), inArray(items.id, wanted)));
    const found = new Map(rows.map((r) => [r.id, r]));
    return jsonOk({ items: wanted.flatMap((id) => found.get(id) ?? []) });
  }

  const params = req.nextUrl.searchParams;
  const q = params.get("q") ?? undefined;
  const tags = parseTagsParam(params.get("tag"));
  // Optional sub-kind + facet filters (library-ux.plan.md); an unknown value
  // degrades to no filter rather than failing the request.
  const kind = parseOrNull(itemKindSchema, params.get("kind"));
  const layer = parseOrNull(clothingLayerSchema, Number(params.get("layer") ?? NaN));
  const sort = parseOrNull(z.enum(["updated", "name"]), params.get("sort"));
  // Discovery scope (auth.plan.md fast-follow): all|public|owned; default owner-only.
  const scopeParam = params.get("scope");
  const scope = scopeParam === "all" || scopeParam === "public" ? scopeParam : "owned";
  // Pass kind + facets INTO the search so the result cap is applied per-facet.
  // Otherwise a facet-scoped list is silently truncated by other rows ranking
  // higher by updated_at (the defaultOutfit lesson — see searchLibraryIds).
  const ids = await searchLibraryIds("item", user.id, {
    q,
    tags,
    itemKind: kind ?? undefined,
    itemFacets: {
      category: params.get("category") ?? undefined,
      subtype: params.get("subtype") ?? undefined,
      layer: layer ?? undefined,
      wearer: params.get("wearer") ?? undefined,
      colorFamily: params.get("color") ?? undefined,
    },
    sort: sort ?? undefined,
    scope,
  });
  if (ids.length === 0) return jsonOk({ items: [] });
  const rows = await db()
    .select(LIST_COLUMNS)
    .from(items)
    // Non-owned rows are reachable only when the scoped search returned them.
    .where(and(inArray(items.id, ids), or(eq(items.ownerId, user.id), eq(items.visibility, "public"))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return jsonOk({ items: ids.flatMap((id) => byId.get(id) ?? []) });
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, itemCreateSchema);
  if (!body.ok) return body.response;
  const invalid = invalidCoverageIds(body.value.definition.coverage);
  if (invalid.length > 0) {
    return jsonError("invalid_coverage", `unknown body locations: ${invalid.join(", ")}`, 400);
  }
  const [row] = await db()
    .insert(items)
    .values({ ownerId: user.id, ...body.value })
    .returning();
  if (!row) return jsonError("create_failed", "item insert returned no row", 500);
  queueEmbedRefresh("item", row.id);
  return jsonOk({ item: row }, 201);
});
