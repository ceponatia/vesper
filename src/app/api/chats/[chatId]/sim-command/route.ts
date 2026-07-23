import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { parseOr } from "@/lib/parse";
import { simulationActionDefinitionSchema } from "@/contracts/simulation/activities";
import { deriveActivityId } from "@/lib/simulation/activities";
import { actionChipLabel } from "@/lib/simulation/world-read";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { log } from "@/server/log";
import { db, simActionDefinitions, simBranches, simCharacters, simItemHoldings, simItems } from "@/server/db";
import {
  CompositionFallbackCollector,
  drainBranchTo,
  hasActiveTimeJob,
  noteDrainDiagnostics,
  noteStillInTransit,
  findStandingEngagement,
  moveArrivalTarget,
  readDurableActivities,
  readDurableSpaceBranch,
  runAccompanyTogether,
  runDueTimeJobs,
  runSkipWithEscalation,
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
  // world-ui.plan.md slice 5: walk-with-me — invite the co-present primary to
  // travel together (NPC agency via the deterministic acceptance policy).
  z.object({ kind: z.literal("travel_together"), toZoneId: z.string().min(1).max(256) }).strict(),
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
  // A5 slice 4: while a durable time job is catching this branch's world up, turn every mutation
  // away — the in-process lock does not outlive the request that started the job, so the durable
  // job state IS the guard. Re-drive a crashed/backed-off job with a detached sweep on the way out.
  if (await hasActiveTimeJob(sim.branchId)) {
    void runDueTimeJobs(`guard-sweep-${newId()}`).catch(() => undefined);
    return jsonError("world_catching_up", "the world is still catching up on this chat; try again in a moment", 409);
  }
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
        .select({ storySecond: simBranches.storySecond, worldId: simBranches.worldId })
        .from(simBranches)
        .where(eq(simBranches.id, sim.branchId))
        .limit(1);
      if (!branch) return jsonError("not_found", "world branch not found", 404);
      const target = branch.storySecond + command.minutes * 60;
      // A5 slice 4: NEVER a 500 after the clock committed, and no dead request grinding a 30-day
      // drain. A bounded fast path finishes short skips in-request; a long skip hands its remainder
      // to a durable, server-owned job (which writes the landing beat on completion) and returns
      // `catchingUp` so the client shows staged progress until the world settles (ruling 1–2).
      const skip = await runSkipWithEscalation({
        worldId: branch.worldId,
        branchId: sim.branchId,
        chatId,
        targetStorySecond: target,
      });
      const skipFallbacks = new CompositionFallbackCollector(chatId);
      if (skip.terminalFailures > 0) {
        skipFallbacks.note({
          site: "advance_time",
          code: "trigger_failed",
          detail: `${skip.terminalFailures} poison trigger(s) in the fast path`,
        });
      }
      if (skip.status === "completed") {
        // The skip finished in-request: land the "Time passes — it's now …" beat now (the wrapped
        // standing scene folds into this one beat, never a second).
        await writeWorldBeat({ chatId, branchId: sim.branchId, kind: "time_skipped", fallbacks: skipFallbacks.codes() });
        return jsonOk({ status: "advanced", toStorySecond: skip.reachedStorySecond, drainShort: false, catchingUp: false });
      }
      // Catching up: the durable job owns the landing beat; the client polls the world/job status.
      return jsonOk({ status: "advanced", toStorySecond: skip.reachedStorySecond, drainShort: true, catchingUp: true });
    }
    case "travel": {
      // Skip-style travel (ruling 20) + graceful departure (slice 4): if a scene
      // stands, END it as a CHOICE first (participant_choice — the lawful two-step
      // advance_time performs), so the move that follows fires no hard interrupt
      // (spec §18.2: an ended scene holds no claim). Then submit the move and — on
      // acceptance — drain the clock to the journey's earliest arrival (the §17
      // arrival trigger fires inside the drain).
      const standing = await findStandingEngagement(sim.branchId, sim.playerActorId, sim.primaryActorId);
      let parted = false;
      if (standing.engagementId !== null) {
        const endId = newId();
        const ended = await submitDurableEndEngagement(
          {
            ...envelope,
            id: endId,
            idempotencyKey: endId,
            type: "end_engagement",
            payload: { engagementId: standing.engagementId, reason: "participant_choice" },
          },
          { admitAtLockedVersion: true },
        );
        // Degrade to today's behavior on an unexpected end failure: the accepted
        // move still lawfully interrupts the standing scene — never block travel.
        if (ended.status === "accepted") parted = true;
        else log.warn("engine.sim.departure", "travel end-engagement not accepted; interrupt fallback", { chatId, status: ended.status });
      }
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
      const target = await moveArrivalTarget(sim.branchId, sim.playerActorId);
      const drain = await drainBranchTo(sim.branchId, target);
      // A5: a short travel drain is honest, never a 500 — the move committed. `arrived` reads the
      // ACTUAL settled loci, so a short drain that left the traveller in transit reports
      // `arrived: false` and the arrival settles on a later beat (see also A7's arrival check).
      const travelFallbacks = new CompositionFallbackCollector(chatId);
      noteDrainDiagnostics(travelFallbacks, "travel", drain);
      const settled = await readDurableSpaceBranch(sim.branchId);
      // A7 arrival check: reuse the settled read; a still-in-transit player is recorded and
      // settles on a later beat (never a stuck character).
      noteStillInTransit(travelFallbacks, "travel", settled.loci, [sim.playerActorId], chatId);
      const arrived = settled.loci.some(
        (locus) => locus.actorId === sim.playerActorId && locus.kind === "at" && locus.zoneId === command.toZoneId,
      );
      // Slice 2/4: the landing leaves ONE durable "You walk to …" beat in the
      // transcript (replacing slice 1's toast), phrased with the parting when a
      // scene was ended. The destination label resolves through the SAME kind→noun
      // seam the world card uses — never a raw id.
      const destKind = settled.zones.find((zone) => zone.id === command.toZoneId)?.kind ?? "";
      await writeWorldBeat({
        chatId,
        branchId: sim.branchId,
        kind: "traveled",
        destinationLabel: zoneLabelFromKind(command.toZoneId, destKind),
        parted,
        fallbacks: travelFallbacks.codes(),
      });
      return jsonOk({ status: "traveled", toStorySecond: drain.reachedStorySecond, arrived, drainShort: !drain.converged });
    }
    case "travel_together": {
      // Walk-with-me (world-ui.plan.md slice 5): the shared choreography runs the
      // deterministic acceptance policy + composes the scene-end, both moves (the
      // primary under its OWN npc_policy principal — §14.2), the drain, and the
      // "together" beat. A decline / refusal returns the §14.4 face at 200 so the
      // card reads it; a landing refreshes the world + transcript.
      const [primary] = await db()
        .select({ name: simCharacters.name })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, sim.branchId), eq(simCharacters.characterId, sim.primaryActorId)))
        .limit(1);
      const outcome = await runAccompanyTogether({
        chatId,
        userId: user.id,
        branchId: sim.branchId,
        playerActorId: sim.playerActorId,
        primaryActorId: sim.primaryActorId,
        primaryName: primary?.name ?? "They",
        toZoneId: command.toZoneId,
        // C15: the chip path has no reply to attach codes to; the collector stamps them on the
        // beat runAccompanyTogether writes, and records the durable events rows.
        fallbacks: new CompositionFallbackCollector(chatId),
      });
      if (outcome.status === "declined") {
        return jsonOk({ status: "rejected", code: "accompany_declined", publicReason: outcome.publicReason, legalAlternatives: outcome.legalAlternatives });
      }
      if (outcome.status === "rejected") {
        return jsonOk({ status: "rejected", code: outcome.code, publicReason: outcome.publicReason, legalAlternatives: outcome.legalAlternatives });
      }
      if (outcome.status === "not_copresent") {
        return jsonOk({
          status: "rejected",
          code: "not_copresent",
          publicReason: `${primary?.name ?? "They"} isn't here to walk with you.`,
          legalAlternatives: [],
        });
      }
      return jsonOk({ status: outcome.status, toStorySecond: outcome.toStorySecond, arrived: outcome.arrived });
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
      // A5: a short activity drain is honest, never a 500 — the activity started and its
      // completion trigger is durable, so it settles on a later beat if the drain stops short.
      const activityFallbacks = new CompositionFallbackCollector(chatId);
      noteDrainDiagnostics(activityFallbacks, "do_activity", drain);
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
        fallbacks: activityFallbacks.codes(),
      });
      return jsonOk({ status: "performed", toStorySecond: drain.reachedStorySecond, drainShort: !drain.converged });
    }
  }
});
