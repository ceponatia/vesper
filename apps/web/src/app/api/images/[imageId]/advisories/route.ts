import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, images } from "@/server/db";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { ownedImageRow, type ImageRow } from "@/server/images";
import { mergeRenderAdvisoryReview } from "@/server/images/render-advisories-review";

type Params = { imageId: string };

const reviewRequestSchema = z.object({
  code: z.string().min(1),
  verdict: z.enum(["agree", "disagree"]),
  note: z.string().max(300).optional(),
});

/**
 * PATCH /api/images/:imageId/advisories — record the owner's agree/disagree
 * verdict on one render advisory this image measured (issue #249).
 *
 * This is the human-judgment half of the advisory design: it never gates a
 * render and it never changes what is stored as the image, it only merges
 * `review: { verdict, note?, at }` onto the matching entry in
 * `images.meta.advisories` (`mergeRenderAdvisoryReview` owns that merge — a
 * second review REPLACES the first, never stacks). A code this image never
 * measured is a 404, the same shape as a missing or foreign image, because
 * both are "there is nothing here for you to review" from the caller's side.
 *
 * `withAuthorizedResource` on the same "image" resolver `images/[id]/file`
 * uses — a missing row and a row owned by someone else collapse to the same
 * 404 before this handler ever runs.
 */
export const PATCH = withAuthorizedResource<Params, ImageRow>(
  "image",
  async (user, params) => ownedImageRow(params.imageId, user.id),
  async (user, row, req) => {
    const body = await readBody(req, reviewRequestSchema);
    if (!body.ok) return body.response;

    const outcome = mergeRenderAdvisoryReview(row.meta, body.value, new Date().toISOString());
    if (!outcome.ok) return jsonError("not_found", "advisory not found", 404);

    const [updated] = await db()
      .update(images)
      .set({ meta: outcome.meta })
      .where(and(eq(images.id, row.id), eq(images.ownerId, user.id)))
      .returning({ id: images.id, meta: images.meta });
    if (!updated) return jsonError("not_found", "image not found", 404);

    return jsonOk({ advisory: outcome.advisory });
  },
);
