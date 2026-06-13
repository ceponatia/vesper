import type { NextRequest } from "next/server";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db, worlds } from "@/server/db";
import { escapeLikePattern } from "@/server/authoring";
import {
  createWorld,
  getWorldDetail,
  jsonError,
  jsonOk,
  LIST_LIMIT,
  queueWorldImageGeneration,
  readBody,
  withUser,
  worldCreateSchema,
} from "@/server/api";

export const GET = withUser(async (user, req: NextRequest) => {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const owned = eq(worlds.ownerId, user.id);
  const pattern = q ? `%${escapeLikePattern(q)}%` : undefined;
  const rows = await db()
    .select()
    .from(worlds)
    .where(pattern ? and(owned, or(ilike(worlds.name, pattern), ilike(worlds.description, pattern))) : owned)
    .orderBy(desc(worlds.updatedAt))
    .limit(LIST_LIMIT);
  return jsonOk({ worlds: rows });
});

/** Create a world; nested locations/cast/items/lore materialize world_* rows (docs/authoring.md). */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, worldCreateSchema);
  if (!body.ok) return body.response;
  const result = await createWorld(user.id, body.value);
  if (!result.ok) return jsonError(result.code, result.message, 400);
  queueWorldImageGeneration(user.id, result.worldId); // backfill any missing images for nested entities
  const detail = await getWorldDetail(user.id, result.worldId);
  if (!detail) return jsonError("create_failed", "world vanished after create", 500);
  return jsonOk({ ...detail, diagnostics: result.diagnostics }, 201);
});
