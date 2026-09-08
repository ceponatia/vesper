import type { NextRequest } from "next/server";
import {
  backpressureRejection,
  dailyBudgetRejection,
  jobCapRejection,
  jsonError,
  jsonOk,
  readBody,
  retryAuthoringRunSchema,
  retryCharacterAuthoringRun,
  resolveOwnedCharacterAuthoringRun,
  withAuthorizedResource,
} from "@/server/api";

type Params = { runId: string };

export const POST = withAuthorizedResource<Params, NonNullable<Awaited<ReturnType<typeof resolveOwnedCharacterAuthoringRun>>>>("character authoring run", async (user, params) => (
  resolveOwnedCharacterAuthoringRun(user.id, params.runId)
), async (user, _run, req: NextRequest, ctx) => {
  const { runId } = await ctx.params;
  const body = await readBody(req, retryAuthoringRunSchema);
  if (!body.ok) return body.response;
  const outcome = await retryCharacterAuthoringRun(user.id, runId, body.value.requestId, async () => {
    const shed = await backpressureRejection("text", user, req);
    if (shed) return shed;
    return dailyBudgetRejection("provider_text_day", user, req);
  });
  if (outcome.status === "accepted") return jsonOk({ run: outcome.run }, 202);
  if (outcome.status === "capacity") return jobCapRejection(outcome, user, req);
  if (outcome.status === "admission") return outcome.response;
  if (outcome.status === "not_found") return jsonError("not_found", "authoring run not found", 404);
  if (outcome.status === "portrait_source_changed") return jsonError("portrait_source_changed", "the portrait or relevant appearance details changed; start a new portrait read", 409);
  return jsonError("idempotency_conflict", "this run id already names a different request", 409);
}, { limit: "forge" });
