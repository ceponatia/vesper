import type { NextRequest } from "next/server";
import { z } from "zod";
import { identityReferenceStrategySchema, trialVerdictValueSchema } from "@vesper/image-core";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { recordTrialVerdict } from "@/server/images";

type Params = { runId: string };

/**
 * What the caller decides; the service stamps the actor, the clock, and the
 * policy version in force. Composed from the contract vocabularies rather than
 * restated, so a verdict value or strategy this route accepts is by
 * construction one the stored `trialVerdictSchema` can carry.
 */
const trialVerdictRequestSchema = z.object({
  profileId: z.string().min(1),
  identityStrategy: identityReferenceStrategySchema,
  verdict: trialVerdictValueSchema,
  reason: z.string().trim().min(1).max(2000),
  /**
   * Rule with reviewable pairs still ungraded. Optional and never defaulted to
   * true: the absence of the flag must mean "I expect complete evidence", so a
   * client that has never heard of the gate cannot bypass it by omission.
   */
  overrideIncompleteReview: z.boolean().optional(),
});

/**
 * Record (or revise) one per-(profile, strategy) verdict
 * (image-identity-packs.spec.trial.md §"Version promotion"). The reason is
 * required for the same reason an admin override records one: a promotion with
 * no stated reason is indistinguishable from a mistake six months later.
 *
 * The response carries the run's settled status — when every combination
 * present in the rendered cells is ruled AND every reviewable pair is graded,
 * `review` becomes `complete` here, with no separate close action — plus the
 * full verdict list, so the summary screen updates from the write it just made
 * instead of racing a second read.
 *
 * Two refusals arrive as a 400 in the same envelope every other trial refusal
 * uses: `verdict_unknown_combo` for a combo no cell of the run carries, and
 * `review_incomplete` when the run is still executing or its pairs are still
 * ungraded. The second is what `overrideIncompleteReview` deliberately overrides
 * — the service records the flag on the ruling, so the override is visible in
 * the verdict list this route hands straight back.
 */
export const POST = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const { runId } = await ctx.params;
  const body = await readBody(req, trialVerdictRequestSchema);
  if (!body.ok) return body.response;

  const result = await recordTrialVerdict({ runId, ownerId: user.id, ...body.value });
  if (result === null) return jsonError("not_found", "trial run not found", 404);
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ runStatus: result.runStatus, verdicts: result.verdicts });
});
