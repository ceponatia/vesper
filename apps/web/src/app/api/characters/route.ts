import type { NextRequest } from "next/server";
import { inArray, eq, and, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseOrNull } from "@/lib/parse";
import { characters, db } from "@/server/db";
import {
  characterCreateSchema,
  createOwnedCharacter,
  jsonError,
  jsonOk,
  parseTagsParam,
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
  const ids = await searchLibraryIds("character", user.id, { q, tags, sort: sort ?? undefined, scope });
  if (ids.length === 0) return jsonOk({ characters: [] });
  // Summary columns only — the bare row carries the 1536-dim search embedding.
  // The facet columns are extracted in SQL
  // rather than shipping the whole profile jsonb: speciesId is a top-level key,
  // gender lives in the attributes array.
  const rows = await db()
    .select({
      id: characters.id,
      name: characters.name,
      tags: characters.tags,
      avatarImageId: characters.avatarImageId,
      updatedAt: characters.updatedAt,
      speciesId: sql<string | null>`${characters.profile}->>'speciesId'`,
      gender: sql<string | null>`jsonb_path_query_first(${characters.profile}, '$.attributes[*] ? (@.id == "identity.gender").value') #>> '{}'`,
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
  const outcome = await createOwnedCharacter(user.id, body.value);
  if (outcome.status === "idempotency_mismatch") {
    return jsonOk({
      error: {
        code: "idempotency_mismatch",
        message: "This creation request already saved a character from a different draft. Review the retained edits before saving again.",
      },
      ...(outcome.recovery ? { recovery: outcome.recovery } : {}),
    }, 409);
  }
  if (outcome.status === "replay_invalid") {
    return jsonError("idempotency_replay_invalid", "the saved creation receipt could not be replayed", 500);
  }
  if (outcome.status === "create_failed") {
    return jsonError("create_failed", "character insert returned no row", 500);
  }
  return jsonOk(outcome.response, outcome.httpStatus);
});
