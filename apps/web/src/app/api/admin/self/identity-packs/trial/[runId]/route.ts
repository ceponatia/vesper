import { jsonError, jsonOk, withOwnerAdmin } from "@/server/api";
import { deleteIdentityPackTrialRun, getIdentityPackTrialRunDetail } from "@/server/images";

type Params = { runId: string };

/**
 * One trial run with every cell — specs, statuses, results. Ids and measurements
 * only, never bytes or URLs: rendered outputs are named by image id and fetched,
 * if at all, through the authorized image route, the same privacy boundary every
 * identity-pack admin surface keeps.
 *
 * A run that is not this admin's answers the same 404 a nonexistent one does —
 * the service's `(id, owner)` selection is the authorization root, and the route
 * never confirms a foreign run exists.
 */
export const GET = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { runId } = await ctx.params;
  const detail = await getIdentityPackTrialRunDetail(runId, user.id);
  if (detail === null) return jsonError("not_found", "trial run not found", 404);
  return jsonOk(detail);
});

/**
 * Hard-delete a run: its rows and every output image it produced. The count of
 * swept outputs is reported so the operator can see the storage actually freed.
 */
export const DELETE = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { runId } = await ctx.params;
  const result = await deleteIdentityPackTrialRun(runId, user.id);
  if (!result.deleted) return jsonError("not_found", "trial run not found", 404);
  return jsonOk(result);
});
