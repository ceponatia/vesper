import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { smokeTestCandidate } from "@/server/images";

type Params = { modelId: string };

/**
 * Candidate smoke test (image-model-capabilities.spec.md §"Version candidate
 * and promotion flow"): ONE transient render pinned to the named version
 * through the selected profile. Cost-bearing and explicit — a real prediction
 * is spent — and nothing persists: no images row, no file, the buffer is
 * measured and dropped. Never called from any gate or automated test.
 */

const bodySchema = z.object({
  /** A Replicate version id — a conservative token charset so a crafted value
   * can never smuggle a second path segment or pin separator into a slug. */
  versionId: z.string().min(1).max(128).regex(/^[\w.-]+$/),
  profileId: z.string().min(1).max(200),
});

export const POST = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId } = await ctx.params;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const result = await smokeTestCandidate(modelId, body.value);
  if (!result.ok) {
    if (result.code === "smoke_failed") {
      const detail = result.predictionId ? ` (prediction ${result.predictionId})` : "";
      return jsonError("image_model.smoke_failed", `${result.message}${detail}`, 502);
    }
    return jsonError("not_found", result.message, 404);
  }
  const { predictionId, executedVersionId, durationMs, imageBytes, width, height } = result;
  return jsonOk({ smoke: { predictionId, executedVersionId, durationMs, imageBytes, width, height } });
});
