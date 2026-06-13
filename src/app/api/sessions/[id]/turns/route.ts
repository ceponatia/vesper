import { submitTurnBodySchema } from "@/contracts";
import { readBody, withUser } from "@/server/api";
import { submitTurn } from "@/server/engine";
import { streamTurnEvents } from "../../_shared/sse";

type Params = { id: string };

/**
 * POST /api/sessions/:id/turns ⇒ SSE stream (docs/streaming-api.md §Turn
 * streaming). A busy session is a plain 409 JSON response, not a stream;
 * ownership is enforced by the engine (first event `not_found` → 404).
 */
export const POST = withUser<Params>(async (user, req, ctx) => {
  const { id } = await ctx.params;
  const body = await readBody(req, submitTurnBodySchema);
  if (!body.ok) return body.response;
  return streamTurnEvents(submitTurn({ sessionId: id, userId: user.id, body: body.value }));
});
