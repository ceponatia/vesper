import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { itemKindSchema } from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { db, items } from "@/server/db";
import {
  invalidCoverageIds,
  itemCreateSchema,
  jsonError,
  jsonOk,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  withUser,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  // Explicit id resolution (e.g. a character's `defaultOutfit`): fetch exactly
  // these owner items, bypassing the search/result cap so a stored reference
  // always resolves no matter how large the library has grown. Order preserved.
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (idsParam !== null) {
    const wanted = [...new Set(idsParam.split(",").map((s) => s.trim()).filter(Boolean))];
    if (wanted.length === 0) return jsonOk({ items: [] });
    const rows = await db().select().from(items).where(and(eq(items.ownerId, user.id), inArray(items.id, wanted)));
    const found = new Map(rows.map((r) => [r.id, r]));
    return jsonOk({ items: wanted.flatMap((id) => found.get(id) ?? []) });
  }

  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tag = req.nextUrl.searchParams.get("tag") ?? undefined;
  // Optional sub-kind filter (clothing/object/container); an unknown value
  // degrades to no filter rather than failing the request.
  const kind = parseOrNull(itemKindSchema, req.nextUrl.searchParams.get("kind"));
  // Pass kind INTO the search so the result cap is applied per-kind. Otherwise a
  // single-kind list is silently truncated by other-kind rows ranking higher by
  // updated_at — which dropped the clothing a character's defaultOutfit references
  // once the owner crossed LIST_LIMIT total items.
  const ids = await searchLibraryIds("item", user.id, { q, tag, itemKind: kind ?? undefined });
  if (ids.length === 0) return jsonOk({ items: [] });
  const rows = await db()
    .select()
    .from(items)
    .where(and(eq(items.ownerId, user.id), inArray(items.id, ids)));
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
