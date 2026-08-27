import { and, eq } from "drizzle-orm";
import {
  configureRestockRoutineCommandResultSchema,
  configureRestockRoutineCommandSchema,
  createHouseholdCommandResultSchema,
  createHouseholdCommandSchema,
  setHouseholdMembershipCommandResultSchema,
  setHouseholdMembershipCommandSchema,
  setMeansBandCommandResultSchema,
  setMeansBandCommandSchema,
  type ConfigureRestockRoutineCommand,
  type ConfigureRestockRoutineCommandResult,
  type CreateHouseholdCommand,
  type CreateHouseholdCommandResult,
  type HouseholdMembership,
  type HouseholdRestockRoutine,
  type MeansBandState,
  type SetHouseholdMembershipCommand,
  type SetHouseholdMembershipCommandResult,
  type SetMeansBandCommand,
  type SetMeansBandCommandResult,
} from "@vesper/simulation-core/contracts/households";
import {
  deriveMeansSubjectRowKey,
  resolveConfigureRestockRoutineFromView,
  resolveCreateHouseholdFromView,
  resolveSetHouseholdMembershipFromView,
  resolveSetMeansBandFromView,
} from "@vesper/simulation-core/households";
import {
  simCohorts,
  simHouseholdMembers,
  simHouseholdRestockRoutines,
  simHouseholds,
  simMeansBands,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import {
  householdMemberRowInsert,
  householdRestockRoutineRowInsert,
  householdRowInsert,
  injectCrash,
  loadHouseholdsAuthorityContext,
  loadMeansBandRow,
  meansBandRowInsert,
  membershipKey,
  rejectedResult,
  retirePendingRestockTriggers,
  type HouseholdSubmitOptions,
} from "./household-rows";
import { InjectedSimulationCrash } from "./material-store";
import { applyTriggerScheduledEvent } from "./trigger-projector";

/**
 * The E5.4 IDENTITY-and-POLICY household commands: who a household is, who
 * belongs to it, what means band a subject holds, and how a restock routine is
 * configured. Modeled on material-store.ts — every command runs through the shared
 * `runSimulationCommand` shell (§11.1) rather than a hand-rolled transaction,
 * so observation/knowledge/soft-canon/memory folds come free.
 *
 * The four commands that move material QUANTITY (adjust, transfer, promotion,
 * the trigger-dispatched restock cycle) are household-lots.ts; the row
 * mapping, authority context, lazy lot lifecycle and alarm plumbing both
 * modules stand on are household-rows.ts.
 */

// ---------------------------------------------------------------------------
// create_household (§26.8)
// ---------------------------------------------------------------------------

export async function submitDurableCreateHousehold(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<CreateHouseholdCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: createHouseholdCommandSchema,
    resultSchema: createHouseholdCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That household request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That household request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      createHouseholdCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: CreateHouseholdCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveCreateHouseholdFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
          zoneExists: (zoneId) => context.zoneIds.has(zoneId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await tx.insert(simHouseholds).values(
        householdRowInsert(branch.id, {
          id: event.payload.householdId,
          name: event.payload.name,
          residenceZoneIds: event.payload.residenceZoneIds,
          stockAccessPolicy: event.payload.stockAccessPolicy,
        }),
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// set_household_membership (§26.8)
// ---------------------------------------------------------------------------

export async function submitDurableSetHouseholdMembership(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<SetHouseholdMembershipCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: setHouseholdMembershipCommandSchema,
    resultSchema: setHouseholdMembershipCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That membership request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That membership request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      setHouseholdMembershipCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: SetHouseholdMembershipCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveSetHouseholdMembershipFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
          actorExists: context.actorsById.has(command.payload.actorId),
          currentMembership: context.membershipsByKey.get(
            membershipKey(command.payload.householdId, command.payload.actorId),
          ),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      const membership: HouseholdMembership = {
        householdId: event.payload.householdId,
        actorId: event.payload.actorId,
        role: event.payload.role,
        status: event.payload.status,
        ...(event.payload.endedAtStorySecond === undefined
          ? {}
          : { endedAtStorySecond: event.payload.endedAtStorySecond }),
      };
      await tx
        .insert(simHouseholdMembers)
        .values(householdMemberRowInsert(branch.id, membership, event.sequence))
        .onConflictDoUpdate({
          target: [simHouseholdMembers.branchId, simHouseholdMembers.householdId, simHouseholdMembers.actorId],
          set: {
            role: membership.role,
            status: membership.status,
            endedAtStorySecond: membership.endedAtStorySecond ?? null,
            updatedSequence: event.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// set_means_band (§26.10)
// ---------------------------------------------------------------------------

export async function submitDurableSetMeansBand(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<SetMeansBandCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: setMeansBandCommandSchema,
    resultSchema: setMeansBandCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That means band request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That means band request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      setMeansBandCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: SetMeansBandCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const subject = command.payload.subject;
      const subjectExists =
        subject.kind === "actor"
          ? context.actorsById.has(subject.actorId)
          : subject.kind === "household"
            ? context.householdsById.has(subject.householdId)
            : (
                await tx
                  .select({ cohortId: simCohorts.cohortId })
                  .from(simCohorts)
                  .where(and(eq(simCohorts.branchId, branch.id), eq(simCohorts.cohortId, subject.cohortId)))
                  .limit(1)
              ).length > 0;
      const currentBand = await loadMeansBandRow(tx, branch.id, deriveMeansSubjectRowKey(subject));

      const resolution = resolveSetMeansBandFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          subjectExists,
          currentBand,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      const band: MeansBandState = {
        subject: event.payload.subject,
        bandKey: event.payload.bandKey,
        registryVersion: event.payload.registryVersion,
        setAtStorySecond: event.payload.setAtStorySecond,
      };
      await tx
        .insert(simMeansBands)
        .values(meansBandRowInsert(branch.id, band, event.sequence))
        .onConflictDoUpdate({
          target: [simMeansBands.branchId, simMeansBands.subjectKey],
          set: {
            bandKey: band.bandKey,
            registryVersion: band.registryVersion,
            setAtStorySecond: band.setAtStorySecond,
            updatedSequence: event.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// configure_restock_routine (§26.11)
// ---------------------------------------------------------------------------

export async function submitDurableConfigureRestockRoutine(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<ConfigureRestockRoutineCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: configureRestockRoutineCommandSchema,
    resultSchema: configureRestockRoutineCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That restock routine request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(
        commandId,
        "duplicate_command_id",
        "That restock routine request has already been submitted.",
      ),
    conflictResult: (commandId, currentVersion) =>
      configureRestockRoutineCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: ConfigureRestockRoutineCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const resolution = resolveConfigureRestockRoutineFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          householdExists: context.householdsById.has(command.payload.householdId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // Unconditionally retire any pending alarm for this (householdId,
      // materialKindKey) BEFORE arming a fresh one (§5.6) — a reconfigure
      // always invalidates whether or not a fresh arm follows.
      await retirePendingRestockTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.householdId,
        command.payload.materialKindKey,
      );

      const [configuredEvent, ...triggerEvents] = resolution.events;
      await appendSimulationEvent(tx, configuredEvent);
      for (const triggerEvent of triggerEvents) {
        await appendSimulationEvent(tx, triggerEvent);
        await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      }
      injectCrash(options.crashAt, "after_event_append");

      const routine: HouseholdRestockRoutine = {
        householdId: configuredEvent.payload.householdId,
        materialKindKey: configuredEvent.payload.materialKindKey,
        targetQuantityRaw: configuredEvent.payload.targetQuantityRaw,
        lowWaterThresholdRaw: configuredEvent.payload.lowWaterThresholdRaw,
        cadenceSeconds: configuredEvent.payload.cadenceSeconds,
        funding: configuredEvent.payload.funding,
        active: configuredEvent.payload.active,
      };
      await tx
        .insert(simHouseholdRestockRoutines)
        .values(householdRestockRoutineRowInsert(branch.id, routine, configuredEvent.sequence))
        .onConflictDoUpdate({
          target: [
            simHouseholdRestockRoutines.branchId,
            simHouseholdRestockRoutines.householdId,
            simHouseholdRestockRoutines.materialKindKey,
          ],
          set: {
            targetQuantityRaw: routine.targetQuantityRaw,
            lowWaterThresholdRaw: routine.lowWaterThresholdRaw,
            cadenceSeconds: routine.cadenceSeconds,
            funding: routine.funding,
            active: routine.active,
            updatedSequence: configuredEvent.sequence,
          },
        });
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? configuredEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: configuredEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}
