import type { NextRequest } from "next/server";
import { inArray, eq, and, or, sql } from "drizzle-orm";
import { z } from "zod";
import { seedBodyConfigFromAttributes, seedRegistryDefaultValues } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { parseOrNull } from "@/lib/parse";
import { characters, db, worldCast } from "@/server/db";
import {
  characterCreateSchema,
  jsonError,
  jsonOk,
  materializeSuggestedItems,
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
  // Discovery scope (auth.plan.md fast-follow): all|public|owned; default owner-only.
  const scopeParam = params.get("scope");
  const scope = scopeParam === "all" || scopeParam === "public" ? scopeParam : "owned";
  const ids = await searchLibraryIds("character", user.id, { q, tags, sort: sort ?? undefined, scope });
  if (ids.length === 0) return jsonOk({ characters: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  // The facet columns (library-ux.plan.md §Follow-up pass) are extracted in SQL
  // rather than shipping the whole profile jsonb: speciesId is a top-level key,
  // gender lives in the attributes array, world usage counts the soft source
  // pointers worlds keep on their snapshot copies (world-instances.plan.md).
  const rows = await db()
    .select({
      id: characters.id,
      name: characters.name,
      tags: characters.tags,
      avatarImageId: characters.avatarImageId,
      updatedAt: characters.updatedAt,
      speciesId: sql<string | null>`${characters.profile}->>'speciesId'`,
      gender: sql<string | null>`jsonb_path_query_first(${characters.profile}, '$.attributes[*] ? (@.id == "identity.gender").value') #>> '{}'`,
      // The inner table is aliased and the outer id table-qualified by hand:
      // drizzle renders single-table selects with unqualified columns, so a
      // bare correlated `id` would resolve to world_cast's own id.
      worldCount: sql<number>`(select count(distinct wc.world_id)::int from ${worldCast} wc where wc.source_character_id = ${characters}.id)`,
    })
    .from(characters)
    // Non-owned rows are reachable only when the scoped search returned them.
    .where(and(inArray(characters.id, ids), or(eq(characters.ownerId, user.id), eq(characters.visibility, "public"))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return jsonOk({ characters: ids.flatMap((id) => byId.get(id) ?? []) });
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, characterCreateSchema);
  if (!body.ok) return body.response;

  // Forge outfit suggestions become real library items before the character
  // row exists — a stray item is harmless, a dangling outfit id is not.
  const sink = new DiagnosticCollector();
  const suggestedIds = await materializeSuggestedItems(user.id, body.value.suggestedItems, sink);
  // A truly blank profile (the library's New button) is born with the curated
  // registry defaults + the body-config those imply (gender=female seeds
  // vulva/breasts). Any profile arriving WITH attributes — forge drafts,
  // clones, API callers — is authored data and passes through untouched.
  const blank = body.value.profile.attributes.length === 0;
  const attributes = blank ? seedRegistryDefaultValues(body.value.profile.attributes) : body.value.profile.attributes;
  const seededConfig = blank ? seedBodyConfigFromAttributes(attributes) : null;
  const profile = {
    ...body.value.profile,
    attributes,
    ...(seededConfig
      ? { intimateRegions: seededConfig.intimateRegions, bodyFeatures: seededConfig.bodyFeatures }
      : {}),
    defaultOutfit: [...new Set([...body.value.profile.defaultOutfit, ...suggestedIds])],
  };

  const [row] = await db()
    .insert(characters)
    .values({ ownerId: user.id, name: body.value.name, profile, tags: body.value.tags })
    .returning();
  if (!row) return jsonError("create_failed", "character insert returned no row", 500);
  queueEmbedRefresh("character", row.id);
  return jsonOk({ character: row, diagnostics: sink.items }, 201);
});
