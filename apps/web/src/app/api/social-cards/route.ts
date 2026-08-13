import type { NextRequest } from "next/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
import { db, socialCards } from "@/server/db";
import {
  jsonError,
  jsonOk,
  parseTagsParam,
  queueEmbedRefresh,
  readBody,
  searchLibraryIds,
  socialCardCreateSchema,
  withUser,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tags = parseTagsParam(req.nextUrl.searchParams.get("tag"));
  const sort = parseOrNull(z.enum(["updated", "name"]), req.nextUrl.searchParams.get("sort"));
  // Discovery scope (auth.plan.md): all|public|owned; default owner-only.
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope = scopeParam === "all" || scopeParam === "public" ? scopeParam : "owned";
  const ids = await searchLibraryIds("social_card", user.id, { q, tags, sort: sort ?? undefined, scope });
  if (ids.length === 0) return jsonOk({ socialCards: [] });
  // Fetch the scoped ids as viewable rows (owner-or-public) — public scope returns
  // other owners' published cards, so this can't filter to user.id alone.
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  const rows = await db()
    .select({
      id: socialCards.id,
      name: socialCards.name,
      description: socialCards.description,
      tags: socialCards.tags,
      visibility: socialCards.visibility,
      definition: socialCards.definition,
    })
    .from(socialCards)
    .where(
      and(
        inArray(socialCards.id, ids),
        or(eq(socialCards.ownerId, user.id), eq(socialCards.visibility, "public")),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return jsonOk({ socialCards: ids.flatMap((id) => byId.get(id) ?? []) });
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, socialCardCreateSchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .insert(socialCards)
    .values({ ownerId: user.id, ...body.value })
    .returning();
  if (!row) return jsonError("create_failed", "social card insert returned no row", 500);
  queueEmbedRefresh("social_card", row.id);
  return jsonOk({ socialCard: row }, 201);
});
