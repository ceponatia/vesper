import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  simulationActionDefinitionSchema,
  activitiesProjectionSchema,
  activityInstanceSchema,
  cancelActivityCommandResultSchema,
  cancelActivityCommandSchema,
  claimHoldingActivityPhases,
  completeActivityCommandResultSchema,
  completeActivityCommandSchema,
  startActivityCommandResultSchema,
  startActivityCommandSchema,
  type SimulationActionDefinition,
  type ActivitiesProjection,
  type ActivityInstance,
  type CancelActivityCommandResult,
  resumeActivityCommandSchema,
  resumeActivityCommandResultSchema,
  type ResumeActivityCommandResult,
  type CompleteActivityCommandResult,
  type StartActivityCommandResult,
} from "@/contracts/simulation/activities";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import {
  activityCompletionUniquenessKey,
  resolveResumeActivity,
  heldClaimsForActor,
  resolveCancelActivity,
  resolveCompleteActivity,
  resolveStartActivity,
} from "@/lib/simulation/activities";
import { engagementClaimsForActor } from "@/lib/simulation/engagements";
import {
  claimHoldingEngagementStates,
  engagementSchema,
} from "@/contracts/simulation/engagements";
import {
  db,
  simActionDefinitions,
  simActivities,
  simBranches,
  simCharacters,
  simEngagements,
  simPhysicalLoci,
  simTriggers,
  simZones,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { locusFromRow } from "./space-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E3.2 durable activity authority. Action definitions are branch-scoped
 * authored data; activity rows are event-projected state whose claims are
 * derived, never separately stored (spec §16.3).
 */

export interface ActivityStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

const actionDefinitionSeedSchema = z
  .object({
    branchId: worldBranchIdSchema,
    definitions: z.array(simulationActionDefinitionSchema).min(1),
  })
  .strict();

export type ActionDefinitionSeed = z.input<typeof actionDefinitionSeedSchema>;

/**
 * Seed or extend one branch's action catalog. Definitions are authored data
 * read only at start-resolution time; started events capture version and
 * claims, so replay never needs the catalog and adding to it mid-history is
 * safe.
 */
export async function seedDurableActionDefinitions(
  rawSeed: ActionDefinitionSeed,
  options: { database?: Db } = {},
): Promise<void> {
  const seed = actionDefinitionSeedSchema.parse(rawSeed);
  const database = options.database ?? db();
  await database.transaction(async (tx) => {
    const [branch] = await tx
      .select({ id: simBranches.id })
      .from(simBranches)
      .where(eq(simBranches.id, seed.branchId))
      .limit(1);
    if (!branch) throw new Error("Cannot seed action definitions onto an unavailable branch");
    await tx.insert(simActionDefinitions).values(
      seed.definitions.map((definition) => ({
        branchId: seed.branchId,
        actionDefinitionId: definition.id,
        version: definition.version,
        payload: definition,
      })),
    );
  });
}

export function activityFromRow(row: typeof simActivities.$inferSelect): ActivityInstance {
  return activityInstanceSchema.parse({
    id: row.activityInstanceId,
    actionDefinitionId: row.actionDefinitionId,
    actionVersion: row.actionVersion,
    actorIds: row.actorIds,
    zoneId: row.zoneId,
    phase: row.phase,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.expectedCompleteAt === null ? {} : { expectedCompleteAt: row.expectedCompleteAt }),
    progressFixedPoint: row.progressFixedPoint,
    claims: row.claims,
    sourceCommandId: row.sourceCommandId,
  });
}

export function activityRowInsert(
  branchId: string,
  activity: ActivityInstance,
  updatedSequence: number,
): typeof simActivities.$inferInsert {
  return {
    branchId,
    activityInstanceId: activity.id,
    actionDefinitionId: activity.actionDefinitionId,
    actionVersion: activity.actionVersion,
    actorIds: [...activity.actorIds],
    zoneId: activity.zoneId,
    phase: activity.phase,
    startedAt: activity.startedAt ?? null,
    expectedCompleteAt: activity.expectedCompleteAt ?? null,
    progressFixedPoint: activity.progressFixedPoint,
    claims: [...activity.claims],
    sourceCommandId: activity.sourceCommandId,
    updatedSequence,
  };
}

