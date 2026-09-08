import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  authoringTargetSchema,
  backpressureRejection,
  dailyBudgetRejection,
  jobCapRejection,
  jsonError,
  jsonOk,
  listCharacterAuthoringRuns,
  readBody,
  startAuthoringRunSchema,
  startCharacterAuthoringRun,
  withUser,
} from "@/server/api";

const listQuerySchema = z.object({
  targetKind: z.enum(["creation", "character"]),
  targetId: z.string().min(1).max(128),
});

export const GET = withUser(async (user, req: NextRequest) => {
  const query = listQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) return jsonError("invalid_query", "invalid authoring-run target", 400);
  const target = authoringTargetSchema.parse({ kind: query.data.targetKind, id: query.data.targetId });
  return jsonOk(await listCharacterAuthoringRuns(user.id, target));
});

export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, startAuthoringRunSchema);
  if (!body.ok) return body.response;
  const outcome = await startCharacterAuthoringRun(user.id, body.value, async () => {
    const shed = await backpressureRejection("text", user, req);
    if (shed) return shed;
    return dailyBudgetRejection("provider_text_day", user, req);
  });
  if (outcome.status === "accepted") return jsonOk({ run: outcome.run }, 202);
  if (outcome.status === "capacity") return jobCapRejection(outcome, user, req);
  if (outcome.status === "admission") return outcome.response;
  if (outcome.status === "admission_pending") return jsonError("admission_pending", "this generation request is still being admitted; retry shortly", 409);
  if (outcome.status === "not_found") return jsonError("not_found", "character not found", 404);
  if (outcome.status === "invalid_source") return jsonError("invalid_source", "the saved character details could not be read safely", 409);
  if (outcome.status === "idempotency_conflict") return jsonError("idempotency_conflict", "this run id already names a different request", 409);
  return jsonOk({
    error: {
      code: outcome.status,
      message: outcome.status === "portrait_changed" || outcome.status === "portrait_source_changed"
        ? "The displayed portrait changed. Review it and start again."
        : "The saved character changed. Review the latest details and start again.",
    },
    authoringRevision: outcome.currentRevision,
    avatarImageId: outcome.currentImageId,
  }, 409);
}, { limit: "forge" });
