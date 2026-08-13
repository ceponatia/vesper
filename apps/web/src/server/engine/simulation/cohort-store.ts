import { and, eq, inArray } from "drizzle-orm";
import {
  adjustCohortCommandResultSchema,
  adjustCohortCommandSchema,
  createCohortCommandResultSchema,
  createCohortCommandSchema,
  simulationCohortSchema,
  type AdjustCohortCommand,
  type AdjustCohortCommandResult,
  type CreateCohortCommand,
  type CreateCohortCommandResult,
  type SimulationCohort,
} from "@vesper/simulation-core/contracts/cohorts";
import { resolveAdjustCohortFromView, resolveCreateCohortFromView } from "@vesper/simulation-core/cohorts";
import { simCohorts, simZones, type Db } from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import type { SimTx } from "./trigger-projector";

/**
 * E6.3 durable cohort authority (engine.spec §27.6). Two commands on the
 * shared `runSimulationCommand` shell; the row is a projection of
 * `cohort_created` / `cohort_adjusted` events, presence is a pure lib read
 * over loaded rows (`cohortPresenceAt` / `zonePresenceAt` — zero rows, zero
 * triggers), and fork children rebuild rows from inherited events
 * (branch-store.ts wires `replayCohortHistory`).
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

export function cohortFromRow(row: typeof simCohorts.$inferSelect): SimulationCohort {
  return simulationCohortSchema.parse({
    id: row.cohortId,
    name: row.name,
    population: row.population,
    presenceWindows: row.presenceWindows,
    registryVersion: row.registryVersion,
  });
}

export function cohortRowInsert(
  branchId: string,
  cohort: SimulationCohort,
  updatedSequence: number,
): typeof simCohorts.$inferInsert {
  return {
    branchId,
    cohortId: cohort.id,
    name: cohort.name,
    population: cohort.population,
    presenceWindows: [...cohort.presenceWindows],
    registryVersion: cohort.registryVersion,
    updatedSequence,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every cohort on the branch — the input to the pure presence reads. */
export async function loadBranchCohorts(
  database: Db | SimTx,
  branchId: string,
): Promise<SimulationCohort[]> {
  const rows = await database.select().from(simCohorts).where(eq(simCohorts.branchId, branchId));
  return rows.map(cohortFromRow).sort((left, right) => (left.id < right.id ? -1 : 1));
}

/** One cohort by id — shared with the E6.4 promotion store. */
export async function loadCohortRow(
  tx: SimTx,
  branchId: string,
  cohortId: string,
): Promise<SimulationCohort | undefined> {
  const [row] = await tx
    .select()
    .from(simCohorts)
    .where(and(eq(simCohorts.branchId, branchId), eq(simCohorts.cohortId, cohortId)))
    .limit(1);
  return row ? cohortFromRow(row) : undefined;
}

// ---------------------------------------------------------------------------
// create_cohort
// ---------------------------------------------------------------------------

export interface CohortSubmitOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export async function submitDurableCreateCohort(
  rawCommand: unknown,
  options: CohortSubmitOptions = {},
): Promise<CreateCohortCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: createCohortCommandSchema,
    resultSchema: createCohortCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That cohort request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That cohort has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      createCohortCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: CreateCohortCommand) => {
      const existing = await loadCohortRow(tx, branch.id, command.payload.cohort.id);
      const windowZoneIds = [
        ...new Set(command.payload.cohort.presenceWindows.map((window) => window.zoneId)),
      ];
      const zoneRows =
        windowZoneIds.length > 0
          ? await tx
              .select({ zoneId: simZones.zoneId })
              .from(simZones)
              .where(and(eq(simZones.branchId, branch.id), inArray(simZones.zoneId, windowZoneIds)))
          : [];
      const knownZoneIds = new Set(zoneRows.map((row) => row.zoneId));

      const resolution = resolveCreateCohortFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          alreadyExists: existing !== undefined,
          zoneExists: (zoneId) => knownZoneIds.has(zoneId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      await tx.insert(simCohorts).values(cohortRowInsert(branch.id, resolution.cohort, resolution.event.sequence));
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

// ---------------------------------------------------------------------------
// adjust_cohort
// ---------------------------------------------------------------------------

export async function submitDurableAdjustCohort(
  rawCommand: unknown,
  options: CohortSubmitOptions = {},
): Promise<AdjustCohortCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: adjustCohortCommandSchema,
    resultSchema: adjustCohortCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That cohort adjustment is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That cohort adjustment has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      adjustCohortCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: AdjustCohortCommand) => {
      const current = await loadCohortRow(tx, branch.id, command.payload.cohortId);

      const resolution = resolveAdjustCohortFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          current,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      await tx
        .update(simCohorts)
        .set({ population: resolution.cohort.population, updatedSequence: resolution.event.sequence })
        .where(and(eq(simCohorts.branchId, branch.id), eq(simCohorts.cohortId, command.payload.cohortId)));
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
