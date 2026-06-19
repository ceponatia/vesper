import { and, asc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { diagnosticSchema } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, events, turns } from "@/server/db";
import { findOwnedSession } from "../../../../_shared/access";

type Params = { id: string; turnId: string };

const EVENT_LIMIT = 50;

/**
 * GET /api/sessions/:id/turns/:turnId/inspect — dev Turn Inspector payload
 * (docs/streaming-api.md): raw agent results, persisted diagnostics, and the
 * `retrieval` events logged between this turn's creation and the next turn's
 * (retrieval events carry no turn id, so the window is the attribution).
 * Admin-only.
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  if (user.role !== "admin") return jsonError("forbidden", "turn inspection is admin-only", 403);
  const { id, turnId } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const [turn] = await db()
    .select()
    .from(turns)
    .where(and(eq(turns.id, turnId), eq(turns.sessionId, id)))
    .limit(1);
  if (!turn) return jsonError("not_found", "turn not found", 404);

  const [nextTurn] = await db()
    .select({ createdAt: turns.createdAt })
    .from(turns)
    .where(and(eq(turns.sessionId, id), eq(turns.number, turn.number + 1)))
    .limit(1);

  const windowFilters = [
    eq(events.sessionId, id),
    eq(events.type, "retrieval"),
    gte(events.createdAt, turn.createdAt),
  ];
  if (nextTurn) windowFilters.push(lt(events.createdAt, nextTurn.createdAt));

  const retrievalEvents = await db()
    .select({ id: events.id, type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(...windowFilters))
    .orderBy(asc(events.createdAt))
    .limit(EVENT_LIMIT);

  return jsonOk({
    turn: {
      id: turn.id,
      number: turn.number,
      author: turn.author,
      status: turn.status,
      input: turn.input,
      narration: turn.narration,
      minutes: turn.minutes,
      model: turn.model,
      usage: turn.usage,
      providers: turn.providers,
      createdAt: turn.createdAt,
    },
    agentResults: turn.agentResults,
    diagnostics: parseOr(z.array(diagnosticSchema), turn.diagnostics, []),
    retrievalEvents,
  });
});
