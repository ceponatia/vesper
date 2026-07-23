import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, simBranches, simItemHoldings } from "@/server/db";
import {
  advanceBranchStoryTime,
  findStandingEngagement,
  readDurableSpaceBranch,
  submitDurableEndEngagement,
  submitDurableMoveActor,
  submitDurableStartActivity,
  submitDurableTransferItem,
  writeWorldBeat,
  zoneLabelFromKind,
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
  // R3 slice 4 (ruling 17): the player's time skip — bounded minutes, capped at
  // the storyteller advance's 30 days.
  z
    .object({ kind: z.literal("advance_time"), minutes: z.number().int().min(1).max(30 * 24 * 60) })
    .strict(),
  // world-ui.plan.md slice 1 (ruling 20): server-composed skip-style travel —
  // move + a bounded advance to the journey's earliest arrival, atomically.
  z.object({ kind: z.literal("travel"), toZoneId: z.string().min(1).max(256) }).strict(),
]);

interface CommandOutcome {
  status: string;
  code?: string;
  publicReason?: string;
  legalAlternativeCommandTypes?: readonly string[];
}

/**
 * Drain the branch clock to `target` through the SAME bounded advance loop
 * `advance_time` uses (`catch_up_required` just means keep draining). Shared by
 * the player time skip and skip-style travel so the two settle time identically.
 * Returns the trigger count drained, or the error Response on divergence.
 */
async function drainBranchTo(
  branchId: string,
  target: number,
): Promise<{ ok: true; drained: number } | { ok: false; response: Response }> {
  let drained = 0;
  for (let calls = 0; ; calls += 1) {
    if (calls > 1_000) return { ok: false, response: jsonError("drain_diverged", "the drain did not converge", 500) };
    const outcome = await advanceBranchStoryTime(branchId, target, { workerId: `sim-skip-${newId()}` });
    drained += outcome.drained;
    if (outcome.status === "advanced") return { ok: true, drained };
  }
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
      // Engagement identity belongs to the actor pair, not the chat: end the
      // scene they are ACTUALLY in (whichever chat or tool opened it).
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      if (standing.engagementId === null) {
        return jsonOk(
          { status: "rejected", code: "no_open_scene", publicReason: "There is no open scene to end.", legalAlternatives: [] },
          409,
        );
      }
      const outcome = await submitDurableEndEngagement(
        {
          ...envelope,
          type: "end_engagement",
          payload: { engagementId: standing.engagementId, reason: "participant_choice" },
        },
        { admitAtLockedVersion: true },
      );
      // Slice 2: an explicitly-ended scene leaves a durable transcript beat (a
      // skip folds its own scene close into the time-passes beat instead).
      if (outcome.status === "accepted") {
        await writeWorldBeat({ chatId, branchId: sim.branchId, kind: "scene_ended" });
      }
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
    case "advance_time": {
      // A skip wraps the standing scene first (the legacy "Later →" semantics:
      // the conversation ends, the player picks up after the gap), then drains
      // the bounded advance the storyteller `advance` already uses.
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      if (standing.engagementId !== null) {
        const ended = await submitDurableEndEngagement(
          {
            ...envelope,
            type: "end_engagement",
            payload: { engagementId: standing.engagementId, reason: "participant_choice" },
          },
          { admitAtLockedVersion: true },
        );
        // The error envelope (not respond's refusal shape) so the skip toast can
        // show the public reason through the ordinary client error path.
        if (ended.status === "rejected") return jsonError(ended.code, ended.publicReason, 409);
        if (ended.status !== "accepted") return jsonError("sim_conflict", "the world moved; try again", 409);
      }
      const [branch] = await db()
        .select({ storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(eq(simBranches.id, sim.branchId))
        .limit(1);
      if (!branch) return jsonError("not_found", "world branch not found", 404);
      const target = branch.storySecond + command.minutes * 60;
      const drain = await drainBranchTo(sim.branchId, target);
      if (!drain.ok) return drain.response;
      // Slice 2: the skip lands a durable "Time passes — it's now …" beat (the
      // wrapped standing scene is folded into this one beat, never a second).
      await writeWorldBeat({ chatId, branchId: sim.branchId, kind: "time_skipped" });
      return jsonOk({ status: "advanced", toStorySecond: target, drained: drain.drained });
    }
    case "travel": {
      // Skip-style travel (ruling 20): submit the player's move, then — on
      // acceptance — drain the clock to the journey's earliest arrival. An
      // accepted move already lawfully interrupts the standing scene
      // (space-store interruptCoPresentEngagementsForActor), so we do NOT end it
      // first. The §17 arrival trigger fires inside the drain.
      const moveOutcome = await submitDurableMoveActor(
        {
          ...envelope,
          type: "move_actor",
          payload: { actorId: sim.playerActorId, destinationZoneId: command.toZoneId, travelMode: "walk" },
        },
        { admitAtLockedVersion: true },
      );
      if (moveOutcome.status === "rejected") {
        // The §14.4 public refusal — returned at 200 (not the `respond` 409) so
        // the card, the first real refusal consumer, can read publicReason +
        // legalAlternatives instead of a flattened HTTP-error body.
        return jsonOk({
          status: "rejected",
          code: moveOutcome.code,
          publicReason: moveOutcome.publicReason,
          legalAlternatives: [...(moveOutcome.legalAlternativeCommandTypes ?? [])],
        });
      }
      if (moveOutcome.status !== "accepted") {
        return jsonError("sim_conflict", "the world moved; try again", 409);
      }
      const afterMove = await readDurableSpaceBranch(sim.branchId);
      const movedLocus = afterMove.loci.find((locus) => locus.actorId === sim.playerActorId);
      const journey =
        movedLocus?.kind === "in_transit"
          ? afterMove.journeys.find((candidate) => candidate.id === movedLocus.journeyId)
          : undefined;
      const target = journey?.earliestArrivalAt ?? afterMove.storySecond;
      const drain = await drainBranchTo(sim.branchId, target);
      if (!drain.ok) return drain.response;
      const settled = await readDurableSpaceBranch(sim.branchId);
      const arrived = settled.loci.some(
        (locus) => locus.actorId === sim.playerActorId && locus.kind === "at" && locus.zoneId === command.toZoneId,
      );
      // Slice 2: the landing leaves a durable "You walk to …" beat in the
      // transcript (replacing slice 1's toast). The destination label resolves
      // through the SAME kind→noun seam the world card uses — never a raw id.
      const destKind = settled.zones.find((zone) => zone.id === command.toZoneId)?.kind ?? "";
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "traveled",
        destinationLabel: zoneLabelFromKind(command.toZoneId, destKind),
      });
      return jsonOk({ status: "traveled", toStorySecond: target, arrived });
    }
  }
});
