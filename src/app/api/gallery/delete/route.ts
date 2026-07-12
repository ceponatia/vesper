import { z } from "zod";
import { jsonOk, readBody, withUser } from "@/server/api";
import { clearEntityImagePointers, deleteOwnedImages, GALLERY_IMAGE_KINDS } from "@/server/images";

/** Cap matches the Gallery page limit — the client never has more selected than loaded. */
const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * POST /api/gallery/delete — bulk hard-delete the owner's gallery images by id
 * (docs/images.md §Gallery). Sent by "Delete all" (the ids matching the active
 * filter) and the multi-select delete (the checked ids). Owner-scoped and
 * kind-guarded to the gallery's asset classes, so a crafted body can only ever
 * reach the caller's own gallery art — never another owner's or another asset
 * class. Soft pointers at deleted ids (character avatar, location/item/world
 * art) are nulled. Returns the number of rows actually removed.
 */
export const POST = withUser(async (user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const deleted = await deleteOwnedImages(body.value.ids, user.id, { kinds: GALLERY_IMAGE_KINDS });
  if (deleted > 0) await clearEntityImagePointers(body.value.ids);
  return jsonOk({ deleted });
});
