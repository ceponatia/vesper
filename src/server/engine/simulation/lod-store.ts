import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assignActorLodCommandResultSchema,
  assignActorLodCommandSchema,
  actorLodStateSchema,
  claimHoldingActivityPhases,
  claimHoldingEngagementStates,
  isBelowEventLod,
  routinePolicyUniquenessKeyPrefix,
  type ActorLodRead,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodCommandResult,
  type SimulationBranchEvent,
} from "@/contracts/simulation";
import { BODY_THRESHOLD_HORIZON_SECONDS } from "@/lib/simulation/bodies";
import {
  buildDependencyWakeTrain,
  effectiveActorLod,
  resolveAssignActorLodFromView,
  type LodEventCommandContext,
} from "@/lib/simulation/lod";
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
      // E6.3: when the simulation axis moves, the actor's full body-alarm set
      // is retired the same way.
      const simulationMoved = effectiveActorLod(current).simulationLod !== resolution.state.simulationLod;
      await retireActorScheduledWork(tx, branch, command, actorId, {
        meterKeys: simulationMoved && bodyInitialized ? body.meters.map((meter) => meter.meterKey) : [],
      });

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

// ---------------------------------------------------------------------------
// Shared scheduled-work retirement — the assign path and the E6.4 dependency
// wake retire identically (routine arming always; body alarms per meter key).
// ---------------------------------------------------------------------------

async function retireActorScheduledWork(
  tx: SimTx,
  branch: LockedBranchView,
  command: { id: string; submittedAtWallClock: string },
  actorId: string,
  options: { meterKeys: readonly string[] },
): Promise<void> {
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
  for (const meterKey of options.meterKeys) {
    await retirePendingThresholdTriggers(
      tx,
      branch,
      command.id,
      command.submittedAtWallClock,
      actorId,
      meterKey,
    );
  }
  if (options.meterKeys.length > 0) {
    await retirePendingCollapseTriggers(tx, branch, command.id, command.submittedAtWallClock, actorId);
  }
}

// ---------------------------------------------------------------------------
// E6.4 dependency wake (§27.7) — a command whose dependency reaches a
// below-event actor promotes them to `event` inside its own transaction.
// Prepared first (the wake events precede the reaching command's own event in
// sequence), committed only once that command's resolution is known accepted.
// ---------------------------------------------------------------------------

export interface PreparedDependencyWake {
  actorId: string;
  events: SimulationBranchEvent[];
  state: ActorLodState;
  /** The woken actor's tracked meter keys — the retire set at commit. */
  meterKeys: readonly string[];
}

/**
 * Build wake trains for every below-event actor among `actorIds`, in the
 * caller's (stable) order, numbering events from `startSequence`. Read-only:
 * nothing is written until `commitDependencyWakes`. Actors at `event`/`exact`
 * (or with no row — the defaults are `exact`) contribute nothing.
 */
export async function prepareDependencyWakes(
  tx: SimTx,
  branch: LockedBranchView,
  command: LodEventCommandContext,
  actorIds: readonly string[],
  startSequence: number,
): Promise<PreparedDependencyWake[]> {
  const prepared: PreparedDependencyWake[] = [];
  let sequence = startSequence;
  for (const actorId of actorIds) {
    const current = await loadActorLodRow(tx, branch.id, actorId);
    if (!current || !isBelowEventLod(current.simulationLod)) continue;
    const body = await loadActorBody(tx, branch.id, actorId);
    const bodyInitialized = body.meters.length > 0;
    const solveHorizon = branch.storySecond + BODY_THRESHOLD_HORIZON_SECONDS;
    const meterViews = body.meters
      .map((meter) => meterViewOf(body, meter.meterKey, solveHorizon))
      .filter((view): view is NonNullable<typeof view> => view !== undefined);
    const train = buildDependencyWakeTrain({
      view: {
        worldId: branch.worldId,
        branchId: branch.id,
        rulesetVersion: branch.rulesetVersion,
        headSequence: branch.headSequence,
        storySecond: branch.storySecond,
        bodyInitialized,
        rhythmRows: body.rhythms,
        ...(bodyInitialized
          ? { bodyAlarmViews: { meterViews, collapseContext: collapseContextOf(body) } }
          : {}),
      },
      current,
      command,
      actorId,
      startSequence: sequence,
    });
    if (!train) continue;
    prepared.push({
      actorId,
      events: train.events,
      state: train.state,
      meterKeys: bodyInitialized ? body.meters.map((meter) => meter.meterKey) : [],
    });
    sequence += train.events.length;
  }
  return prepared;
}

/**
 * Land prepared wakes: retire any stale scheduled work (defense in depth —
 * the E6.3 no-work law says a below-event actor has none), append the wake
 * events (projecting trigger arms), and upsert the ledger rows. The caller
 * appends its own event(s) after and advances the branch once.
 */
export async function commitDependencyWakes(
  tx: SimTx,
  branch: LockedBranchView,
  command: { id: string; submittedAtWallClock: string },
  wakes: readonly PreparedDependencyWake[],
): Promise<void> {
  for (const wake of wakes) {
    await retireActorScheduledWork(tx, branch, command, wake.actorId, { meterKeys: wake.meterKeys });
    for (const event of wake.events) {
      await appendSimulationEvent(tx, event);
      if (event.type === "trigger_scheduled") {
        await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
      }
    }
    const firstEvent = wake.events[0];
    if (!firstEvent) throw new Error("A prepared dependency wake carries no events");
    await tx
      .insert(simActorLods)
      .values(actorLodRowInsert(branch.id, wake.state, firstEvent.sequence))
      .onConflictDoUpdate({
        target: [simActorLods.branchId, simActorLods.actorId],
        set: {
          simulationLod: wake.state.simulationLod,
          inferenceLod: wake.state.inferenceLod,
          registryVersion: wake.state.registryVersion,
          assignedAtStorySecond: wake.state.assignedAtStorySecond,
          updatedSequence: firstEvent.sequence,
        },
      });
  }
}
