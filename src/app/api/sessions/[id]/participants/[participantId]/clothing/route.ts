import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { itemDefinitionSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, itemInstances, sessionParticipants } from "@/server/db";
import { findOwnedSession } from "../../../../_shared/access";

type Params = { id: string; participantId: string };

const bodySchema = z.object({
  action: z.enum(["wear", "remove"]),
  itemInstanceId: z.string().min(1),
});

/**
 * POST /api/sessions/:id/participants/:participantId/clothing — DEV-ONLY:
 * move a held clothing item onto/off a participant for inventory testing. The
 * garment never leaves the participant; remove means "held, not worn".
 * Admin-gated and hidden in production because it bypasses narrative authority.
 */
export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  if (process.env.NODE_ENV === "production") {
    return jsonError("not_found", "not found", 404);
  }
  if (user.role !== "admin") return jsonError("forbidden", "clothing debug controls are admin-only", 403);

  const { id, participantId } = await ctx.params;
  const session = await findOwnedSession(user.id, id);
  if (!session) return jsonError("not_found", "session not found", 404);
  if (session.status !== "ready") {
    return jsonError("session_busy", "wait for the current turn to finish before editing clothing", 409);
  }

  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;

  const [participant] = await db()
    .select({ id: sessionParticipants.id })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.id, participantId), eq(sessionParticipants.sessionId, id)))
    .limit(1);
  if (!participant) return jsonError("not_found", "participant not found in this session", 404);

  const [item] = await db()
    .select({
      id: itemInstances.id,
      name: itemInstances.name,
      snapshot: itemInstances.snapshot,
      holderParticipantId: itemInstances.holderParticipantId,
      worn: itemInstances.worn,
    })
    .from(itemInstances)
    .where(and(eq(itemInstances.id, body.value.itemInstanceId), eq(itemInstances.sessionId, id)))
    .limit(1);
  if (!item) return jsonError("not_found", "item not found in this session", 404);

  if (item.holderParticipantId !== participantId) {
    return jsonError("item_not_held", `"${item.name}" is not held by this participant`, 409);
  }

  const definition = itemDefinitionSchema.safeParse(item.snapshot);
  if (!definition.success) {
    return jsonError("invalid_item_snapshot", `"${item.name}" has an invalid item snapshot`, 409);
  }
  if (definition.data.kind !== "clothing") {
    return jsonError("not_clothing", `"${item.name}" is not clothing`, 400);
  }

  const worn = body.value.action === "wear";
  if (item.worn !== worn) {
    await db()
      .update(itemInstances)
      .set({ holderParticipantId: participantId, worn, locationId: null, containerInstanceId: null })
      .where(and(eq(itemInstances.id, item.id), eq(itemInstances.sessionId, id)));
  }

  return jsonOk({ itemInstanceId: item.id, participantId, worn });
});
