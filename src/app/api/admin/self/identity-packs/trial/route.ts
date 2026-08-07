import type { NextRequest } from "next/server";
import { imageIdentityPackTrialCreateRequestSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { createIdentityPackTrialRun, listIdentityPackTrialRuns } from "@/server/images";

/**
 * The fixed identity-reference trial's run collection
 * (image-identity-packs.spec.trial.md; design doc Wave 3).
 *
 * Owner-admin and self-scoped like the batch route beside it: the service
 * resolves every character against the requesting admin's own id, so a run can
 * only ever compare the caller's characters, and one that names someone else's
 * records those cells refused exactly as it would a character that does not
 * exist.
 *
 * Planning spends nothing — a create refusal (unknown corpus, unknown fixture, a
 * pack-revision selector naming a character the run does not include, a grid past
 * the cell ceiling) is a 400 describing the configuration, and a planned run sits
 * in `draft` until an execute click charges the render budget.
 * The response is the run id and its per-status cell counts; per-cell detail is
 * the run-detail route's job.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageIdentityPackTrialCreateRequestSchema);
  if (!body.ok) return body.response;

  const result = await createIdentityPackTrialRun({ ownerId: user.id, request: body.value });
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ runId: result.runId, counts: result.counts });
});

/** Every run this admin owns, newest first — labels, statuses and counts only. */
export const GET = withOwnerAdmin(async (user) => jsonOk({ runs: await listIdentityPackTrialRuns(user.id) }));
