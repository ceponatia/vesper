import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assignActorLodCommandResultSchema,
  assignActorLodCommandSchema,
  actorLodStateSchema,
  claimHoldingActivityPhases,
  claimHoldingEngagementStates,
  type ActorLodRead,
  type ActorLodState,
  type AssignActorLodCommand,
  type AssignActorLodCommandResult,
} from "@/contracts/simulation";
import { effectiveActorLod, resolveAssignActorLodFromView } from "@/lib/simulation/lod";
import {
  simActivities,
  simActorLods,
  simCharacters,
  simEngagements,
  simTemporalPressures,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import type { SimTx } from "./trigger-projector";

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
      const [activityGuard] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            inArray(simActivities.phase, [...claimHoldingActivityPhases]),
            sql`${simActivities.actorIds} @> ${JSON.stringify([actorId])}::jsonb`,
          ),
        );
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
      const [engagementGuard] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            inArray(simEngagements.state, [...claimHoldingEngagementStates]),
            sql`${simEngagements.participantIds} @> ${JSON.stringify([actorId])}::jsonb`,
          ),
        );

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
            claimHoldingActivityCount: activityGuard?.count ?? 0,
            openPressureCount: pressureGuard?.count ?? 0,
            openEngagementCount: engagementGuard?.count ?? 0,
          },
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      await tx
        .insert(simActorLods)
        .values(actorLodRowInsert(branch.id, resolution.state, resolution.event.sequence))
        .onConflictDoUpdate({
          target: [simActorLods.branchId, simActorLods.actorId],
          set: {
            simulationLod: resolution.state.simulationLod,
            inferenceLod: resolution.state.inferenceLod,
            registryVersion: resolution.state.registryVersion,
            assignedAtStorySecond: resolution.state.assignedAtStorySecond,
            updatedSequence: resolution.event.sequence,
          },
        });
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
