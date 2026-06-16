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
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tag = req.nextUrl.searchParams.get("tag") ?? undefined;
  // Optional sub-kind filter (clothing/object/container); an unknown value
  // degrades to no filter rather than failing the request.
  const kind = parseOrNull(itemKindSchema, req.nextUrl.searchParams.get("kind"));
  const ids = await searchLibraryIds("item", user.id, { q, tag });
  if (ids.length === 0) return jsonOk({ items: [] });
  const rows = await db()
    .select()
    .from(items)
    .where(and(eq(items.ownerId, user.id), inArray(items.id, ids), kind ? eq(items.kind, kind) : undefined));
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
