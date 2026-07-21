import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assignActorLodCommandResultSchema,
  assignActorLodCommandSchema,
  actorLodStateSchema,
  claimHoldingActivityPhases,
  claimHoldingEngagementStates,
  routinePolicyUniquenessKeyPrefix,
  type ActorLodRead,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodCommandResult,
} from "@/contracts/simulation";
import { BODY_THRESHOLD_HORIZON_SECONDS } from "@/lib/simulation/bodies";
import { effectiveActorLod, resolveAssignActorLodFromView } from "@/lib/simulation/lod";
import {
  simActivities,
  simActorLods,
  simCharacters,
  simEngagements,
  simTemporalPressures,
  simTriggers,
  type Db,
} from "@/server/db";
import {
  collapseContextOf,
  loadActorBody,
  meterViewOf,
  retirePendingCollapseTriggers,
  retirePendingThresholdTriggers,
} from "./body-store";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E6.1 durable actor-LOD authority (engine.spec §27–§28). One command on the
 * shared `runSimulationCommand` shell; the ledger row is a projection of
 * `actor_lod_assigned` events, and `readEffectiveActorLod` is the one read
 * seam every consumer (the §19.3 deliberator call sites today, the E6.2
 * background-life controller next) resolves an actor's LOD through.
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

// ---------------------------------------------------------------------------
// Row mappers — insert direction exported for branch-store fork materialization
// ---------------------------------------------------------------------------

export function actorLodFromRow(row: typeof simActorLods.$inferSelect): ActorLodState {
  return actorLodStateSchema.parse({
    actorId: row.actorId,
    simulationLod: row.simulationLod,
    inferenceLod: row.inferenceLod,
    registryVersion: row.registryVersion,
    assignedAtStorySecond: row.assignedAtStorySecond,
  });
}

