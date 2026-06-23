import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { db, sessions, worlds } from "@/server/db";
import { HEAVY_WRITE_RATE_LIMIT, jsonError, jsonOk, rateLimit, withUser } from "@/server/api";
import { createSessionFromWorld } from "@/server/engine";

type Params = { id: string };

const spawnBodySchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  embodied: z.boolean().default(true),
  playerCharacterId: z.string().optional(),
});

/** Spawn a playable session from a world definition (docs/turn-engine.md). */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id } = await ctx.params;
  // body is optional for this endpoint
  let body: z.infer<typeof spawnBodySchema> = { embodied: true };
  const raw = await req.text();
  if (raw.trim().length > 0) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      return jsonError("invalid_json", "request body is not valid JSON", 400);
    }
    const parsed = spawnBodySchema.safeParse(candidate);
    if (!parsed.success) return jsonError("invalid_body", "expected { title?, embodied?, playerCharacterId? }", 400);
    body = parsed.data;
  }

  // Ownership before the limiter (so a legit owner's 404 doesn't burn budget);
  // a non-owner 404s without confirming the row (auth.md §Authorization).
  const [owned] = await db()
    .select({ id: worlds.id })
    .from(worlds)
    .where(and(eq(worlds.id, id), eq(worlds.ownerId, user.id)))
    .limit(1);
  if (!owned) return jsonError("not_found", "world not found", 404);
  if (!rateLimit(`world_sessions:${user.id}`, HEAVY_WRITE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many session spawns; try again in a minute", 429);
  }

  const sink = new DiagnosticCollector();
  const result = await createSessionFromWorld({
    worldId: id,
    userId: user.id,
    title: body.title,
    embodied: body.embodied,
    playerCharacterId: body.playerCharacterId,
    sink,
  });
  if (!result) {
    const noLocations = sink.items.find((d) => d.code === "spawn.no_locations");
    return noLocations
      ? jsonError("no_locations", noLocations.message, 400)
      : jsonError("not_found", "world not found", 404);
  }
  const [session] = await db().select().from(sessions).where(eq(sessions.id, result.sessionId)).limit(1);
  if (!session) return jsonError("spawn_failed", "session vanished after spawn", 500);
  return jsonOk({ session, diagnostics: sink.items }, 201);
});
