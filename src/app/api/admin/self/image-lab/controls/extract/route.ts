import type { NextRequest } from "next/server";
import { imageLabExtractControlsRequestSchema } from "@/contracts";
import { imageRenderRejection, jobCapRejection, jsonOk, readBody, startJob, withOwnerAdmin } from "@/server/api";
import { runImageLabControlExtraction } from "@/server/images";

/**
 * Extract control fixtures from existing renders — one `lab_control_extract` job
 * per source image (qwen-advanced-image-subsystem.spec.md §"Control
 * extraction").
 *
 * The cost guard is charged for the whole batch BEFORE any job starts, sized to
 * the number of source images, because pose and depth are paid provider calls.
 * Edge is computed in process and pays nothing, but it never travels alone in a
 * way worth splitting the guard over: a request naming only `edge` is charged
 * one unit per source image and that is a rounding error against a bench that
 * spends its budget on renders.
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
  const blocked = await imageRenderRejection(user, req, { count: sourceImageIds.length });
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
