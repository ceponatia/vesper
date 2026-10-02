import { inArray } from "drizzle-orm";
import { db, imageReferences } from "@/server/db";
import type { SceneReference } from "@vesper/image-core";

/**
 * The Gallery-relevant references — character/location refs with a library
 * entity id — for a batch of scenes, from the `image_references` join table,
 * grouped by scene. Non-entity reference roles (style/pose/layout) are not
 * surfaced to the Gallery.
 */
export async function loadSceneReferences(sceneIds: string[]): Promise<Map<string, SceneReference[]>> {
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