export function actorLodRowInsert(
  branchId: string,
  state: ActorLodState,
  updatedSequence: number,
): typeof simActorLods.$inferInsert {
  return {
    branchId,
    actorId: state.actorId,
    simulationLod: state.simulationLod,
    inferenceLod: state.inferenceLod,
    registryVersion: state.registryVersion,
    assignedAtStorySecond: state.assignedAtStorySecond,
    updatedSequence,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadActorLodRow(
  database: Db | SimTx,
  branchId: string,
  actorId: string,
): Promise<ActorLodState | undefined> {
  const [row] = await database
    .select()
    .from(simActorLods)
    .where(and(eq(simActorLods.branchId, branchId), eq(simActorLods.actorId, actorId)))
    .limit(1);
  return row ? actorLodFromRow(row) : undefined;
}

/**
 * The effective per-actor LOD: the assigned row, or the versioned registry
 * defaults when none exists — the table stays sparse and an unassigned actor
 * behaves exactly as every actor did before Gate 6.
 */
export async function readEffectiveActorLod(
  database: Db | SimTx,
  branchId: string,
  actorId: string,
): Promise<ActorLodRead> {
  return effectiveActorLod(await loadActorLodRow(database, branchId, actorId));
}

/**
 * The actor's busy-ness counts — the §27.3 claim/engagement guards, shared by
 * `assign_actor_lod`'s demotion check and the E6.2 routine controller's
 * begin-sleep legality gate.
 */
export async function loadActorBusyCounts(
  tx: Db | SimTx,
  branchId: string,
  actorId: string,
): Promise<{ claimHoldingActivityCount: number; openEngagementCount: number }> {
  const [activityGuard] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(simActivities)
    .where(
      and(
        eq(simActivities.branchId, branchId),
        inArray(simActivities.phase, [...claimHoldingActivityPhases]),
        sql`${simActivities.actorIds} @> ${JSON.stringify([actorId])}::jsonb`,
      ),
    );
  const [engagementGuard] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(simEngagements)
    .where(
      and(
        eq(simEngagements.branchId, branchId),
        inArray(simEngagements.state, [...claimHoldingEngagementStates]),
        sql`${simEngagements.participantIds} @> ${JSON.stringify([actorId])}::jsonb`,
      ),
    );
  return {
    claimHoldingActivityCount: activityGuard?.count ?? 0,
    openEngagementCount: engagementGuard?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// assign_actor_lod
// ---------------------------------------------------------------------------

export interface ActorLodSubmitOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export async function submitDurableAssignActorLod(
  rawCommand: unknown,
  options: ActorLodSubmitOptions = {},
): Promise<AssignActorLodCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: assignActorLodCommandSchema,
    resultSchema: assignActorLodCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That detail-level request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That detail-level request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      assignActorLodCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: AssignActorLodCommand) => {
      const { actorId } = command.payload;
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, actorId)))
        .limit(1);
      const current = await loadActorLodRow(tx, branch.id, actorId);

      // The §27.3 demotion guards, loaded unconditionally: three cheap counts
      // against indexed projections, and the resolver only consults them on a
      // demotion — a promotion's counts are simply unused.
      const busy = await loadActorBusyCounts(tx, branch.id, actorId);
      const [pressureGuard] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(simTemporalPressures)
        .where(
          and(
            eq(simTemporalPressures.branchId, branch.id),
            eq(simTemporalPressures.actorId, actorId),
            sql`${simTemporalPressures.resolvedAt} IS NULL`,
          ),
        );

      // E6.2/E6.3 body view: the routine alarm needs a tracked body and the
      // actor's rhythm rows; the E6.3 alarm re-arm and the active-condition
      // guard need the full body rows — one load serves all three.
      const body = await loadActorBody(tx, branch.id, actorId);
      const bodyInitialized = body.meters.length > 0;
      // Views feed forward-looking alarm solves, so rhythm self-care crossings
      // extend through the solve horizon (the loadConsumptionBodyView idiom).
      const solveHorizon = branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS;
      const meterViews = body.meters
        .map((meter) => meterViewOf(body, meter.meterKey, solveHorizon))
        .filter((view): view is NonNullable<typeof view> => view !== undefined);

      const resolution = resolveAssignActorLodFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          current,
          guards: {
            claimHoldingActivityCount: busy.claimHoldingActivityCount,
            openPressureCount: pressureGuard?.count ?? 0,
            openEngagementCount: busy.openEngagementCount,
            activeConditionCount: body.conditions.filter((condition) => condition.status === "active")
              .length,
          },
          bodyInitialized,
          rhythmRows: body.rhythms,
          ...(bodyInitialized
            ? { bodyAlarmViews: { meterViews, collapseContext: collapseContextOf(body) } }
            : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // Every accepted assignment retires the actor's prior routine arming
      // unconditionally — pending AND processing, per the E5.6 lesson — and
      // the fresh arm (if the new LOD warrants one) follows as this same
      // command's trigger_scheduled event (the restock-reconfigure idiom).
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
            inArray(simTriggers.state, ["pending", "processing"]),
            sql`starts_with(${simTriggers.uniquenessKey}, ${routinePolicyUniquenessKeyPrefix(actorId)})`,
          ),
        );

      // E6.3: when the simulation axis moves, the actor's full body-alarm set
      // is retired the same way — thresholds per meter (energy's retirement
      // cascades to the collapse alarm inside the helper), plus an explicit
      // collapse retirement for meter sets without energy. The resolver's
      // re-arm events (if the new level warrants them) follow below.
      const simulationMoved = effectiveActorLod(current).simulationLod !== resolution.state.simulationLod;
      if (simulationMoved && bodyInitialized) {
        for (const meter of body.meters) {
          await retirePendingThresholdTriggers(
            tx,
            branch,
            command.id,
            command.submittedAtWallClock,
            actorId,
            meter.meterKey,
          );
        }
        await retirePendingCollapseTriggers(tx, branch, command.id, command.submittedAtWallClock, actorId);
      }

      for (const event of resolution.events) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      const firstEvent = resolution.events[0];
      const lastEvent = resolution.events[resolution.events.length - 1];
      if (!firstEvent || !lastEvent) throw new Error("Accepted LOD assignment produced no events");
      await tx
        .insert(simActorLods)
        .values(actorLodRowInsert(branch.id, resolution.state, firstEvent.sequence))
        .onConflictDoUpdate({
          target: [simActorLods.branchId, simActorLods.actorId],
          set: {
            simulationLod: resolution.state.simulationLod,
            inferenceLod: resolution.state.inferenceLod,
            registryVersion: resolution.state.registryVersion,
            assignedAtStorySecond: resolution.state.assignedAtStorySecond,
            updatedSequence: firstEvent.sequence,
          },
        });
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
