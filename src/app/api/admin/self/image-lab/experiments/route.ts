import type { NextRequest } from "next/server";
import { imageLabCreateExperimentRequestSchema } from "@/contracts";
import {
  imageRenderRejection,
  jobCapRejection,
  jsonError,
  jsonOk,
  readBody,
  startJob,
  withOwnerAdmin,
} from "@/server/api";
import {
  createImageLabExperiment,
  deleteImageLabExperiment,
  listImageLabExperiments,
  runImageLabExperiment,
} from "@/server/images";

/**
 * The Advanced Image Lab's experiment collection
 * (qwen-advanced-image-subsystem.spec.md §"Code organization").
 *
 * Owner-admin and self-scoped like the identity-trial routes beside it: the
 * service resolves every character, chat, input image and fixture against the
 * requesting admin's own id, so an experiment can only ever be about the
 * caller's own material.
 */

/** This admin's experiments, newest first — the lab page's whole listing query. */
export const GET = withOwnerAdmin(async (user) => jsonOk({ experiments: await listImageLabExperiments(user.id) }));

/**
 * Record one experiment AND start the render.
 *
 * The cost guard runs FIRST — before the row, before the job — because it is the
 * only thing here that can refuse on grounds of money, and an experiment
 * recorded against a spent daily budget would be a `pending` row that never
 * runs.
 *
 * The job is started by the ROUTE rather than by the service: `@/server/api`
 * imports `@/server/images`, so a `startJob` call from the lab service would
 * close an import cycle. Every image lane is arranged this way. A refused job
 * slot removes the experiment again — an admin who was told "too many jobs"
 * should not be left with a record of a run that never happened.
 *
 * The run also reports what it learned about the image provider. The runner
 * settles every failure into its own row and resolves regardless, so the job
 * runner's default reading — resolved means the provider answered — would tell
 * the circuit breaker a dead Replicate was healthy, and would tell it the same
 * about a probe refused before it ever called one.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageLabCreateExperimentRequestSchema);
  if (!body.ok) return body.response;

  const blocked = await imageRenderRejection(user, req);
  if (blocked) return blocked;

  const created = await createImageLabExperiment({ ownerId: user.id, request: body.value });
  if (!created.ok) return jsonError(created.refusal.code, created.refusal.message, 400);

  const { experiment } = created;
  const job = await startJob({
    type: "lab_image",
    ownerId: user.id,
    payload: { experimentId: experiment.id, kind: experiment.kind },
    run: async ({ reportProviderOutcome }) => {
      const result = await runImageLabExperiment(experiment.id, user.id);
      reportProviderOutcome(result.providerOutcome);
      return result;
    },
  });
  if (!job.ok) {
    // Undone through the service's own owner-scoped delete, never a hand-built
    // predicate. Nothing was rendered, so there is no output to sweep.
    await deleteImageLabExperiment(experiment.id, user.id);
    return jobCapRejection(job, user, req);
  }
  return jsonOk({ experiment }, 201);
});
