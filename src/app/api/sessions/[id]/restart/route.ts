import { DiagnosticCollector } from "@/contracts/diagnostics";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { recoverAbandonedTurns, restartSession } from "@/server/engine";
import { findOwnedSession } from "../../_shared/access";

type Params = { id: string };

/**
 * POST /api/sessions/:id/restart — wipe play state and re-materialize from
 * the world (docs/turn-engine.md §Other paths). Recovery runs first so a
 * wedged session (stale heartbeat) can always be restarted.
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  await recoverAbandonedTurns(id);
  const fresh = await findOwnedSession(user.id, id);
  if (!fresh) return jsonError("not_found", "session not found", 404);
  if (fresh.status !== "ready") {
    return jsonError("session_busy", "a turn is in progress; wait for it to finish before restarting", 409);
  }

  const sink = new DiagnosticCollector();
  const restarted = await restartSession(id, sink);
  if (!restarted) return jsonError("restart_failed", "the session could not be restarted", 500);
  return jsonOk({ ok: true, diagnostics: sink.items });
});
