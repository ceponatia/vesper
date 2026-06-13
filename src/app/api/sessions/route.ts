import { and, desc, eq } from "drizzle-orm";
import { jsonOk, withUser } from "@/server/api";
import { db, sessions, worlds } from "@/server/db";

const LIST_LIMIT = 100;
const RECENT_LIMIT = 20;

/** GET /api/sessions — owner's sessions; `?recent` trims the list, `?worldId` filters. */
export const GET = withUser(async (user, req) => {
  const params = req.nextUrl.searchParams;
  const worldId = params.get("worldId");
  const recent = params.get("recent") !== null;

  const filters = [eq(sessions.ownerId, user.id)];
  if (worldId) filters.push(eq(sessions.worldId, worldId));

  const rows = await db()
    .select({
      id: sessions.id,
      worldId: sessions.worldId,
      worldName: worlds.name,
      title: sessions.title,
      status: sessions.status,
      embodied: sessions.embodied,
      clockMinutes: sessions.clockMinutes,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .leftJoin(worlds, eq(sessions.worldId, worlds.id))
    .where(and(...filters))
    .orderBy(desc(sessions.updatedAt))
    .limit(recent ? RECENT_LIMIT : LIST_LIMIT);

  return jsonOk({ sessions: rows });
});
