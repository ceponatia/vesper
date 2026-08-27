import type { NextRequest } from "next/server";
import { imageModelProfileUpdateRequestSchema } from "@vesper/image-core";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { deleteImageModelProfile, updateImageModelProfile } from "@/server/images";

type Params = { modelId: string; profileId: string };

/**
 * Edit or remove one task profile. The cross-field rules a PATCH can break — an
 * operation the model cannot run, an override key the probe never declared, a
 * second enabled default for a task — are judged by the service against the
 * MERGED row, because this route cannot see the fields the request did not send.
 * Configuration validity is judged only when the merged row is ENABLED: a
 * disabled row accepts any schema-valid patch, which is what makes activation's
 * "disable that profile and retry" an action rather than advice.
 *
 * Deleting or disabling a task's only default is deliberately allowed:
 * resolution degrades to the next offered profile (or reports
 * `image_profile.none_offered`) by design, and stored picks are plain ids that
 * degrade the same way the model registry's always have.
 */

export const PATCH = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId, profileId } = await ctx.params;
  const body = await readBody(req, imageModelProfileUpdateRequestSchema);
  if (!body.ok) return body.response;

  const updated = await updateImageModelProfile(modelId, profileId, body.value);
  if (updated.ok) return jsonOk({ profile: updated.profile });
  switch (updated.code) {
    case "not_found":
      return jsonError("not_found", updated.message, 404);
    case "conflict":
      return jsonError("image_profile.conflict", updated.message, 409);
    case "invalid":
      return jsonError("image_profile.invalid", updated.message, 400);
  }
});

export const DELETE = withOwnerAdmin<Params>(async (_user, _req, ctx) => {
  const { modelId, profileId } = await ctx.params;
  if (!(await deleteImageModelProfile(modelId, profileId))) {
    return jsonError("not_found", "image model profile not found", 404);
  }
  return jsonOk({ deleted: true, id: profileId });
});
