import type { NextRequest } from "next/server";
import { imageLabExtractControlsRequestSchema } from "@/contracts";
import { imageRenderRejection, jobCapRejection, jsonOk, readBody, startJob, withOwnerAdmin } from "@/server/api";
import { imageLabPreprocessorFor, runImageLabControlExtraction } from "@/server/images";

/**
 * Extract control fixtures from existing renders — one `lab_control_extract` job
 * per source image (qwen-advanced-image-subsystem.spec.md §"Control
 * extraction").
 *
 * The cost guard is charged for the whole batch BEFORE any job starts, sized to
 * the number of PAID PROVIDER CALLS the batch will make: every source image runs
 * one preprocessor per requested pose/depth kind, so the charge is sources ×
 * paid kinds, not sources. Charging per source under-charged the daily image
 * budget by a factor of the kind count — a four-source, two-kind request is
 * eight preprocessor runs, and a budget that counted four would let the next
 * request through on spend that was already gone.
 *
 * Edge pays NOTHING: it is a sharp convolution in this process, and billing a
 * daily provider budget for local work would make the number stop meaning what
 * it says. An edge-only batch therefore charges no provider units and still
 * passes the guard, whose own floor of one keeps the storage reservation and the
 * backpressure check honest. Which kinds are paid is not restated here —
 * `imageLabPreprocessorFor` already answers it, and a kind with no pin is by
 * definition the one nobody is billed for.
 *
 * The jobs are started by the ROUTE rather than the service: `@/server/api`
 * imports `@/server/images`, so a `startJob` call from the extraction service
 * would close an import cycle. `queued` counts the jobs that actually started —
 * a per-user job-slot refusal partway through a batch stops the batch and
 * reports the house 429, with the already-started jobs left to finish, because
 * cancelling live provider work to make a count tidy would waste the very spend
 * the cap exists to bound.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageLabExtractControlsRequestSchema);
  if (!body.ok) return body.response;

  const { sourceImageIds, controlKinds, note } = body.value;
  const paidKinds = controlKinds.filter((kind) => imageLabPreprocessorFor(kind) !== null);
  const blocked = await imageRenderRejection(user, req, { count: sourceImageIds.length * paidKinds.length });
  if (blocked) return blocked;

  let queued = 0;
  for (const sourceImageId of sourceImageIds) {
    const job = await startJob({
      type: "lab_control_extract",
      ownerId: user.id,
      payload: { sourceImageId, controlKinds },
      run: () =>
        runImageLabControlExtraction({
          ownerId: user.id,
          sourceImageId,
          controlKinds,
          ...(note ? { note } : {}),
        }),
    });
    if (!job.ok) return jobCapRejection(job, user, req);
    queued += 1;
  }
  return jsonOk({ queued }, 202);
});
