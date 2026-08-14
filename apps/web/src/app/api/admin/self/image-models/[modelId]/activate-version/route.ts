import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { activateCandidateVersion } from "@/server/images";

type Params = { modelId: string };

/**
 * Candidate activation (image-model-capabilities.spec.md §"Version candidate
 * and promotion flow"): re-probe the EXACT named version, refuse while any
 * enabled profile would stop being runnable on it, then atomically pin the row
 * (`slug` → `path:version`, `probedVersionId`, the probe-owned capability
 * columns, `updatedAt`). Reviewed judgments are never touched.
 *
 * The 409 carries the per-profile findings beside the standard error envelope
 * (the identity-pack `identityPackFailure` precedent): the admin has to see
 * WHICH profile blocks and why, and a second probe round-trip to rediscover
 * that would race the provider state that just refused.
 */

const bodySchema = z.object({
  /** Same conservative charset as the smoke-test body — this value becomes part
   * of the stored slug, so it must never carry a `/` or `:`. */
  versionId: z.string().min(1).max(128).regex(/^[\w.-]+$/),
});

export const POST = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId } = await ctx.params;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const result = await activateCandidateVersion(modelId, body.value);
  if (!result.ok) {
    switch (result.code) {
      case "not_found":
        return jsonError("not_found", result.message, 404);
      case "version_unavailable":
        return jsonError("image_model.version_unavailable", result.message, 400);
      case "activation_blocked":
        return jsonOk(
          {
            error: { code: "image_model.activation_blocked", message: result.message },
            profiles: result.profiles,
          },
          409,
        );
    }
  }
  return jsonOk({ model: result.model, profiles: result.profiles });
});
