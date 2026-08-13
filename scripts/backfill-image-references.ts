import "dotenv/config";
import { eq } from "drizzle-orm";
import { sceneReferenceListSchema } from "@vesper/image-core";
import { parseOr } from "@/lib/parse";
import { db, imageReferences, images } from "@/server/db";

/**
 * One-time, idempotent backfill: copy each scene image's legacy
 * `meta.references` (the pre-`image_references` JSONB record) into the join
 * table so existing scenes keep their Gallery character/location facets. Scenes
 * that already have join rows are skipped, so re-running is safe. Provenance
 * (`source`/`image_id`) is unknown for old anchors and left null — only the
 * Gallery-relevant `kind`/`entity_id`/`name` are recovered. New renders write
 * the table directly (server/images/scene.ts), so this never needs to run twice.
 */
function metaReferences(meta: unknown): unknown {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).references : undefined;
}

async function main(): Promise<void> {
  const scenes = await db().select({ id: images.id, meta: images.meta }).from(images).where(eq(images.kind, "scene"));
  const existing = await db().select({ sceneImageId: imageReferences.sceneImageId }).from(imageReferences);
  const alreadyBackfilled = new Set(existing.map((r) => r.sceneImageId));

  let insertedRows = 0;
  let touchedScenes = 0;
  for (const scene of scenes) {
    if (alreadyBackfilled.has(scene.id)) continue;
    const refs = parseOr(sceneReferenceListSchema, metaReferences(scene.meta), []);
    if (refs.length === 0) continue;
    await db()
      .insert(imageReferences)
      .values(
        refs.map((r) => ({
          sceneImageId: scene.id,
          kind: r.kind,
          entityId: r.id,
          role: r.kind === "location" ? "location" : null,
          source: r.kind === "location" ? ("entity" as const) : null,
          imageId: null,
          name: r.name,
        })),
      );
    insertedRows += refs.length;
    touchedScenes += 1;
  }
  console.log(`backfilled ${insertedRows} image_references rows across ${touchedScenes} scene(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
