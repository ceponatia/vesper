import type { NextRequest } from "next/server";
import { imageIdentityPackTrialExecuteRequestSchema } from "@/contracts";
import { imageRenderRejection, jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { executeIdentityPackTrialCells } from "@/server/images";

type Params = { runId: string };

/**
 * One bounded execution pass over a run's planned cells
 * (image-identity-packs.spec.trial.md §"Execution"). This is the surface where
 * the trial spends money, so THIS route owns the guard function — the service
 * cannot call `imageRenderRejection` itself, because the guard needs the
 * request and its user — but the service decides WHEN to invoke it and for HOW
 * MANY cells: inside the run lock, sized to exactly the planned cells the pass
 * picked. Charging here, before the service ran, billed passes the lock then
 * refused (`run_locked`) or that found nothing to run, with no refund path.
 *
 * A pass that picks zero cells never charges: reviewing and re-reading a
 * finished grid must not cost render budget, and must keep working after the
 * daily budget is spent.
 *
 * `run_locked` (a second click while a pass renders) comes back as a 400 like
 * every other trial refusal; a budget or backpressure rejection is the guard's
 * own Response, passed through untouched so the 429/503 shapes every render
 * route shares stay identical here.
 */
export const POST = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const { runId } = await ctx.params;
  const body = await readBody(req, imageIdentityPackTrialExecuteRequestSchema);
  if (!body.ok) return body.response;

  const result = await executeIdentityPackTrialCells({
    runId,
    ownerId: user.id,
    maxRenders: body.value.maxRenders,
    // Default per-render reservation: the guard multiplies its reserve by
    // `count` itself, so passing a pre-multiplied number would square it.
    chargeBudget: (count) => imageRenderRejection(user, req, { count }),
  });
  if (result === null) return jsonError("not_found", "trial run not found", 404);
  if (!result.ok) {
    if ("budgetRejected" in result) return result.budgetRejected;
    return jsonError(result.refusal.code, result.refusal.message, 400);
  }
  return jsonOk({ executed: result.executed, remainingPlanned: result.remainingPlanned, runStatus: result.runStatus });
});
