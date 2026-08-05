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

  // A COMMUNITY model can only be run by version id: the bare-slug endpoint
  // (`/models/{owner}/{name}/predictions`) is official-models-only and 404s for
  // everything else. So pin it here rather than storing a row that saves
  // cleanly and then fails every render. Official models keep the bare slug and
  // go on tracking whatever Replicate publishes.
  const alreadyPinned = slug.includes(":");
  if (!probe.isOfficial && !alreadyPinned && !probe.versionId) {
    return jsonError(
      "image_model.unrunnable",
      `${slug} is a community model with no published version, so it cannot be run`,
      400,
    );
  }
  const storedSlug = !probe.isOfficial && !alreadyPinned ? `${slug}:${probe.versionId ?? ""}` : slug;

  // Re-check under the pinned name: the caller typed a bare slug, so the check
  // above could not have seen the row this add would collide with. Versions are
  // stable per model, so adding the same community model twice lands on the
  // same pinned slug and is caught here rather than at the unique index.
  if (storedSlug !== slug) {
    const [pinned] = await db()
      .select({ id: imageModels.id })
      .from(imageModels)
      .where(eq(imageModels.slug, storedSlug))
      .limit(1);
    if (pinned) return jsonError("image_model.duplicate", `${storedSlug} is already in the registry`, 409);
  }

  // A model that cannot edit can never serve the scene or variant surfaces, so
  // ticking those is silently a no-op rather than an error — the same rule the
  // pickers apply when listing.
  const row = {
    id: newId(),
    slug: storedSlug,
    label: body.value.label?.trim() || probe.label,
    canGenerate: probe.canGenerate,
    canEdit: probe.canEdit,
    referenceField: probe.referenceField,
    referenceArity: probe.referenceArity,
    // Uploaded file URLs are what all but one model wants; a wrapper that
    // cannot resolve them is found by running it, and switched on the row.
    referenceTransport: "file" as const,
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
