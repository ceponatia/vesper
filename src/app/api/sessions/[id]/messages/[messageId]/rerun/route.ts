import { withUser } from "@/server/api";
import { rerunTurn } from "@/server/engine";
import { streamTurnEvents } from "../../../../_shared/sse";

type Params = { id: string; messageId: string };

/**
 * POST /api/sessions/:id/messages/:messageId/rerun ⇒ SSE stream, same
 * protocol as /turns. Only the latest turn can be rerun; the engine yields
 * `not_latest`/`not_found`/`session_busy` as the first event, which becomes
 * a plain JSON error response.
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id, messageId } = await ctx.params;
  return streamTurnEvents(rerunTurn({ sessionId: id, userId: user.id, messageId }));
});
