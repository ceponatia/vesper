import { and, eq } from "drizzle-orm";
import { jsonError, jsonOk, withUser } from "@/server/api";
import { db, sessionParticipants } from "@/server/db";
import { findOwnedSession } from "../../../../_shared/access";

type Params = { id: string; participantId: string };

/**
 * POST /api/sessions/:id/participants/:participantId/teleport — DEV-ONLY: snap
 * an NPC to the player's current location. A debugging shortcut for the absence
 * of a clock-keyed appointment / off-screen routing system (see
 * docs/developer-notes/phase-3-to-4.md §Movement). It bypasses the link graph,
 * adjacency, travel time, and movement authority — never expose it in
 * production. Gated on NODE_ENV server-side (the client also hides the button).
 */
export const POST = withUser<Params>(async (user, _req, ctx) => {
  if (process.env.NODE_ENV === "production") {
    return jsonError("not_found", "not found", 404);
  }

  const { id, participantId } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);

  const participants = await db()
    .select({ id: sessionParticipants.id, isUser: sessionParticipants.isUser, locationId: sessionParticipants.locationId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, id));

  const target = participants.find((p) => p.id === participantId);
  if (!target) return jsonError("not_found", "participant not found in this session", 404);
  if (target.isUser) return jsonError("player_participant", "the player cannot be teleported to themselves", 400);

  const player = participants.find((p) => p.isUser);
  if (!player?.locationId) return jsonError("no_player_location", "the player has no current location to teleport to", 409);

  await db()
    .update(sessionParticipants)
    .set({ locationId: player.locationId })
    .where(and(eq(sessionParticipants.id, participantId), eq(sessionParticipants.sessionId, id)));

  return jsonOk({ id: participantId, locationId: player.locationId });
});
