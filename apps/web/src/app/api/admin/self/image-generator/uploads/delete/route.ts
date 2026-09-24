import { z } from "zod";
import { jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { deleteImageGeneratorUploads } from "@/server/images";

/**
 * Bulk-delete this admin's Image Generator reference uploads by id — the
 * uploads panel's multi-select delete, shaped like the run list's
 * `runs/delete` (a body of ids, because a list of them does not belong in a
 * URL).
 *
 * Every id passes the single delete's own guards: owner, kind, and
 * `meta.source`, so a run's own output is never reachable, and an id that is
 * foreign or unknown is simply in neither list. An upload one of this admin's
 * runs still records as an input comes back in `inUse` rather than failing the
 * batch — the rest still go. The cap matches the uploads list's own maximum,
 * so the panel can never hold more selected than it shows.
 */
const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const POST = withOwnerAdmin(async (user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const result = await deleteImageGeneratorUploads(user.id, body.value.ids);
  return jsonOk(result);
});
