import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { INNER_NOTE_MAX_CHARS } from "@/contracts/turns/inner-note";
import { FORGE_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";
import { db, sessionParticipants } from "@/server/db";
import { enqueueInnerNote } from "@/server/engine";
import { findOwnedSession } from "../../../../_shared/access";

type Params = { id: string; participantId: string };

const bodySchema = z.object({
  text: z.string().trim().min(1).max(INNER_NOTE_MAX_CHARS),
});

/**
 * POST /api/sessions/:id/participants/:participantId/inner-note — author an
 * interior note (memory, feeling, belief — never dialogue) for an NPC
 * (docs/streaming-api.md, docs/memory.md §Authored interior facts).
 * Enqueues the `inner_note` background job and returns `{ jobId }`
 * immediately; the route never blocks on the LLM.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { id, participantId } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const [participant] = await db()
    .select({ id: sessionParticipants.id, isUser: sessionParticipants.isUser })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.id, participantId), eq(sessionParticipants.sessionId, id)))
    .limit(1);
  if (!participant) return jsonError("not_found", "participant not found in this session", 404);
  if (participant.isUser) {
    return jsonError("player_participant", "inner notes can only target NPCs, not the player", 400);
  }

  // After ownership + body + target validation, so a legit owner's 404/400
  // paths don't burn their budget (security-hardening pass).
  if (!rateLimit(`inner_note:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many inner notes; try again in a minute", 429);
  }

  const jobId = await enqueueInnerNote({ sessionId: id, participantId, text: body.value.text });
  return jsonOk({ jobId }, 202);
});
