import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  backpressureRejection,
  dailyBudgetRejection,
  jobCapRejection,
  jsonOk,
  missingFacetItemIds,
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

/** Items per model call, so a batch's real cost in text-lane units is derivable. */
const ITEMS_PER_CLASSIFY_CALL = 20;

/**
 * Backfill missing item facets (library-ux.plan.md §5) — the library
 * "Organize" button. Only items with an absent facet are touched, and only
 * their absent fields are written, so re-running is always safe. Runs as a
 * background job; the library grid polls and the facets appear as chunks land.
 */
export const POST = withUser(
  async (user, req: NextRequest) => {
    const body = await readBody(req, classifyBodySchema);
    if (!body.ok) return body.response;
    const candidates = await missingFacetItemIds(user.id, body.value.ids);
    if (candidates.length === 0) return jsonOk({ queued: 0 });

    const ids = candidates.slice(0, MAX_CLASSIFY);
    const shed = await backpressureRejection("text", user, req);
    if (shed) return shed;
    // Charged in model calls, not items: one press is a fan-out, and the budget
    // exists to bound what that fan-out actually spends.
    const overBudget = await dailyBudgetRejection(
      "provider_text_day",
      user,
      req,
      Math.ceil(ids.length / ITEMS_PER_CLASSIFY_CALL),
    );
    if (overBudget) return overBudget;

    const job = await startJob({
      type: "item_classify",
      ownerId: user.id,
      payload: { batch: ids.length },
      run: () => runItemClassify(user.id, ids),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    return jsonOk({ jobId: job.jobId, queued: ids.length }, 202);
  },
  { limit: "forge" },
);
