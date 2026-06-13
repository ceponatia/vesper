import type { NextRequest } from "next/server";
import { z } from "zod";
import { generateEntityImagesBatch, missingEntityImageIds } from "@/server/images";
import { jsonOk, readBody, startJob, withUser } from "@/server/api";

/** Optional id scope — the library sends the ids visible under the active filter. */
const batchBodySchema = z.object({ ids: z.array(z.string()).optional() }).catch({});

/**
 * Generate images for the owned items that lack one (docs/images.md §Entity
 * images) — the library "Generate images" button. With `ids`, scopes to the
 * selected type bucket; without it, every missing item. Runs in parallel
 * batches of 5 in a background job that survives navigation; returns how many
 * were queued. Items that already have an image are skipped.
 */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, batchBodySchema);
  const ids = await missingEntityImageIds("item", user.id, body.ok ? { ids: body.value.ids } : undefined);
  if (ids.length === 0) return jsonOk({ queued: 0 });
  const jobId = await startJob({
    type: "entity_image",
    payload: { entityKind: "item", batch: ids.length },
    run: async () => ({ count: await generateEntityImagesBatch("item", ids, user.id) }),
  });
  return jsonOk({ jobId, queued: ids.length }, 202);
});
