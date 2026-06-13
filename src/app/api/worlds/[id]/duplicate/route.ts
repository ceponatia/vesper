import type { NextRequest } from "next/server";
import { z } from "zod";
import { duplicateWorld, getWorldDetail, jsonError, jsonOk, withUser } from "@/server/api";

type Params = { id: string };

const duplicateBodySchema = z.object({ name: z.string().trim().min(1).max(200).optional() });

/** Deep-copy a world (+lore/cast/locations/items); sets duplicated_from_world_id. */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  // body is optional for this endpoint
  let name: string | undefined;
  const raw = await req.text();
  if (raw.trim().length > 0) {
    const parsed = duplicateBodySchema.safeParse(safeJson(raw));
    if (!parsed.success) return jsonError("invalid_body", "expected { name?: string }", 400);
    name = parsed.data.name;
  }
  const result = await duplicateWorld(user.id, id, name);
  if (!result.ok) return jsonError("not_found", "world not found", 404);
  const detail = await getWorldDetail(user.id, result.worldId);
  if (!detail) return jsonError("duplicate_failed", "copy vanished after duplicate", 500);
  return jsonOk(detail, 201);
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
