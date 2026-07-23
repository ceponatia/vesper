import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { simulationActionDefinitionSchema } from "@/contracts/simulation/activities";
import { deriveActivityId } from "@/lib/simulation/activities";
import { actionChipLabel } from "@/lib/simulation/world-read";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, simActionDefinitions, simBranches, simCharacters, simItemHoldings, simItems } from "@/server/db";
import {
  advanceBranchStoryTime,
  findStandingEngagement,
  readDurableActivities,
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
  // world-ui.plan.md slice 3 (ruling 20 spirit): server-composed skip-style
  // activity — start_activity + a bounded drain through its duration, atomically.
  z.object({ kind: z.literal("do_activity"), actionDefinitionId: z.string().min(1).max(256) }).strict(),
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

/**
 * The §14.4 PUBLIC refusal in the `ok` channel (HTTP 200), so the card reads
 * `publicReason` + `legalAlternatives` instead of a flattened HTTP-error body.
 * Shared by every card-facing composite (travel / give_item / do_activity) —
 * the card is the first real refusal consumer and needs the structured shape.
 */
function publicRefusal(outcome: CommandOutcome) {
  return jsonOk({
    status: "rejected",
    code: outcome.code,
    publicReason: outcome.publicReason,
    legalAlternatives: [...(outcome.legalAlternativeCommandTypes ?? [])],
  });
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
        .select({ locusKind: simItemHoldings.locusKind, actorId: simItemHoldings.actorId, name: simItems.name })
        .from(simItemHoldings)
        .innerJoin(
          simItems,
          and(eq(simItems.branchId, simItemHoldings.branchId), eq(simItems.itemId, simItemHoldings.itemId)),
        )
        .where(and(eq(simItemHoldings.branchId, sim.branchId), eq(simItemHoldings.itemId, command.itemId)))
        .limit(1);
      if (!holding || holding.locusKind !== "held" || holding.actorId !== sim.playerActorId) {
        // The §14.4 public face at 200 (matching travel) so the card renders it.
        return jsonOk({ status: "rejected", code: "not_held", publicReason: "You are not holding that.", legalAlternatives: [] });
      }
      // The transfer resolver enforces giver/receiver co-location itself (§26.4
      // step 7: the destination's root zone — the primary's zone — must equal
      // the player's), so an absent primary yields `root_not_colocated` "That
      // destination is not within reach." — no route-level co-location precheck
      // needed. The card also disables the affordance when the primary is away.
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
      if (outcome.status === "rejected") return publicRefusal(outcome);
      if (outcome.status !== "accepted") return jsonError("sim_conflict", "the world moved; try again", 409);
      // Slice 3: the handoff leaves a durable "You hand … " beat, named through
      // the primary + the item's own display name (never a raw id).
      const [primary] = await db()
        .select({ name: simCharacters.name })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, sim.branchId), eq(simCharacters.characterId, sim.primaryActorId)))
        .limit(1);
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "gave_item",
        ...(primary ? { recipientName: primary.name } : {}),
        itemName: holding.name,
      });
      return jsonOk({ status: "gave" });
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
      if (moveOutcome.status === "rejected") return publicRefusal(moveOutcome);
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
    case "do_activity": {
      // Skip-style activity (ruling 20 spirit): submit the player's
      // start_activity, then — on acceptance — drain the clock through the
      // activity's duration. Completion is trigger-scheduled AT start
      // (activity-store schedules the completion trigger at expectedCompleteAt),
      // so the drain fires it; the route never submits complete_activity itself.
      const outcome = await submitDurableStartActivity(
        {
          ...envelope,
          type: "start_activity",
          payload: { actorId: sim.playerActorId, actionDefinitionId: command.actionDefinitionId },
        },
        { admitAtLockedVersion: true },
      );
      // A claim conflict (e.g. resting mid-scene) surfaces here as the §14.4
      // public face at 200 — the card renders it via the slice-1 refusal surface.
      if (outcome.status === "rejected") return publicRefusal(outcome);
      if (outcome.status !== "accepted") return jsonError("sim_conflict", "the world moved; try again", 409);
      // The started activity's id is deterministic from this command; read its
      // expectedCompleteAt to know how far to drain (mirrors travel reading the
      // journey's earliestArrivalAt).
      const activityId = deriveActivityId(sim.branchId, envelope.id);
      const activities = await readDurableActivities(sim.branchId);
      const started = activities.activities.find((activity) => activity.id === activityId);
      const target = started?.expectedCompleteAt ?? activities.storySecond;
      const drain = await drainBranchTo(sim.branchId, target);
      if (!drain.ok) return drain.response;
      // Slice 3: the settled activity leaves a durable "You rest a while." beat,
      // phrased generically from the action's display label (never a raw id).
      const [definitionRow] = await db()
        .select({ payload: simActionDefinitions.payload })
        .from(simActionDefinitions)
        .where(
          and(
            eq(simActionDefinitions.branchId, sim.branchId),
            eq(simActionDefinitions.actionDefinitionId, command.actionDefinitionId),
          ),
        )
        .limit(1);
      const definition = definitionRow
        ? parseOr(simulationActionDefinitionSchema.nullable(), definitionRow.payload, null, undefined, "sim_action_definitions.payload")
        : null;
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "rested",
        activityLabel: actionChipLabel(command.actionDefinitionId, definition?.label),
      });
      return jsonOk({ status: "performed", toStorySecond: target });
    }
  }
});
