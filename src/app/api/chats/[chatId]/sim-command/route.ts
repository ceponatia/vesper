import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, simItemHoldings } from "@/server/db";
import {
  submitDurableEndEngagement,
  submitDurableMoveActor,
  submitDurableStartActivity,
  submitDurableTransferItem,
} from "@/server/engine";
import { requireSimChat, simPlayerEnvelope } from "../sim-shared";

type Params = { chatId: string };

/**
 * R3 slice 2 (engine.rollout.plan.md) — typed player commands into the
 * successor: move, end the scene, hand an item over, start an activity. Every
 * admission is the ordinary durable command under the player principal; a
 * refusal returns the §14.4 PUBLIC face — code, public reason, and legal
 * alternatives — never a private cause.
 */

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), toZoneId: z.string().min(1).max(256) }).strict(),
  z.object({ kind: z.literal("end_scene") }).strict(),
  z.object({ kind: z.literal("give_item"), itemId: z.string().min(1).max(256) }).strict(),
  z
    .object({
      kind: z.literal("start_activity"),
      actionDefinitionId: z.string().min(1).max(256),
      targetActorId: z.string().min(1).max(256).optional(),
    })
    .strict(),
]);

interface CommandOutcome {
  status: string;
  code?: string;
  publicReason?: string;
  legalAlternativeCommandTypes?: readonly string[];
}

function respond(outcome: CommandOutcome) {
  if (outcome.status === "accepted") return jsonOk({ status: "accepted" });
  if (outcome.status === "rejected") {
    return jsonOk(
      {
        status: "rejected",
        code: outcome.code,
        publicReason: outcome.publicReason,
        legalAlternatives: outcome.legalAlternativeCommandTypes ?? [],
      },
      409,
    );
  }
  return jsonError("sim_conflict", "the world moved; try again", 409);
}

export const POST = withUser<Params>(async (user, req, ctx) => {
  const { chatId } = await ctx.params;
  const gate = await requireSimChat(chatId, user.id);
  if (!gate.ok) return gate.response;
  const { sim } = gate;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const command = body.value;
  const envelope = simPlayerEnvelope(sim, user.id, newId());

  switch (command.kind) {
    case "move": {
      const outcome = await submitDurableMoveActor(
        {
          ...envelope,
          type: "move_actor",
          payload: { actorId: sim.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
    case "end_scene": {
      const outcome = await submitDurableEndEngagement(
        {
          ...envelope,
          type: "end_engagement",
          payload: { engagementId: sim.engagementId, reason: "participant_choice" },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
    case "give_item": {
      const [holding] = await db()
        .select({ locusKind: simItemHoldings.locusKind, actorId: simItemHoldings.actorId })
        .from(simItemHoldings)
        .where(and(eq(simItemHoldings.branchId, sim.branchId), eq(simItemHoldings.itemId, command.itemId)))
        .limit(1);
      if (!holding || holding.locusKind !== "held" || holding.actorId !== sim.playerActorId) {
        return jsonOk(
          { status: "rejected", code: "not_held", publicReason: "They are not holding that.", legalAlternatives: [] },
          409,
        );
      }
      const outcome = await submitDurableTransferItem(
        {
          ...envelope,
          type: "transfer_item",
          schemaVersion: 2,
          payload: {
            actorId: sim.playerActorId,
            itemId: command.itemId,
            fromLocus: { kind: "held", actorId: sim.playerActorId },
            toLocus: { kind: "held", actorId: sim.primaryActorId },
          },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
    case "start_activity": {
      const outcome = await submitDurableStartActivity(
        {
          ...envelope,
          type: "start_activity",
          payload: {
            actorId: sim.playerActorId,
            actionDefinitionId: command.actionDefinitionId,
            ...(command.targetActorId === undefined ? {} : { targetActorId: command.targetActorId }),
          },
        },
        { admitAtLockedVersion: true },
      );
      return respond(outcome);
    }
  }
});
