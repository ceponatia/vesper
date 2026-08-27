import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  emptyImageGeneratorControls,
  imageGeneratorCreateRunRequestSchema,
  imageGeneratorImageCount,
} from "@/contracts/images/image-generator";
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
  createImageGeneratorRun,
  deleteImageGeneratorRun,
  listImageGeneratorRuns,
  runImageGeneratorRun,
  toWireImageGeneratorRun,
} from "@/server/images";

/**
 * The Image Generator's run collection. Owner-admin and self-scoped: the
 * service resolves every model, image, and run against the requesting admin's
 * own id.
 */

/** A garbage limit degrades to the default — an admin list, not a contract. */
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).catch(50) });

/** This admin's runs, newest first. */
export const GET = withOwnerAdmin(async (user, req: NextRequest) => {
  const { limit } = listQuerySchema.parse({ limit: req.nextUrl.searchParams.get("limit") ?? undefined });
  return jsonOk({ runs: await listImageGeneratorRuns(user.id, limit) });
});

/**
 * Record one run AND start the render.
 *
 * The cost guard runs after body validation and before the row: an admission
 * refusal must not leave a `pending` record that never runs. `outputKind`
 * marks the render a hidden `generator_output`, so admission skips the visible
 * storage reservation while the provider budget still applies — charged by the
 * number of images asked for, because every registered model renders one image
 * per prediction and a run asking for four buys four of them. A budget that
 * charged one would let a single request spend four times its allowance.
 *
 * The job is started by the ROUTE, never the service: `@/server/api` imports
 * `@/server/images`, so a `startJob` call from the service would close an
 * import cycle — every image lane is arranged this way. A refused job slot
 * removes the just-created row, and the run's own report of what it learned
 * about the provider passes through `reportProviderOutcome`, because the
 * runner settles failures into its row and resolves regardless.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageGeneratorCreateRunRequestSchema);
  if (!body.ok) return body.response;

  const blocked = await imageRenderRejection(user, req, {
    outputKind: "generator_output",
    count: imageGeneratorImageCount(body.value.controls ?? emptyImageGeneratorControls()),
  });
  if (blocked) return blocked;

  const created = await createImageGeneratorRun({ ownerId: user.id, request: body.value });
  if (!created.ok) return jsonError(created.refusal.code, created.refusal.message, 400);

  const { run } = created;
  const job = await startJob({
    type: "generator_image",
    ownerId: user.id,
    payload: { runId: run.id },
    run: async ({ reportProviderOutcome }) => {
      const result = await runImageGeneratorRun(run.id, user.id);
      reportProviderOutcome(result.providerOutcome);
      return result;
    },
  });
  if (!job.ok) {
    // Undone through the service's own owner-scoped delete. Nothing rendered,
    // so there is no output to sweep.
    await deleteImageGeneratorRun(run.id, user.id);
    return jobCapRejection(job, user, req);
  }
  return jsonOk({ run: toWireImageGeneratorRun(run) }, 201);
});
