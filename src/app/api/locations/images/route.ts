import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateEntityImagesBatch, missingEntityImageIds } from "@/server/images";
import { GENERATION_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, startJob, withUser } from "@/server/api";

/** Optional id scope — the library sends the ids visible under the active filter. */
const batchBodySchema = z.object({ ids: z.array(z.string()).optional() }).catch({});

/**
 * Most entities a single "Generate images" press can fan out over — the
 * per-user rate limit bounds request frequency, this bounds one request's
 * fan-out so an owner with thousands of imageless locations can't queue an
 * unbounded paid-render batch in a single call.
 */
const MAX_BATCH = 100;

/**
 * Generate images for the owned locations that lack one (docs/images.md §Entity
 * images) — the library "Generate images" button. With `ids`, scopes to a
 * caller-supplied set; without it, every missing location. Runs in parallel
 * batches of 5 in a background job that survives navigation; returns how many
 * were queued. Locations that already have an image are skipped.
 */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, batchBodySchema);
  const candidates = await missingEntityImageIds("location", user.id, body.ok ? { ids: body.value.ids } : undefined);
  if (candidates.length === 0) return jsonOk({ queued: 0 });
  if (!rateLimit(`location_image:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many image generations; try again in a minute", 429);
  }
  const ids = candidates.slice(0, MAX_BATCH);
  const jobId = await startJob({
    type: "entity_image",
    payload: { entityKind: "location", batch: ids.length },
    run: async () => ({ count: await generateEntityImagesBatch("location", ids, user.id) }),
  });
  return jsonOk({ jobId, queued: ids.length }, 202);
});
