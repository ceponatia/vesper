import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { clearEntityImagePointers, deleteOwnedImage, GALLERY_IMAGE_KINDS } from "@/server/images";
import { db, images } from "@/server/db";

type Params = { id: string };

/**
 * DELETE /api/gallery/:id — permanently remove one of the owner's gallery
 * images (docs/images/pipelines/scene-images.md §The Gallery hub). A clean
 * 100% delete: the row + file are
 * dropped, every gallery view derives live from the images table, and any soft
 * pointer at the id (character avatar, location/item/world art) is nulled so
 * nothing dangles. The kind guard keeps this route inside the gallery's asset
 * classes (never chat uploads, look/place anchors, or canonical avatars).
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const deleted = await deleteOwnedImage(id, user.id, { kinds: GALLERY_IMAGE_KINDS });
  if (!deleted) return jsonError("not_found", "gallery image not found", 404);
  await clearEntityImagePointers([id]);
  return jsonOk({ ok: true });
});

const favoriteSchema = z.object({ favorite: z.boolean() });

/** PATCH /api/gallery/:id — toggle the owner's favorite flag on a gallery image. */
export const PATCH = withUser<Params>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, favoriteSchema);
  if (!body.ok) return body.response;
  const [row] = await db()
    .update(images)
    .set({ favorite: body.value.favorite })
    .where(and(eq(images.id, id), eq(images.ownerId, user.id), inArray(images.kind, [...GALLERY_IMAGE_KINDS])))
    .returning({ id: images.id, favorite: images.favorite });
  if (!row) return jsonError("not_found", "gallery image not found", 404);
  return jsonOk({ image: row });
});
