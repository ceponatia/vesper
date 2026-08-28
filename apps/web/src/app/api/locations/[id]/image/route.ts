import { and, desc, eq } from "drizzle-orm";
import { db, images, locations } from "@/server/db";
import { generateEntityImage } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonError, jsonOk, startJob, withUser } from "@/server/api";

type Params = { id: string };

async function ownsLocation(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, id), eq(locations.ownerId, ownerId)))
    .limit(1);
  return Boolean(row);
}

/** Latest image row for the location (newest first) — the studio polls this for status. */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  if (!(await ownsLocation(user.id, id))) return jsonError("not_found", "location not found", 404);
  const [image] = await db()
    .select()
    .from(images)
    .where(and(eq(images.ownerId, user.id), eq(images.entityKind, "location"), eq(images.entityId, id)))
    .orderBy(desc(images.createdAt))
    .limit(1);
  return jsonOk({ image: image ?? null });
});

/**
 * Generate (or regenerate) the location's establishing image as a background
 * `entity_image` job (docs/images/pipelines/entity-images.md). The image type
 * (landscape vs interior) follows the location's scale. Returns immediately;
 * the studio polls GET.
 */
export const POST = withUser<Params>(
  async (user, req, ctx) => {
    const { id } = await ctx.params;
    if (!(await ownsLocation(user.id, id))) return jsonError("not_found", "location not found", 404);

    const blocked = await imageRenderRejection(user, req);
    if (blocked) return blocked;

    const job = await startJob({
      type: "entity_image",
      ownerId: user.id,
      payload: { entityKind: "location", entityId: id },
      run: async () => ({ imageId: await generateEntityImage({ entityKind: "location", entityId: id, userId: user.id }) }),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, status: "pending" }, 202);
  },
  { limit: "image_generate" },
);
