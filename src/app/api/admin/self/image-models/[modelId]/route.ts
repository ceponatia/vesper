import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { imageEditKindSchema, imageIdentityPreservationSchema, imageReferenceTransportSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { db, imageModels } from "@/server/db";
import { probeReplicateModel } from "@/server/ai";
import { imageModelProbeFields, loadImageModel } from "@/server/images";

type Params = { modelId: string };

/**
 * Edit or remove one registry row (image-model-registry.spec.md). Seeded rows
 * are ordinary rows here — `builtin` marks them for display but does not protect
 * them (owner ruling 4: the database is the single source of truth, so there is
 * no privileged second list hiding in the code).
 *
 * Deleting a model in use is deliberately allowed: stored picks are plain ids,
 * and `resolveImageProfile` degrades an unknown one to the task's default at
 * render time. Its profiles go with it on the row's delete cascade.
 */

const patchSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  maxReferences: z.number().int().min(0).max(64).optional(),
  /**
   * Owner-set, never probed: no Replicate schema says whether a model's wrapper
   * can resolve an uploaded file URL. Re-probing therefore leaves it alone.
   */
  referenceTransport: imageReferenceTransportSchema.optional(),
  /**
   * Owner-set, never probed — the same standing rule as `referenceTransport`, for a
   * harder reason: `canEdit` is true for anything with an image input, so only a
   * human who has looked at output can say whether this model follows an edit
   * instruction or repaints from noise. A re-probe must never overwrite this.
   */
  editKind: imageEditKindSchema.optional(),
  /**
   * Owner-set, never probed: whether a face survives a render is a judgment from
   * looking at images, and no Replicate schema contains it. This rating gates the
   * identity-critical tasks (`variant`, `scene`, `chat_look`), so a probe silently
   * resetting it to `unknown` would quietly re-enable a model for scene work that a
   * reviewer had ruled out.
   */
  identityPreservation: imageIdentityPreservationSchema.optional(),
  /**
   * Owner-written operator copy, never probed. Nullable rather than merely optional
   * so a warning can be CLEARED: omitting the key means "leave it alone", and
   * without an explicit `null` there would be no way to retract a caveat once the
   * upstream problem it describes is fixed. A blank string is the same intent as
   * `null` (an emptied textarea), so it normalizes rather than storing `''`, which
   * would read as "warned with nothing to say".
   */
  operatorWarning: z
    .union([
      z
        .string()
        .trim()
        .max(500)
        .transform((text) => text || null),
      z.null(),
    ])
    .optional(),
  forPortrait: z.boolean().optional(),
  forVariant: z.boolean().optional(),
  forScene: z.boolean().optional(),
  sort: z.number().int().min(0).max(9999).optional(),
  /** Re-read the model's schema from Replicate and refresh the capability columns. */
  reprobe: z.boolean().optional(),
  // `advancedCapabilities` is deliberately NOT settable here — but it IS probe-written
  // now (`imageModelProbeFields`), because the probe derives the LoRA input bindings
  // from the version's own schema. That is the honest owner: the bindings describe one
  // version's inputs, so they travel with `probedVersionId` and are refreshed by the
  // same re-probe that refreshes it. Hand-editing them through this form would create a
  // second, unversioned source for a field name the render path trusts.
});

export const PATCH = withOwnerAdmin<Params>(async (_user, req: NextRequest, ctx) => {
  const { modelId } = await ctx.params;
  const existing = await loadImageModel(modelId);
  if (!existing) return jsonError("not_found", "image model not found", 404);

  const body = await readBody(req, patchSchema);
  if (!body.ok) return body.response;
  const { reprobe, ...fields } = body.value;

  // Re-probing refreshes what the model CAN do; the surface toggles, the hand-set
  // reference cap, and the three reviewed judgments above are the owner's and are
  // never overwritten by it.
  //
  // The refreshed columns are `imageModelProbeFields`' list and nothing else, read
  // from the shared helper rather than restated here: a second list would be a
  // second answer to "what does a probe own", and the two would drift the first
  // time either gained a column. It includes the version those fields were read
  // FROM — recorded with them or not at all, since stored capabilities whose
  // version is unknown cannot be checked against a pinned `owner/name:version`
  // slug later, which is how a control keeps being sent to a field that moved
  // between versions.
  let probedFields = {};
  if (reprobe) {
    const probed = await probeReplicateModel(existing.slug);
    if (!probed.ok) return jsonError("image_model.probe_failed", probed.error, 400);
    probedFields = imageModelProbeFields(probed.probe);
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
