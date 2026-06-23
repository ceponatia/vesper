import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { jsonOk, withUser } from "@/server/api";
import { characters, db, imageReferences, images, sessions, worlds } from "@/server/db";
import type { SceneReference } from "@/contracts";

/** Cap on scenes returned in one payload (client-side grouping/filtering). */
const GALLERY_LIMIT = 500;

/**
 * GET /api/gallery — every ready scene image the user owns (docs/images.md
 * §Gallery), from two sources: in-session scenes (inner-joined to sessions, so
 * a deleted session drops its scenes) and sessionless character-chat scenes
 * (`entityKind:"character"`, no session — docs/developer-notes/character-chat.plan.md).
 * Session scenes come first (newest-session-first, newest-scene-first within),
 * then character-chat scenes (newest first), which the client groups under
 * "Character chats". The `references` a scene features come from the
 * authoritative `image_references` join table; the client derives the
 * world/character filters from them.
 */
export const GET = withUser(async (user) => {
  const sessionRows = await db()
    .select({
      id: images.id,
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worldId: sessions.worldId,
      worldName: worlds.name,
      prompt: images.prompt,
      createdAt: images.createdAt,
    })
    .from(images)
    .innerJoin(sessions, eq(images.sessionId, sessions.id))
    .leftJoin(worlds, eq(sessions.worldId, worlds.id))
    .where(and(eq(images.ownerId, user.id), eq(images.kind, "scene"), eq(images.status, "ready")))
    .orderBy(desc(sessions.updatedAt), desc(images.createdAt))
    .limit(GALLERY_LIMIT);

  // Sessionless character-chat scenes. Inner-joined to characters so a deleted
  // character drops its chat scenes, mirroring the session inner join above.
  const chatRows = await db()
    .select({
      id: images.id,
      characterId: characters.id,
      characterName: characters.name,
      prompt: images.prompt,
      createdAt: images.createdAt,
    })
    .from(images)
    // Owner-scope the join on the characters side too (security Cluster I2): the
    // image rows are already owner-filtered below, but constraining the joined
    // character to the same owner makes it structurally impossible for the join
    // to surface another owner's character row.
    .innerJoin(characters, and(eq(images.entityId, characters.id), eq(characters.ownerId, user.id)))
    .where(
      and(
        eq(images.ownerId, user.id),
        eq(images.kind, "scene"),
        eq(images.status, "ready"),
        eq(images.entityKind, "character"),
        isNull(images.sessionId),
      ),
    )
    .orderBy(desc(images.createdAt))
    .limit(GALLERY_LIMIT);

  const referencesByScene = await loadSceneReferences([
    ...sessionRows.map((r) => r.id),
    ...chatRows.map((r) => r.id),
  ]);

  const sessionScenes = sessionRows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    worldId: row.worldId,
    worldName: row.worldName,
    characterId: null,
    characterName: null,
    references: referencesByScene.get(row.id) ?? [],
    prompt: row.prompt,
    createdAt: row.createdAt,
  }));

  const chatScenes = chatRows.map((row) => ({
    id: row.id,
    sessionId: null,
    sessionTitle: null,
    worldId: null,
    worldName: null,
    characterId: row.characterId,
    characterName: row.characterName,
    references: referencesByScene.get(row.id) ?? [],
    prompt: row.prompt,
    createdAt: row.createdAt,
  }));

  return jsonOk({ scenes: [...sessionScenes, ...chatScenes] });
});

/**
 * The Gallery-relevant references — character/location refs with a library
 * entity id — for a batch of scenes, from the `image_references` join table,
 * grouped by scene. Non-entity reference roles (style/pose/layout) are not
 * surfaced to the Gallery.
 */
async function loadSceneReferences(sceneIds: string[]): Promise<Map<string, SceneReference[]>> {
  const byScene = new Map<string, SceneReference[]>();
  if (sceneIds.length === 0) return byScene;
  const rows = await db()
    .select({
      sceneImageId: imageReferences.sceneImageId,
      kind: imageReferences.kind,
      entityId: imageReferences.entityId,
      name: imageReferences.name,
    })
    .from(imageReferences)
    .where(inArray(imageReferences.sceneImageId, sceneIds))
    .orderBy(imageReferences.createdAt);
  for (const row of rows) {
    if (!row.entityId) continue;
    if (row.kind !== "character" && row.kind !== "location") continue;
    const list = byScene.get(row.sceneImageId) ?? [];
    list.push({ kind: row.kind, id: row.entityId, name: row.name });
    byScene.set(row.sceneImageId, list);
  }
  return byScene;
}
