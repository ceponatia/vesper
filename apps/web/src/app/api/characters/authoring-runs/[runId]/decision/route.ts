import type { NextRequest } from "next/server";
import {
  decideAuthoringRunSchema,
  decideCharacterAuthoringRun,
  jsonError,
  jsonOk,
  readBody,
  withUser,
} from "@/server/api";

type Params = { runId: string };

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { runId } = await ctx.params;
  const body = await readBody(req, decideAuthoringRunSchema);
  if (!body.ok) return body.response;
  const outcome = await decideCharacterAuthoringRun(user.id, runId, body.value);
  if (outcome.status === "accepted") return jsonOk({ run: outcome.run });
  if (outcome.status === "not_found") return jsonError("not_found", "authoring run not found", 404);
  if (outcome.status === "invalid_run") return jsonError("invalid_run", "this authoring run cannot be decided", 409);
  if (outcome.status === "proposal_changed") return jsonError("proposal_changed", "this proposal was already decided in another session", 409);
  return jsonOk({
    error: { code: "authoring_conflict", message: "Saved edits overlap this proposal. Review the latest values and choose which to keep." },
    conflicts: outcome.conflicts ?? [],
    authoringRevision: outcome.currentRevision,
  }, 409);
}, { limit: "forge" });
