import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import { probeLatestCandidate } from "@/server/images";

type Params = { modelId: string };

/**
 * Version-candidate probe (image-model-capabilities.spec.md §"Version candidate
 * and promotion flow"). Read-only despite the POST: it spends a Replicate
 * schema read, mutates nothing, and answers with the candidate version, the
 * field-level capability diff, per-enabled-profile findings, and whether latest
 * differs from the row's pin. POST rather than GET because it performs an
 * outbound provider call on every hit and must never be cached or prefetched.
 */
export const POST = withOwnerAdmin<Params>(async (_user, _req, ctx) => {
  const { modelId } = await ctx.params;
  const result = await probeLatestCandidate(modelId);
  if (!result.ok) {
    return result.code === "not_found"
      ? jsonError("not_found", result.message, 404)
      : jsonError("image_model.probe_failed", result.message, 400);
  }
  const { candidate, activatable, latestDiffers, diff, profiles } = result;
  return jsonOk({ candidate, activatable, latestDiffers, diff, profiles });
});
