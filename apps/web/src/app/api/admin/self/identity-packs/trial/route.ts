import type { NextRequest } from "next/server";
import { imageIdentityPackTrialCreateRequestSchema } from "@vesper/image-core";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import {
  createIdentityPackTrialRun,
  ensureIdentityTrialModelVersions,
  listIdentityPackTrialRuns,
} from "@/server/images";

/**
 * The fixed identity-reference trial's run collection.
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
 *
 * Before the grid is planned, the route also performs one bounded setup step:
 * selected profiles whose model has no exact provider version are re-probed and
 * their mechanical capability/version columns are refreshed. This replaces the
 * old manual "visit Image models and re-probe every seed" prerequisite while
 * preserving the trial's hard rule that an unpinnable model cannot produce
 * evidence. A probe failure returns before a useless run is created.
 *
 * The response is the run id and its per-status cell counts; per-cell detail is
 * the run-detail route's job.
 */
export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const body = await readBody(req, imageIdentityPackTrialCreateRequestSchema);
  if (!body.ok) return body.response;

  const versions = await ensureIdentityTrialModelVersions(body.value.profileIds);
  if (versions.failures.length > 0) {
    const first = versions.failures[0];
    const remainder = versions.failures.length - 1;
    return jsonError(
      "identity_pack_trial.version_probe_failed",
      `${first?.slug ?? "A selected model"} could not be pinned: ${first?.error ?? "unknown probe failure"}${
        remainder > 0 ? ` (${remainder} more model${remainder === 1 ? "" : "s"} also failed)` : ""
      }`,
      400,
    );
  }

  const result = await createIdentityPackTrialRun({ ownerId: user.id, request: body.value });
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ runId: result.runId, counts: result.counts });
});

/** Every run this admin owns, newest first — labels, statuses and counts only. */
export const GET = withOwnerAdmin(async (user) => jsonOk({ runs: await listIdentityPackTrialRuns(user.id) }));
