import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, images } from "@/server/db";
import { jsonError, jsonOk, readBody, withAuthorizedResource } from "@/server/api";
import { mergeRenderAdvisoryReview, ownedImageRow, type ImageRow } from "@/server/images";

type Params = { id: string };

const reviewRequestSchema = z.object({
  code: z.string().min(1),
  verdict: z.enum(["agree", "disagree"]),
  note: z.string().max(300).optional(),
});

/**
 * PATCH /api/images/:id/advisories — record the owner's agree/disagree
 * verdict on one render advisory this image measured.
 *
 * This is the human-judgment half of the advisory design: it never gates a
 * render and it never changes what is stored as the image, it only merges
 * `review: { verdict, note?, at }` onto the matching entry in
 * `images.meta.advisories` (`mergeRenderAdvisoryReview` owns that merge — a
 * second review REPLACES the first, never stacks). A code this image never
 * measured is a 404, the same shape as a missing or foreign image, because
 * both are "there is nothing here for you to review" from the caller's side.
 *
 * `withAuthorizedResource` uses the same "image" resolver as `images/[id]/file`;
 * a missing row and a row owned by someone else collapse to the same 404 before
 * this handler ever runs. Keeping the dynamic segment named `[id]` here is also
 * required by Next.js because sibling routes under `/api/images/:id/*` must use
 * one canonical slug name.
 *
 * The read-merge-write runs inside ONE transaction with the row locked
 * (`SELECT … FOR UPDATE`, the `character-save.ts` precedent): two requests
 * reviewing DIFFERENT codes on the same image at once must not both read the
 * same stale `meta` and let the last `UPDATE` overwrite the other's review.
 * Locking the row before reading it makes the second request wait for the
 * first's commit and merge over its actual result. `mergeRenderAdvisoryReview`
 * itself stays pure and unchanged — only what surrounds it is transactional.
 */
export const PATCH = withAuthorizedResource<Params, ImageRow>(
  "image",
  async (user, params) => ownedImageRow(params.id, user.id),
  async (user, row, req) => {
    const body = await readBody(req, reviewRequestSchema);
    if (!body.ok) return body.response;

    const outcome = await db().transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(images)
        .where(and(eq(images.id, row.id), eq(images.ownerId, user.id)))
        .for("update");
      if (!locked) return { ok: false as const, message: "image not found" };

      const merged = mergeRenderAdvisoryReview(locked.meta, body.value, new Date().toISOString());
      if (!merged.ok) return { ok: false as const, message: "advisory not found" };

      const [updated] = await tx
        .update(images)
        .set({ meta: merged.meta })
        .where(and(eq(images.id, row.id), eq(images.ownerId, user.id)))
        .returning({ id: images.id, meta: images.meta });
      if (!updated) return { ok: false as const, message: "image not found" };

      return { ok: true as const, advisory: merged.advisory };
    });

    if (!outcome.ok) return jsonError("not_found", outcome.message, 404);
    return jsonOk({ advisory: outcome.advisory });
  },
);
