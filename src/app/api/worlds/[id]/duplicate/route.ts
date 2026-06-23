import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, worlds } from "@/server/db";
import {
  duplicateWorld,
  getWorldDetail,
  HEAVY_WRITE_RATE_LIMIT,
  jsonError,
  jsonOk,
  rateLimit,
  withUser,
} from "@/server/api";

type Params = { id: string };

const duplicateBodySchema = z.object({ name: z.string().trim().min(1).max(200).optional() });

/** Deep-copy a world (+lore/cast/locations/items); sets duplicated_from_world_id. */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  // Body is optional, but malformed JSON is a 400 (never silently empty),
  // mirroring the sessions spawn route.
  let name: string | undefined;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return jsonError("invalid_json", "request body is not valid JSON", 400);
    }
    const parsed = duplicateBodySchema.safeParse(candidate);
    if (!parsed.success) return jsonError("invalid_body", "expected { name?: string }", 400);
    name = parsed.data.name;
  }

  // Ownership before the limiter (so a legit owner's 404 doesn't burn budget);
  // a non-owner 404s without confirming the row (auth.md §Authorization).
  const [owned] = await db()
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, id), eq(worlds.ownerId, user.id)))
    .limit(1);
  if (!owned) return jsonError("not_found", "world not found", 404);
  if (!rateLimit(`world_duplicate:${user.id}`, HEAVY_WRITE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many world duplications; try again in a minute", 429);
  }

  const result = await duplicateWorld(user.id, id, name);
  if (!result.ok) return jsonError("not_found", "world not found", 404);
  const detail = await getWorldDetail(user.id, result.worldId);
  if (!detail) return jsonError("duplicate_failed", "copy vanished after duplicate", 500);
  return jsonOk(detail, 201);
});
