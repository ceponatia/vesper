import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { imageReferenceTransportSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { db, imageModels } from "@/server/db";
import { probeReplicateModel } from "@/server/ai";
import { loadImageModel } from "@/server/images";

type Params = { modelId: string };

/**
 * Edit or remove one registry row (image-model-registry.spec.md). Seeded rows
 * are ordinary rows here — `builtin` marks them for display but does not protect
 * them (owner ruling 4: the database is the single source of truth, so there is
 * no privileged second list hiding in the code).
 *
 * Deleting a model in use is deliberately allowed and needs no cascade: stored
 * picks are plain ids, and `resolveSurfaceModel` degrades an unknown one to the
 * surface default at render time.
 */

const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  maxReferences: z.number().int().min(0).max(64).optional(),
  /**
   * Owner-set, never probed: no Replicate schema says whether a model's wrapper
   * can resolve an uploaded file URL. Re-probing therefore leaves it alone.
   */
  referenceTransport: imageReferenceTransportSchema.optional(),
  forPortrait: z.boolean().optional(),
  forVariant: z.boolean().optional(),
  forScene: z.boolean().optional(),
  sort: z.number().int().min(0).max(9999).optional(),
  /** Re-read the model's schema from Replicate and refresh the capability columns. */
  reprobe: z.boolean().optional(),
});

export const PATCH = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId } = await ctx.params;
  const existing = await loadImageModel(modelId);
  if (!existing) return jsonError("not_found", "image model not found", 404);

  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;
  const { reprobe, ...fields } = body.value;

  // Re-probing refreshes what the model CAN do; the surface toggles and the
  // hand-set reference cap are the owner's and are never overwritten by it.
  let probedFields = {};
  if (reprobe) {
    const probed = await probeReplicateModel(existing.slug);
    if (!probed.ok) return jsonError("image_model.probe_failed", probed.error, 400);
    probedFields = {
      canGenerate: probed.probe.canGenerate,
      canEdit: probed.probe.canEdit,
      referenceField: probed.probe.referenceField,
      referenceArity: probed.probe.referenceArity,
      aspectMode: probed.probe.aspectMode,
      supportedAspects: probed.probe.supportedAspects,
      outputFormat: probed.probe.outputFormat,
      extraInput: probed.probe.extraInput,
    };
  }

  const update = { ...probedFields, ...fields };
  if (Object.keys(update).length === 0) return jsonOk({ model: existing });

  await db().update(imageModels).set(update).where(eq(imageModels.id, modelId));
  return jsonOk({ model: (await loadImageModel(modelId)) ?? existing });
});

export const DELETE = withOwnerAdmin<Params>(async (_user, _req, ctx) => {
  const { modelId } = await ctx.params;
  const existing = await loadImageModel(modelId);
  if (!existing) return jsonError("not_found", "image model not found", 404);
  await db().delete(imageModels).where(eq(imageModels.id, modelId));
  return jsonOk({ deleted: true, id: modelId });
});
