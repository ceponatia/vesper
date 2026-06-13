import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, worlds } from "@/server/db";
import {
  deleteEntityImages,
  getWorldDetail,
  isForeignKeyViolation,
  jsonError,
  jsonOk,
  readBody,
  updateWorld,
  withUser,
  worldPatchSchema,
} from "@/server/api";

type Params = { id: string };

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const detail = await getWorldDetail(user.id, id);
  if (!detail) return jsonError("not_found", "world not found", 404);
  return jsonOk(detail);
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, worldPatchSchema);
  if (!body.ok) return body.response;
  const result = await updateWorld(user.id, id, body.value);
  if (!result.ok) {
    return result.code === "not_found"
      ? jsonError("not_found", result.message, 404)
      : jsonError(result.code, result.message, 400);
  }
  const detail = await getWorldDetail(user.id, id);
  if (!detail) return jsonError("not_found", "world not found", 404);
  return jsonOk({ ...detail, diagnostics: result.diagnostics });
});

export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const [existing] = await db()
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, id), eq(worlds.ownerId, user.id)))
    .limit(1);
  if (!existing) return jsonError("not_found", "world not found", 404);
  try {
    await db().delete(worlds).where(and(eq(worlds.id, id), eq(worlds.ownerId, user.id)));
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      return jsonError("in_use", "world has sessions; delete them first", 409);
    }
    throw err;
  }
  void deleteEntityImages("world", id, user.id).catch(() => undefined);
  return jsonOk({ ok: true });
});
