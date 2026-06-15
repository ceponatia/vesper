import { jsonError, jsonOk, withUser } from "@/server/api";
import { deleteOwnedImage } from "@/server/images";

type Params = { id: string };

/**
 * DELETE /api/gallery/:id — permanently remove one of the owner's scene images
 * (docs/images.md §Gallery). A clean 100% delete: the row + file are dropped,
 * and because both the cross-session gallery and each session's scene gallery
 * are derived live from the images table (never a cached id), the scene
 * disappears from every view on the next fetch. The `kind: "scene"` guard keeps
 * this route from reaching avatars or entity images.
 */
export const DELETE = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const deleted = await deleteOwnedImage(id, user.id, { kind: "scene" });
  if (!deleted) return jsonError("not_found", "scene image not found", 404);
  return jsonOk({ ok: true });
});
