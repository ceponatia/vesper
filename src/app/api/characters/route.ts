import type { NextRequest } from "next/server";
import { inArray, eq, and } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characters, db } from "@/server/db";
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
  const q = req.nextUrl.searchParams.get("q") ?? undefined;
  const tags = parseTagsParam(req.nextUrl.searchParams.get("tag"));
  const ids = await searchLibraryIds("character", user.id, { q, tags });
  if (ids.length === 0) return jsonOk({ characters: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  const rows = await db()
    .select({
      id: characters.id,
      name: characters.name,
      tags: characters.tags,
      avatarImageId: characters.avatarImageId,
      updatedAt: characters.updatedAt,
    })
    .from(characters)
    .where(and(eq(characters.ownerId, user.id), inArray(characters.id, ids)));
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
  const profile = {
    ...body.value.profile,
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
