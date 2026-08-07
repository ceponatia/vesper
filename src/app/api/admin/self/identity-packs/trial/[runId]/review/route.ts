import type { NextRequest } from "next/server";
import { imageIdentityPackTrialGradeRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { nextUnreviewedTrialPair, submitTrialPairGrade } from "@/server/images";

type Params = { runId: string };

/**
 * The blinded review queue (image-identity-packs.spec.trial.md §"Review
 * procedure").
 *
 * GET serves the next unreviewed pair — two image ids, the shared task and
 * prompt fixture, and deliberately NOTHING strategy-shaped: the reviewer must
 * not know which reference strategy produced which side. An empty queue is
 * `{ pair: null }` on a 200, not a 404 — "every pair is graded" is a state of
 * the run the client renders, while 404 stays reserved for a run that is not
 * this admin's.
 *
 * POST records one submission in LEFT/RIGHT space; the server unblinds it with
 * the pair's derived mapping before storing. The response is a receipt plus the
 * run's settled status — and deliberately NOT the mapping, which would hand the
 * reviewer the one bit this surface exists to withhold. `runStatus` rides along
 * because grading the last pair is one of the two writes that can complete a
 * run, so a client that only re-read the run on a verdict would show `review` on
 * a run that just finished. A duplicate grade is a loud `grade_conflict`, and an
 * unknown pair id collapses into the same 404 as an unknown run.
 */
export const GET = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { runId } = await ctx.params;
  const result = await nextUnreviewedTrialPair(runId, user.id);
  if (result === null) return jsonError("not_found", "trial run not found", 404);
  return jsonOk(result);
});

export const POST = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const { runId } = await ctx.params;
  const body = await readBody(req, imageIdentityPackTrialGradeRequestSchema);
  if (!body.ok) return body.response;

  const result = await submitTrialPairGrade({ runId, ownerId: user.id, request: body.value });
  if (result === null) return jsonError("not_found", "trial pair not found", 404);
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ recorded: true, runStatus: result.runStatus });
});
