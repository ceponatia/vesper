import { and, desc, eq } from "drizzle-orm";
import { jsonOk, withUser } from "@/server/api";
import { db, images, sessions, worlds } from "@/server/db";
import { parseOr } from "@/lib/parse";
import { sceneReferenceListSchema } from "@/contracts";

/** Cap on scenes returned in one payload (client-side grouping/filtering). */
const GALLERY_LIMIT = 500;

/**
 * GET /api/gallery — every ready scene image the user owns, across their
 * still-existing sessions (docs/images.md §Gallery). The inner join on sessions
 * drops scenes whose session was deleted (deleteSessionImages hard-deletes those
 * rows anyway). Ordered newest-session-first, newest-scene-first within a session.
 * `references` (the characters + location a scene features) rides images.meta; the
 * client groups by session and derives the world/character filters from it.
 */
export const GET = withUser(async (user) => {
  const rows = await db()
    .select({
      id: images.id,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worldId: sessions.worldId,
      worldName: worlds.name,
      meta: images.meta,
      prompt: images.prompt,
      createdAt: images.createdAt,
    })
    .from(images)
    .innerJoin(sessions, eq(images.sessionId, sessions.id))
    .leftJoin(worlds, eq(sessions.worldId, worlds.id))
    .where(and(eq(images.ownerId, user.id), eq(images.kind, "scene"), eq(images.status, "ready")))
    .orderBy(desc(sessions.updatedAt), desc(images.createdAt))
    .limit(GALLERY_LIMIT);

  const scenes = rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    worldId: row.worldId,
    worldName: row.worldName,
    references: parseOr(sceneReferenceListSchema, metaReferences(row.meta), []),
    prompt: row.prompt,
    createdAt: row.createdAt,
  }));

  return jsonOk({ scenes });
});

/** The `references` slot off an image's freeform meta jsonb (undefined ⇒ degrades to []). */
function metaReferences(meta: unknown): unknown {
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>).references : undefined;
}
