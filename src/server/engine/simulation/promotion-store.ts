import { and, eq } from "drizzle-orm";
import {
  promoteActorFromCohortCommandResultSchema,
  promoteActorFromCohortCommandSchema,
  type PromoteActorFromCohortCommand,
  type PromoteActorFromCohortCommandResult,
} from "@/contracts/simulation";
import {
  derivedPromotedActorId,
  resolvePromoteActorFromCohortFromView,
} from "@/lib/simulation/promotion";
import {
  simActorLods,
  simCharacters,
  simCohorts,
  simPhysicalLoci,
  simWorlds,
  simZones,
  type Db,
} from "@/server/db";
import { loadCohortRow } from "./cohort-store";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { actorLodRowInsert } from "./lod-store";

/**
 * E6.4 durable actor-promotion authority (engine.spec §27.2, §27.7). One
 * command on the shared `runSimulationCommand` shell commits the whole
 * causation-chained train atomically: the cohort's conserved reservation
 * debit, the `sim_characters` row (the only mid-branch path one comes to
 * exist), the actor's first physical locus, and the landing-LOD pin. Fork
 * children rebuild all four from inherited events — materialized actors are
 * excluded from replay seeds exactly as promoted items are.
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

export interface PromotionSubmitOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export async function submitDurablePromoteActorFromCohort(
  rawCommand: unknown,
  options: PromotionSubmitOptions = {},
): Promise<PromoteActorFromCohortCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: promoteActorFromCohortCommandSchema,
    resultSchema: promoteActorFromCohortCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That promotion request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That promotion has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      promoteActorFromCohortCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: PromoteActorFromCohortCommand) => {
      const cohort = await loadCohortRow(tx, branch.id, command.payload.cohortId);
      const [zoneRow] = await tx
        .select({ locationId: simZones.locationId })
        .from(simZones)
        .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, command.payload.zoneId)))
        .limit(1);
      const [worldRow] = await tx
        .select({ seed: simWorlds.seed })
        .from(simWorlds)
        .where(eq(simWorlds.id, branch.worldId))
        .limit(1);
      if (!worldRow) throw new Error("Simulation world not found for promotion");
      const derivedId = derivedPromotedActorId(branch.id, command.id);
      const [existingActor] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, derivedId)))
        .limit(1);

      const resolution = resolvePromoteActorFromCohortFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          worldSeed: worldRow.seed,
          cohort,
          zoneLocationId: zoneRow?.locationId,
          actorExists: existingActor !== undefined,
          // §26.10 step 3 parity with item promotion: no pool is authored
          // anywhere yet, so callers must supply `name` until one exists (a
          // future data edit, per the registry-as-data convention).
          namePool: () => [],
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [debitEvent, materializedEvent, lodEvent] = resolution.events;
      for (const event of resolution.events) await appendSimulationEvent(tx, event);
      await tx
        .update(simCohorts)
        .set({
          population: resolution.cohortAfter.population,
          updatedSequence: debitEvent.sequence,
        })
        .where(and(eq(simCohorts.branchId, branch.id), eq(simCohorts.cohortId, resolution.cohortAfter.id)));
      await tx.insert(simCharacters).values({
        branchId: branch.id,
        characterId: resolution.actor.id,
        name: resolution.actor.name,
      });
      if (resolution.locus.kind !== "at") throw new Error("A materialized actor's locus must be at a zone");
      await tx.insert(simPhysicalLoci).values({
        branchId: branch.id,
        actorId: resolution.actor.id,
        kind: "at",
        locationId: resolution.locus.locationId,
        zoneId: resolution.locus.zoneId,
        since: resolution.locus.since,
        updatedSequence: materializedEvent.sequence,
      });
      await tx
        .insert(simActorLods)
        .values(actorLodRowInsert(branch.id, resolution.lodState, lodEvent.sequence));
      await advanceLockedBranch(tx, branch, lodEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: debitEvent.sequence,
        lastSequence: lodEvent.sequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
