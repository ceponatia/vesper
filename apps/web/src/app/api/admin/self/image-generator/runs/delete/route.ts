import { z } from "zod";
import { jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { deleteImageGeneratorRuns } from "@/server/images";

/**
 * Bulk-delete this admin's Image Generator runs by id — the run list's
 * multi-select delete (the Gallery's `POST /api/gallery/delete` precedent: a
 * body of ids, because a list of them does not belong in a URL).
 *
 * Owner-admin and self-scoped like every other Generator route: the service
 * matches `(id, owner)`, so a crafted body reaches only the caller's own runs
 * and a foreign or unknown id is simply absent from the count rather than an
 * error. The cap matches the list route's own maximum, so the client can never
 * hold more selected than one page can show.
 */
const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const POST = withOwnerAdmin(async (user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const result = await deleteImageGeneratorRuns(body.value.ids, user.id);
  return jsonOk(result);
});
