import { z } from "zod";
import { jsonOk, readBody, withUser } from "@/server/api";
import { deleteOwnedImages } from "@/server/images";

/** Cap matches the Gallery payload limit — the client never has more on screen. */
const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * POST /api/gallery/delete — bulk hard-delete the owner's scene images by id
 * (docs/images.md §Gallery). The Gallery's "Delete all" sends the ids matching
 * the active world/character filter (so an "all worlds / all characters" filter
 * sends everything, a "Kimberly" filter sends only her scenes). The delete is
 * owner-scoped and `kind: "scene"`-guarded, so a crafted body can only ever
 * reach the caller's own scene art — never another owner's or another asset
 * class. Returns the number of rows actually removed.
 */
export const POST = withUser(async (user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const deleted = await deleteOwnedImages(body.value.ids, user.id, { kind: "scene" });
  return jsonOk({ deleted });
});
