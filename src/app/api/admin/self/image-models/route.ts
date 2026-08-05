import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { imageModelSurfaces } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { db, imageModels } from "@/server/db";
import { probeReplicateModel } from "@/server/ai";
import { loadImageModels } from "@/server/images";
import { newId } from "@/lib/ids";

/**
 * The image-model registry's admin surface (image-model-registry.spec.md).
 * Owner-admin only, and only beneath `/api/admin/self` — `withOwnerAdmin` fails
 * closed with a hidden 404 anywhere else, so the client-side gate on the
 * settings page is UX rather than security.
 *
 * GET lists every row. POST adds one by Replicate slug, deriving its
 * capabilities from a live schema probe.
 */

const createSchema = z.object({
  /** `owner/name`, optionally `owner/name:version` to pin. */
  slug: z.string().trim().min(3).max(200),
  label: z.string().trim().max(120).optional(),
  surfaces: z.array(z.enum(imageModelSurfaces)).max(3).default([]),
  /** Overrides the probe's prose-derived starting value. */
  maxReferences: z.number().int().min(0).max(64).optional(),
});

export const GET = withOwnerAdmin(async () => {
  return jsonOk({ models: await loadImageModels() });
});

export const POST = withOwnerAdmin(async (_user, req: NextRequest) => {
  const body = await readBody(req, createSchema);
  if (!body.ok) return body.response;
  const { slug, surfaces } = body.value;

  const [existing] = await db().select({ id: imageModels.id }).from(imageModels).where(eq(imageModels.slug, slug)).limit(1);
  if (existing) return jsonError("image_model.duplicate", `${slug} is already in the registry`, 409);

  // The one place this feature fails loudly instead of degrading: writing a row
  // we cannot render with would move the failure to render time, where it costs
  // a player-visible image instead of a form error.
  const probed = await probeReplicateModel(slug);
  if (!probed.ok) return jsonError("image_model.probe_failed", probed.error, 400);
  const probe = probed.probe;

  // A model that cannot edit can never serve the scene or variant surfaces, so
  // ticking those is silently a no-op rather than an error — the same rule the
  // pickers apply when listing.
  const row = {
    id: newId(),
    slug,
    label: body.value.label?.trim() || probe.label,
    canGenerate: probe.canGenerate,
    canEdit: probe.canEdit,
    referenceField: probe.referenceField,
    referenceArity: probe.referenceArity,
    maxReferences: body.value.maxReferences ?? probe.maxReferences,
    aspectMode: probe.aspectMode,
    supportedAspects: probe.supportedAspects,
    outputFormat: probe.outputFormat,
    extraInput: probe.extraInput,
    forPortrait: surfaces.includes("portrait"),
    forVariant: surfaces.includes("variant"),
    forScene: surfaces.includes("scene"),
    builtin: false,
    // New rows sort after the seeded set, whose sorts are 10..60.
    sort: 100,
  };
  await db().insert(imageModels).values(row);
  return jsonOk({ model: row, versionId: probe.versionId }, 201);
});
