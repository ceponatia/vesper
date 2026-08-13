import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateEntityImagesBatch, missingEntityImageIds } from "@/server/images";
import { imageRenderRejection, jobCapRejection, jsonOk, readBody, startJob, withUser } from "@/server/api";

/** Optional id scope — the library sends the ids visible under the active filter. */
const batchBodySchema = z.object({ ids: z.array(z.string()).optional() });

/**
 * Most entities a single "Generate images" press can fan out over — the
 * per-user rate limit bounds request frequency, this bounds one request's
 * fan-out so an owner with thousands of imageless locations can't queue an
 * unbounded paid-render batch in a single call.
 */
const MAX_BATCH = 100;

/**
 * Generate images for the owned locations that lack one (docs/images/pipelines.md §Entity
 * images) — the library "Generate images" button. With `ids`, scopes to a
 * caller-supplied set; without it, every missing location. Runs in parallel
 * batches of 5 in a background job that survives navigation; returns how many
 * were queued. Locations that already have an image are skipped.
 */
export const POST = withUser(
  async (user, req: NextRequest) => {
    const body = await readBody(req, batchBodySchema);
    // A malformed body must 400, never widen the scope (codebase-review A4): the old
    // `body.ok ? {ids} : undefined` turned invalid JSON into "generate EVERY missing
    // location" — an unbounded-ish paid-render batch from a bad request.
    if (!body.ok) return body.response;
    const candidates = await missingEntityImageIds("location", user.id, { ids: body.value.ids });
    if (candidates.length === 0) return jsonOk({ queued: 0 });

    const ids = candidates.slice(0, MAX_BATCH);
    // The batch charges its real size against the daily budget and storage
    // headroom — one call here is `ids.length` paid renders, not one.
    const blocked = await imageRenderRejection(user, req, { count: ids.length });
    if (blocked) return blocked;

    const job = await startJob({
      type: "entity_image",
      ownerId: user.id,
      payload: { entityKind: "location", batch: ids.length },
      run: async () => ({ count: await generateEntityImagesBatch("location", ids, user.id) }),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, queued: ids.length }, 202);
  },
  { limit: "image_generate" },
);