/** Load the current typed activities projection without a write lock. */
export async function readDurableActivities(
  rawBranchId: string,
  database: Db = db(),
): Promise<ActivitiesProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const [branch] = await database
    .select({
      id: simBranches.id,
      headSequence: simBranches.headSequence,
      version: simBranches.version,
      storySecond: simBranches.storySecond,
    })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const rows = await database
    .select()
    .from(simActivities)
    .where(eq(simActivities.branchId, branchId))
    .orderBy(asc(simActivities.activityInstanceId));
  return activitiesProjectionSchema.parse({
    branchId,
    headSequence: branch.headSequence,
    version: branch.version,
    storySecond: branch.storySecond,
    activities: rows.map(activityFromRow),
  });
}

async function loadDefinition(
  tx: SimTx,
  branchId: string,
  actionDefinitionId: string,
): Promise<SimulationActionDefinition | undefined> {
  const [row] = await tx
    .select({ payload: simActionDefinitions.payload })
    .from(simActionDefinitions)
    .where(
      and(
        eq(simActionDefinitions.branchId, branchId),
        eq(simActionDefinitions.actionDefinitionId, actionDefinitionId),
      ),
    )
    .limit(1);
  return row ? simulationActionDefinitionSchema.parse(row.payload) : undefined;
}

export async function loadClaimHoldingActivities(tx: SimTx, branchId: string): Promise<ActivityInstance[]> {
  const rows = await tx
    .select()
    .from(simActivities)
    .where(
      and(
        eq(simActivities.branchId, branchId),
        sql`${simActivities.phase} = ANY(ARRAY[${sql.join(
          claimHoldingActivityPhases.map((phase) => sql`${phase}`),
          sql`, `,
        )}]::text[])`,
      ),
    );
  return rows.map(activityFromRow);
}

/** Actors whose at-locus is the given zone, for witness capture. */
async function loadCoLocatedActorIds(
  tx: SimTx,
  branchId: string,
  zoneId: string,
  excludeActorIds: readonly string[],
): Promise<string[]> {
  const rows = await tx
    .select({ actorId: simPhysicalLoci.actorId })
    .from(simPhysicalLoci)
    .where(
      and(
        eq(simPhysicalLoci.branchId, branchId),
        eq(simPhysicalLoci.kind, "at"),
        eq(simPhysicalLoci.zoneId, zoneId),
      ),
    );
  return rows.map((row) => row.actorId).filter((actorId) => !excludeActorIds.includes(actorId));
}

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

/** Execute one StartActivity: started event + completion trigger + claims, atomically. */
export async function submitDurableStartActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<StartActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: startActivityCommandSchema,
    resultSchema: startActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That action request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That action request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      startActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(
          and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, command.payload.actorId)),
        )
        .limit(1);
      const [locusRow] = await tx
        .select()
        .from(simPhysicalLoci)
        .where(
          and(eq(simPhysicalLoci.branchId, branch.id), eq(simPhysicalLoci.actorId, command.payload.actorId)),
        )
        .limit(1);
      const zoneRow =
        locusRow?.kind === "at" && locusRow.zoneId
          ? (
              await tx
                .select({ zoneId: simZones.zoneId, kind: simZones.kind, locationId: simZones.locationId })
                .from(simZones)
                .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, locusRow.zoneId)))
                .limit(1)
            )[0]
          : undefined;
      const definition = await loadDefinition(tx, branch.id, command.payload.actionDefinitionId);
      const claimHolding = await loadClaimHoldingActivities(tx, branch.id);
      const openEngagementRows = await tx
        .select()
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            inArray(simEngagements.state, [...claimHoldingEngagementStates]),
          ),
        );
      const openEngagements = openEngagementRows.map((row) =>
        engagementSchema.parse({
          id: row.engagementId,
          participantIds: row.participantIds,
          channel: row.channel,
          ...(row.locationId === null ? {} : { locationId: row.locationId }),
          ...(row.zoneId === null ? {} : { zoneId: row.zoneId }),
          state: row.state,
          openedAt: row.openedAt,
          attentionClaim: row.attentionClaim,
          sourceCommandId: row.sourceCommandId,
        }),
      );
      const coLocatedActorIds = zoneRow
        ? await loadCoLocatedActorIds(tx, branch.id, zoneRow.zoneId, [command.payload.actorId])
        : [];

      const resolution = resolveStartActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          ...(locusRow ? { locus: locusFromRow(locusRow) } : {}),
          ...(zoneRow ? { actorZone: { id: zoneRow.zoneId, kind: zoneRow.kind, locationId: zoneRow.locationId } } : {}),
          ...(definition ? { definition } : {}),
          heldClaims: [
            ...heldClaimsForActor(claimHolding, command.payload.actorId),
            ...engagementClaimsForActor(openEngagements, command.payload.actorId),
          ],
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [startedEvent, triggerEvent] = resolution.events;
      await appendSimulationEvent(tx, startedEvent);
      await appendSimulationEvent(tx, triggerEvent);
      await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      await tx.insert(simActivities).values(activityRowInsert(branch.id, resolution.activity, startedEvent.sequence));
      await advanceLockedBranch(tx, branch, triggerEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: startedEvent.sequence,
        lastSequence: triggerEvent.sequence,
        eventIds: [startedEvent.id, triggerEvent.id],
      };
    },
  });
}

