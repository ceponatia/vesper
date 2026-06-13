import { eq } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, participantRelationships } from "@/server/db";
import { findOwnedSession } from "../../_shared/access";

type Params = { id: string };

/**
 * GET /api/sessions/:id/relationships — the session's relationship edges for
 * the read-only relationships panel (docs/streaming-api.md). Stages only: the
 * raw affinity `value` never leaves the server (stages gate behavior, values
 * are internal — contracts/relationships/stages.ts).
 */
export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { id } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const relationships = await db()
    .select({
      id: participantRelationships.id,
      fromParticipantId: participantRelationships.fromParticipantId,
      toParticipantId: participantRelationships.toParticipantId,
      kind: participantRelationships.kind,
      stage: participantRelationships.stage,
    })
    .from(participantRelationships)
    .where(eq(participantRelationships.sessionId, id));

  return jsonOk({ relationships });
});
