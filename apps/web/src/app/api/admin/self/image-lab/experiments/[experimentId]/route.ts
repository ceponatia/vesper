import type { NextRequest } from "next/server";
import { imageLabRecordVerdictRequestSchema } from "@vesper/image-core";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import {
  deleteImageLabExperiment,
  getImageLabExperimentDetail,
  recordImageLabVerdict,
} from "@/server/images";

type Params = { experimentId: string };

/**
 * One Advanced Image Lab experiment: what was sent, what came back, and what the
 * reviewing admin ruled.
 *
 * Ids only, never bytes or URLs — the result and its references are named by
 * image id and fetched, if at all, through the authorized image file route, the
 * same privacy boundary every image admin surface keeps.
 *
 * An experiment that is not this admin's answers the same 404 a nonexistent one
 * does: the service's `(id, owner)` selection is the authorization root, and the
 * route never confirms a foreign experiment exists.
 */
export const GET = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { experimentId } = await ctx.params;
  const experiment = await getImageLabExperimentDetail(experimentId, user.id);
  if (experiment === null) return jsonError("not_found", "experiment not found", 404);
  return jsonOk({ experiment });
});

/**
 * Record the probe verdict — the one fact the whole Stage 0 protocol exists to
 * produce, and the one no provider schema can produce: whether the output's
 * limbs match the skeleton is a judgment made by looking at the image.
 *
 * The note is required by the request schema, because a ruling with nothing
 * written beside it is indistinguishable from a misclick six months later, and
 * this ruling decides whether the plan runs on 2511 or on a second connector.
 */
export const PATCH = withOwnerAdmin<Params>(async (user, req: NextRequest, ctx) => {
  const { experimentId } = await ctx.params;
  const body = await readBody(req, imageLabRecordVerdictRequestSchema);
  if (!body.ok) return body.response;

  const result = await recordImageLabVerdict(experimentId, user.id, body.value);
  if (result === null) return jsonError("not_found", "experiment not found", 404);
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message, 400);
  return jsonOk({ experiment: result.experiment });
});

/** Hard-delete the experiment and the hidden render it produced. Fixtures stay — they are shared bench equipment. */
export const DELETE = withOwnerAdmin<Params>(async (user, _req, ctx) => {
  const { experimentId } = await ctx.params;
  const result = await deleteImageLabExperiment(experimentId, user.id);
  if (!result.deleted) return jsonError("not_found", "experiment not found", 404);
  return jsonOk({ ok: true });
});
