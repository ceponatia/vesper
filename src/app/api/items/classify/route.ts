import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  GENERATION_RATE_LIMIT,
  jsonError,
  jsonOk,
  missingFacetItemIds,
  rateLimit,
  readBody,
  runItemClassify,
  startJob,
  withUser,
} from "@/server/api";

/** Optional id scope — the library sends the ids visible under the active filter. */
const classifyBodySchema = z.object({ ids: z.array(z.string()).optional() });

/**
 * One press can classify at most this many items (10 model calls of 20) — the
 * rate limit bounds request frequency, this bounds a single request's fan-out.
 */
const MAX_CLASSIFY = 200;

/**
 * Backfill missing item facets (library-ux.plan.md §5) — the library
 * "Organize" button. Only items with an absent facet are touched, and only
 * their absent fields are written, so re-running is always safe. Runs as a
 * background job; the library grid polls and the facets appear as chunks land.
 */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, classifyBodySchema);
  if (!body.ok) return body.response;
  const candidates = await missingFacetItemIds(user.id, body.value.ids);
  if (candidates.length === 0) return jsonOk({ queued: 0 });
  if (!rateLimit(`item_classify:${user.id}`, GENERATION_RATE_LIMIT)) {
    return jsonError("rate_limited", "an organize pass just ran; try again in a minute", 429);
  }
  const ids = candidates.slice(0, MAX_CLASSIFY);
  const jobId = await startJob({
    type: "item_classify",
    payload: { batch: ids.length },
    run: () => runItemClassify(user.id, ids),
  });
  return jsonOk({ jobId, queued: ids.length }, 202);
});
