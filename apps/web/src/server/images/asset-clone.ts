import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, notInArray } from "drizzle-orm";
import { db, images } from "../db";
import { newId } from "@/lib/ids";
import { log } from "@/server/log";
import { absoluteImagePath, containedAbsoluteImagePath, imageRelativePath } from "./paths";
import { type ImageEntityKind, HIDDEN_IMAGE_KINDS } from "./asset-storage";

/**
 * Duplicate a shareable entity's ready images into a new owner's storage for a
 * clone (the world-instances image policy). Each source image gets a
 * fresh row owned by `dstOwnerId`, pointed at `dstEntityId`, with the file
 * **copied** (not shared) so the clone is fully self-contained — deleting the
 * source can never strip the copy's art. `sourceImageId` records provenance.
 * Returns old→new image-id map so callers can remap avatar/cover references.
 * An image that fails to copy is skipped (degraded, never throws).
 *
 * `HIDDEN_IMAGE_KINDS` never travels: an identity face crop is derived state, and
 * the destination character derives its OWN pack from its own copied portrait
 * once that row is ready. Cloning one would hand the destination a crop whose pack row — the
 * only authority for whether it may be used at all — did not come with it.
 */
export async function cloneEntityImages(
  entityKind: ImageEntityKind,
  srcEntityId: string,
  srcOwnerId: string,
  dstEntityId: string,
  dstOwnerId: string,
): Promise<Map<string, string>> {
  const rows = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.ownerId, srcOwnerId),
        eq(images.entityKind, entityKind),
        eq(images.entityId, srcEntityId),
        eq(images.status, "ready"),
        notInArray(images.kind, [...HIDDEN_IMAGE_KINDS]),
      ),
    );
  const idMap = new Map<string, string>();
  for (const src of rows) {
    const newImageId = newId();
    const relative = imageRelativePath(dstOwnerId, newImageId);
    try {
      const absoluteDst = absoluteImagePath({ id: newImageId, ownerId: dstOwnerId, path: relative });
      await fs.mkdir(path.dirname(absoluteDst), { recursive: true });
      await fs.copyFile(absoluteImagePath(src), containedAbsoluteImagePath(absoluteDst));
    } catch (err) {
      log.warn("images", "clone image copy failed; skipping", {
        imageId: src.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const [inserted] = await db()
      .insert(images)
      .values({
        id: newImageId,
        ownerId: dstOwnerId,
        kind: src.kind,
        entityKind,
        entityId: dstEntityId,
        path: relative,
        prompt: src.prompt,
        sourceImageId: src.id,
        status: "ready",
        meta: src.meta,
      })
      .returning({ id: images.id });
    if (inserted) idMap.set(src.id, inserted.id);
  }
  return idMap;
}
