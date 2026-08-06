import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import { identityPackTrialSummary } from "@/server/images";

type Params = { runId: string };

/**
 * The run's unblinded aggregates, its rendered (profile, strategy) combinations
 * — the verdict slots — plus every verdict recorded so far
 * (image-identity-packs.spec.trial.md §"Promotion rules"). Read-only and safe
 * to serve mid-review: grades are stored already unblinded in canonical A/B
 * space, so this route computes over what exists and shows the sample size
 * behind every mean rather than waiting for the queue to empty.
 */
export const GET = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { runId } = await ctx.params;
  const summary = await identityPackTrialSummary(runId, user.id);
  if (summary === null) return jsonError("not_found", "trial run not found", 404);
  return jsonOk(summary);
});
