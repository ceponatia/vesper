import { and, eq, isNotNull } from "drizzle-orm";
import {
  runRoutinePolicyCommandResultSchema,
  runRoutinePolicyCommandSchema,
  type RunRoutinePolicyCommand,
  type RunRoutinePolicyCommandResult,
} from "@vesper/simulation-core/contracts/routine";
import {
  mealWindowCovering,
  resolveRunRoutinePolicyFromView,
  type RunRoutinePolicyResolutionView,
} from "@vesper/simulation-core/routine";
import {
  simBodyConditions,
  simBodyModifiers,
  simCharacters,
  simItems,
  simTemporalPressures,
  type Db,
} from "@/server/db";
import {
  bodyConditionRowInsert,
  bodyModifierRowInsert,
  loadActorBody,
  loadCoLocatedActorIds,
  meterViewOf,
  retirePendingThresholdTriggers,
  upsertMeterRow,
} from "./body-store";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { loadActorBusyCounts, readEffectiveActorLod } from "./lod-store";
import {
  loadConsumptionBodyView,
  loadMaterialResolutionView,
  publishMaterialFeedObligation,
  updateItemLocus,
} from "./material-store";
import { applyTriggerScheduledEvent } from "./trigger-projector";

/**
 * E6.2 — the durable routine controller (engine.spec §19.1–19.2, §27–28).
 * `run_routine_policy` is trigger-dispatched at an event-LOD actor's rhythm
 * boundary, re-validates everything at fire time, records the §19.2 decision,
 * and commits the chosen outcome atomically through the ordinary law — the
 * identical asleep train collapse uses when sleep wins, the identical §26.6
 * consumption train `consume_item` records when a meal wins — then re-arms
 * the next boundary. Zero model calls.
 */

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

export interface RoutineSubmitOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export async function submitDurableRunRoutinePolicy(
  rawCommand: unknown,
  options: RoutineSubmitOptions = {},
): Promise<RunRoutinePolicyCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: runRoutinePolicyCommandSchema,
    resultSchema: runRoutinePolicyCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That routine dispatch is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That routine dispatch has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      runRoutinePolicyCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RunRoutinePolicyCommand) => {
      const { actorId } = command.payload;
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, actorId)))
        .limit(1);
      const lod = await readEffectiveActorLod(tx, branch.id, actorId);
      const body = await loadActorBody(tx, branch.id, actorId);
      const energyView = meterViewOf(body, "energy", branch.storySecond);
      const busy = await loadActorBusyCounts(tx, branch.id, actorId);
      const pressureRows = await tx
        .select({ actBy: simTemporalPressures.actBy, resolvedAt: simTemporalPressures.resolvedAt })
        .from(simTemporalPressures)
        .where(and(eq(simTemporalPressures.branchId, branch.id), eq(simTemporalPressures.actorId, actorId)));
      const coLocatedActorIds = await loadCoLocatedActorIds(tx, branch.id, actorId);
      const endedSleeps = body.conditions
        .filter((condition) => condition.key === "asleep" && condition.endedAtStorySecond !== undefined)
        .map((condition) => condition.endedAtStorySecond ?? 0);
      const lastSleepEndedAtStorySecond = endedSleeps.length > 0 ? Math.max(...endedSleeps) : undefined;

      // The eat_meal candidate's §26 facts, loaded only when a meal window
      // covers the fire second (the resolver recomputes membership through
      // the same pure helper, so the gate can never disagree with the score).
      // Candidates narrow to consumable items up front; the material view
      // still carries the whole branch for root/container resolution.
      let materialFacts: Pick<
        RunRoutinePolicyResolutionView,
        "materialView" | "materialItemIds" | "consumptionBodyView"
      > = {};
      if (mealWindowCovering(body.rhythms, branch.storySecond) !== undefined) {
        const consumableRows = await tx
          .select({ itemId: simItems.itemId })
          .from(simItems)
          .where(and(eq(simItems.branchId, branch.id), isNotNull(simItems.consumptionEffects)));
        const materialItemIds = consumableRows.map((row) => row.itemId);
        materialFacts = {
          materialView: await loadMaterialResolutionView(tx, branch, materialItemIds),
          materialItemIds,
          consumptionBodyView: await loadConsumptionBodyView(tx, branch.id, actorId, branch.storySecond),
        };
      }

      const resolution = resolveRunRoutinePolicyFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          lod,
          rhythmRows: body.rhythms,
          ...(energyView === undefined ? {} : { energyView }),
          activeAsleep: body.conditions.some(
            (condition) => condition.status === "active" && condition.key === "asleep",
          ),
          ...(lastSleepEndedAtStorySecond === undefined ? {} : { lastSleepEndedAtStorySecond }),
          claimHoldingActivityCount: busy.claimHoldingActivityCount,
          openEngagementCount: busy.openEngagementCount,
          openPressureActBySeconds: pressureRows
            .filter((row) => row.resolvedAt === null)
            .map((row) => row.actBy),
          coLocatedActorIds,
          ...materialFacts,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // A begun sleep is a material energy change: the suspend boundary
      // retires the pending energy/collapse alarms exactly as collapse does.
      if (resolution.chosenCandidateId === "begin_sleep") {
        await retirePendingThresholdTriggers(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          actorId,
          "energy",
        );
      }
      // A chosen meal replays `submitDurableConsumeItem`'s row effects event
      // by event: the consumed item goes to gone/consumed with its feed
      // obligation, and each body_source_applied retires its own meter's
      // pending alarm before its paired meter upsert (never one retirement
      // for the whole batch — a multi-effect item touches several meters).
      let meterUpdateIndex = 0;
      for (const event of resolution.events) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        } else if (event.type === "item_consumed") {
          await updateItemLocus(
            tx,
            branch.id,
            event.payload.itemId,
            { kind: "gone", basis: "consumed" },
            event.sequence,
          );
          await publishMaterialFeedObligation(tx, event);
        } else if (event.type === "body_source_applied") {
          await retirePendingThresholdTriggers(
            tx,
            branch,
            command.id,
            command.submittedAtWallClock,
            actorId,
            event.payload.meterKey,
          );
          const meterUpdate = resolution.meterUpdates?.[meterUpdateIndex];
          meterUpdateIndex += 1;
          if (!meterUpdate) {
            throw new Error("Routine consumption produced a body_source_applied event without a matching meter update");
          }
          await upsertMeterRow(tx, branch.id, meterUpdate, event.sequence);
        }
      }
      const firstEvent = resolution.events[0];
      const lastEvent = resolution.events[resolution.events.length - 1];
      if (!firstEvent || !lastEvent) throw new Error("Accepted routine resolution produced no events");
      if (resolution.condition) {
        await tx
          .insert(simBodyConditions)
          .values(bodyConditionRowInsert(branch.id, resolution.condition, firstEvent.sequence));
      }
      if (resolution.suspendModifier) {
        await tx
          .insert(simBodyModifiers)
          .values(bodyModifierRowInsert(branch.id, resolution.suspendModifier, firstEvent.sequence));
      }
      if (resolution.meter) {
        await upsertMeterRow(tx, branch.id, resolution.meter, firstEvent.sequence);
      }
      await advanceLockedBranch(tx, branch, lastEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: firstEvent.sequence,
        lastSequence: lastEvent.sequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