/** Resolve one activity completion at its due second (trigger-dispatched). */
export async function submitDurableCompleteActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<CompleteActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: completeActivityCommandSchema,
    resultSchema: completeActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That completion request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That completion has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      completeActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const definition = activity ? await loadDefinition(tx, branch.id, activity.actionDefinitionId) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];
      const coLocatedActorIds = activity
        ? await loadCoLocatedActorIds(tx, branch.id, activity.zoneId, activity.actorIds)
        : [];

      const resolution = resolveCompleteActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
          ...(definition ? { noticeability: definition.noticeability } : {}),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simActivities)
        .set({
          phase: "completed",
          progressFixedPoint: 1_000_000,
          updatedSequence: resolution.event.sequence,
        })
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, resolution.activity.id),
            eq(simActivities.phase, "active"),
          ),
        )
        .returning({ activityInstanceId: simActivities.activityInstanceId });
      if (!updated) throw new Error("Locked activity changed before its completion update");
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/** Cancel one activity, releasing its claims and retiring its completion trigger. */
export async function submitDurableCancelActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<CancelActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: cancelActivityCommandSchema,
    resultSchema: cancelActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That cancellation request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That cancellation has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      cancelActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const definition = activity ? await loadDefinition(tx, branch.id, activity.actionDefinitionId) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];
      const coLocatedActorIds = activity
        ? await loadCoLocatedActorIds(tx, branch.id, activity.zoneId, activity.actorIds)
        : [];

      const resolution = resolveCancelActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(definition
            ? { interruptibility: definition.interruptibility, noticeability: definition.noticeability }
            : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simActivities)
        .set({ phase: "cancelled", updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, resolution.activity.id),
          ),
        )
        .returning({ activityInstanceId: simActivities.activityInstanceId });
      if (!updated) throw new Error("Locked activity changed before its cancellation update");

      // Retire the pending completion trigger in the same transaction (spec
      // §11.1 step 10) so it can never fire against the cancelled activity.
      // Prefix-matched: a resumed activity's alarm carries an attempt-
      // versioned key the un-versioned key is a strict prefix of (E5.2).
      await tx
        .update(simTriggers)
        .set({
          state: "completed",
          resultCommandId: command.id,
          completedAt: new Date(command.submittedAtWallClock),
        })
        .where(
          and(
            eq(simTriggers.branchId, branch.id),
            eq(simTriggers.state, "pending"),
            sql`starts_with(${simTriggers.uniquenessKey}, ${activityCompletionUniquenessKey(resolution.activity.id)})`,
          ),
        );
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/** Pick an interrupted activity back up (E5.2 — the E3.4 re-arm note landed). */
export async function submitDurableResumeActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<ResumeActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resumeActivityCommandSchema,
    resultSchema: resumeActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That resumption request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That resumption has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      resumeActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];

      const resolution = resolveResumeActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [resumedEvent, triggerEvent] = resolution.events;
      await appendSimulationEvent(tx, resumedEvent);
      await appendSimulationEvent(tx, triggerEvent);
      await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      const [updated] = await tx
        .update(simActivities)
        .set({
          phase: "active",
          expectedCompleteAt: resolution.activity.expectedCompleteAt ?? null,
          startedAt: resolution.activity.startedAt ?? null,
          updatedSequence: triggerEvent.sequence,
        })
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, resolution.activity.id),
          ),
        )
        .returning({ activityInstanceId: simActivities.activityInstanceId });
      if (!updated) throw new Error("Locked activity changed before its resumption update");
      await advanceLockedBranch(tx, branch, triggerEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resumedEvent.sequence,
        lastSequence: triggerEvent.sequence,
        eventIds: [resumedEvent.id, triggerEvent.id],
      };
    },
  });
}
