import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { jsonOk, withUser } from "@/server/api";
import { characters, db, imageReferences, images, items, locations } from "@/server/db";
import type { SceneReference } from "@vesper/image-core";

/** Default page size; `limit` is clamped to [1, 500] (the old single-payload cap). */
const GALLERY_PAGE = 100;
const GALLERY_PAGE_MAX = 500;

export type GalleryTab = "scenes" | "portraits" | "entity";

/**
 * Keyset cursor `<createdAtMs>_<id>` over (created_at desc, id desc) — the
 * "Load more" seam past the old 500 cap.
 * An unparseable cursor degrades to the first page, never a failed request.
 */
function parseCursor(raw: string | null): { at: Date; id: string } | null {
  if (!raw) return null;
  const split = raw.indexOf("_");
  if (split <= 0) return null;
  const ms = Number(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (!Number.isFinite(ms) || !id) return null;
  return { at: new Date(ms), id };
}

function cursorFor(row: { createdAt: Date | null; id: string }): string | null {
  return row.createdAt ? `${row.createdAt.getTime()}_${row.id}` : null;
}

function keysetCondition(cursor: { at: Date; id: string } | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(lt(images.createdAt, cursor.at), and(eq(images.createdAt, cursor.at), lt(images.id, cursor.id)));
}

/**
 * GET /api/gallery — the owner's generated art as a tabbed hub
 * (docs/images/pipelines.md §Scene images, the Gallery hub): `?tab=scenes`
 * (default — character-chat scenes, joined to their
 * character), `?tab=portraits` (character portrait variants), `?tab=entity`
 * (location / item art). All tabs page by the keyset `?cursor` + `?limit`,
 * newest first, and carry the `favorite` flag. Scene rows also carry the
 * `image_references` the client's filters/view modes are derived from.
 */
export const GET = withUser(async (user, req: NextRequest) => {
  const params = req.nextUrl.searchParams;
  const tabParam = params.get("tab");
  const tab: GalleryTab = tabParam === "portraits" || tabParam === "entity" ? tabParam : "scenes";
  const limitParam = Number(params.get("limit") ?? NaN);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.trunc(limitParam), 1), GALLERY_PAGE_MAX) : GALLERY_PAGE;
  const cursor = parseCursor(params.get("cursor"));

  const base = [eq(images.ownerId, user.id), eq(images.status, "ready"), keysetCondition(cursor)];

  if (tab === "portraits") {
    const rows = await db()
      .select({
        id: images.id,
        characterId: characters.id,
        characterName: characters.name,
        prompt: images.prompt,
        favorite: images.favorite,
        createdAt: images.createdAt,
      })
      .from(images)
      // Owner-scope the joined character too (security Cluster I2 posture).
      .innerJoin(characters, and(eq(images.entityId, characters.id), eq(characters.ownerId, user.id)))
      .where(and(...base, eq(images.kind, "portrait_variant")))
      .orderBy(desc(images.createdAt), desc(images.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return jsonOk({
      images: page.map((row) => ({ ...row, references: [] as SceneReference[] })),
      nextCursor: rows.length > limit ? cursorFor(page[page.length - 1] ?? { createdAt: null, id: "" }) : null,
    });
  }

  if (tab === "entity") {
    const rows = await db()
      .select({
        id: images.id,
        entityKind: images.entityKind,
        entityName: locations.name,
        itemName: items.name,
        prompt: images.prompt,
        favorite: images.favorite,
        createdAt: images.createdAt,
      })
      .from(images)
      .leftJoin(locations, and(eq(images.entityKind, "location"), eq(images.entityId, locations.id)))
      .leftJoin(items, and(eq(images.entityKind, "item"), eq(images.entityId, items.id)))
      .where(and(...base, eq(images.kind, "entity")))
      .orderBy(desc(images.createdAt), desc(images.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return jsonOk({
      images: page.map((row) => ({
        id: row.id,
        entityKind: row.entityKind,
        entityName: row.entityName ?? row.itemName ?? null,
        prompt: row.prompt,
        favorite: row.favorite,
        createdAt: row.createdAt,
        references: [] as SceneReference[],
      })),
      nextCursor: rows.length > limit ? cursorFor(page[page.length - 1] ?? { createdAt: null, id: "" }) : null,
    });
  }

  // Scenes: character-chat scenes, joined to their character (must still exist;
  // owner-scoped join, security Cluster I2).
  const rows = await db()
    .select({
      id: images.id,
      characterId: characters.id,
      characterName: characters.name,
      prompt: images.prompt,
      favorite: images.favorite,
      createdAt: images.createdAt,
    })
    .from(images)
    .innerJoin(characters, and(eq(images.entityId, characters.id), eq(characters.ownerId, user.id)))
    .where(and(...base, eq(images.kind, "scene"), eq(images.entityKind, "character")))
    .orderBy(desc(images.createdAt), desc(images.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const referencesByScene = await loadSceneReferences(page.map((r) => r.id));
  return jsonOk({
    images: page.map((row) => ({
      ...row,
      references: referencesByScene.get(row.id) ?? [],
    })),
    nextCursor: rows.length > limit ? cursorFor(page[page.length - 1] ?? { createdAt: null, id: "" }) : null,
  });
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
