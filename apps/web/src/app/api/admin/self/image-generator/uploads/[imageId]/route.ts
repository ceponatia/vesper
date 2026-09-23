import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import { deleteImageGeneratorUpload } from "@/server/images";

type Params = { imageId: string };

/**
 * One Image Generator reference upload — never a run's own output (#635). A
 * run's `generator_output` row shares the same `kind` but not the
 * `meta.source` this delete requires, so it can never be reached here even
 * given its exact id: {@link deleteImageGeneratorUpload} guards on both.
 *
 * An id that is not this admin's, not present, not a `generator_output`, or a
 * run's own render all answer the same 404 — the service's `(id, owner, kind,
 * source)` selection is the authorization root, and the route never confirms
 * which of the four it was.
 */
export const DELETE = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { imageId } = await ctx.params;
  const deleted = await deleteImageGeneratorUpload(user.id, imageId);
  if (!deleted) return jsonError("not_found", "upload not found", 404);
  return jsonOk({ ok: true });
});
