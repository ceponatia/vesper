import { jsonError, jsonOk, withUser } from "@/server/api";
import { sessionJobStatus } from "@/server/engine";
import { findOwnedSession } from "../../_shared/access";

type Params = { id: string };

/** GET /api/sessions/:id/job — the post-turn polling payload (docs/streaming-api.md). */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);
  const status = await sessionJobStatus(id);
  if (!status) return jsonError("not_found", "session not found", 404);
  return jsonOk(status);
});
