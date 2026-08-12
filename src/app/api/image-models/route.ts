import type { NextRequest } from "next/server";
import { imageModelsForSurface, type ImageModelSurface, imageModelSurfaces } from "@vesper/image-core";
import { jsonOk, withUser } from "@/server/api";
import { loadImageModels } from "@/server/images";

/**
 * The model list the pickers read (image-model-registry.plan.md). Ordinary
 * users, not admins: choosing which registered model paints your scene is a
 * normal affordance — only MANAGING the list is admin-only, under
 * `/api/admin/self/image-models`.
 *
 * `?surface=portrait|variant|scene` filters to what that picker may offer,
 * combining the stored toggle with the capability it implies, so an edit-only
 * model never appears where an image must be made from nothing. An absent or
 * unrecognized surface returns everything, which is what the settings page wants.
 */
export const GET = withUser(async (_user, req: NextRequest) => {
  const requested = new URL(req.url).searchParams.get("surface");
  const surface = (imageModelSurfaces as readonly string[]).includes(requested ?? "")
    ? (requested as ImageModelSurface)
    : null;
  const models = await loadImageModels();
  return jsonOk({ models: surface ? imageModelsForSurface(models, surface) : models });
});
