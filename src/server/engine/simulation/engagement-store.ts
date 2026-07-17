import { and, asc, eq, inArray } from "drizzle-orm";
import {
  endEngagementCommandResultSchema,
  endEngagementCommandSchema,
  engagementSchema,
  engagementsProjectionSchema,
  openEngagementCommandResultSchema,
  openEngagementCommandSchema,
  claimHoldingEngagementStates,
  type EndEngagementCommandResult,
  type Engagement,
  type EngagementsProjection,
  type OpenEngagementCommandResult,
} from "@/contracts/simulation/engagements";
import { worldBranchIdSchema } from "@/contracts/simulation/identity";
import { heldClaimsForActor } from "@/lib/simulation/activities";
import {
  engagementClaimsForActor,
  resolveEndEngagement,
  resolveOpenEngagement,
} from "@/lib/simulation/engagements";
import { loadClaimHoldingActivities } from "./activity-store";
import {
  db,
  simBranches,
  simCharacters,
  simEngagements,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { loadSpaceRows, spaceProjectionFromRows } from "./space-store";
import type { SimTx } from "./trigger-projector";

/**
 * E3.4 slice 1 durable engagement authority: conversations as attention
 * reservations under the same branch transaction every other command uses.
 */

export interface EngagementStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export function engagementFromRow(row: typeof simEngagements.$inferSelect): Engagement {
  return engagementSchema.parse({
    id: row.engagementId,
    participantIds: row.participantIds,
    channel: row.channel,
    ...(row.locationId === null ? {} : { locationId: row.locationId }),
    ...(row.zoneId === null ? {} : { zoneId: row.zoneId }),
    state: row.state,
    openedAt: row.openedAt,
    attentionClaim: row.attentionClaim,
    sourceCommandId: row.sourceCommandId,
  });
}

export function engagementRowInsert(
  branchId: string,
  engagement: Engagement,
  updatedSequence: number,
): typeof simEngagements.$inferInsert {
  return {
    branchId,
    engagementId: engagement.id,
    participantIds: [...engagement.participantIds],
    channel: engagement.channel,
    locationId: engagement.locationId ?? null,
    zoneId: engagement.zoneId ?? null,
    state: engagement.state,
    openedAt: engagement.openedAt,
    attentionClaim: engagement.attentionClaim,
    sourceCommandId: engagement.sourceCommandId,
    updatedSequence,
  };
}

/** Open (claim-holding) engagements on a branch, for claim checks and interrupts. */
export async function loadOpenEngagements(tx: SimTx, branchId: string): Promise<Engagement[]> {
  const rows = await tx
    .select()
    .from(simEngagements)
    .where(
      and(
        eq(simEngagements.branchId, branchId),
        inArray(simEngagements.state, [...claimHoldingEngagementStates]),
      ),
    )
    .orderBy(asc(simEngagements.engagementId));
  return rows.map(engagementFromRow);
}

/** Load the current typed engagements projection without a write lock. */
export async function readDurableEngagements(
  rawBranchId: string,
  database: Db = db(),
): Promise<EngagementsProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const [branch] = await database
    .select({
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
    .from(simEngagements)
    .where(eq(simEngagements.branchId, branchId))
    .orderBy(asc(simEngagements.engagementId));
  return engagementsProjectionSchema.parse({
    branchId,
    headSequence: branch.headSequence,
    version: branch.version,
    storySecond: branch.storySecond,
    engagements: rows.map(engagementFromRow),
  });
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

/** Open one engagement, reserving participant attention atomically (§11.3). */
export async function submitDurableOpenEngagement(
  rawCommand: unknown,
  options: EngagementStoreOptions = {},
): Promise<OpenEngagementCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: openEngagementCommandSchema,
    resultSchema: openEngagementCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That conversation request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That conversation has already been requested."),
    conflictResult: (commandId, currentVersion) =>
      openEngagementCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const actorRows = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(
          and(
            eq(simCharacters.branchId, branch.id),
            inArray(simCharacters.characterId, [...command.payload.participantIds]),
          ),
        );
      const existingActorIds = new Set(actorRows.map((row) => row.characterId));
      const space = spaceProjectionFromRows(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          version: branch.version,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
        },
        await loadSpaceRows(tx, branch.id),
      );
      const openEngagements = await loadOpenEngagements(tx, branch.id);
      const { heldClaimsByActor } = await loadHeldClaims(
        tx,
        branch.id,
        [...command.payload.participantIds],
        openEngagements,
      );
      const zoneLocation = new Map(space.zones.map((zone) => [zone.id, zone.locationId]));

      const participants = command.payload.participantIds.map((actorId) => {
        const locus = space.loci.find((candidate) => candidate.actorId === actorId);
        return {
          actorId,
          exists: existingActorIds.has(actorId),
          ...(locus ? { locus } : {}),
          ...(locus?.kind === "at" ? { locationId: zoneLocation.get(locus.zoneId) ?? locus.locationId } : {}),
          heldClaims: heldClaimsByActor.get(actorId) ?? [],
          inOpenCoPresentEngagement: openEngagements.some(
            (engagement) =>
              engagement.channel === "co_present" && engagement.participantIds.includes(actorId as never),
          ),
        };
      });

      const resolution = resolveOpenEngagement(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          participants,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      await tx
        .insert(simEngagements)
        .values(engagementRowInsert(branch.id, resolution.engagement, resolution.event.sequence));
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

/** End one engagement, releasing its attention claims. */
export async function submitDurableEndEngagement(
  rawCommand: unknown,
  options: EngagementStoreOptions = {},
): Promise<EndEngagementCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: endEngagementCommandSchema,
    resultSchema: endEngagementCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      endEngagementCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [row] = await tx
        .select()
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            eq(simEngagements.engagementId, command.payload.engagementId),
          ),
        )
        .limit(1);
      const engagement = row ? engagementFromRow(row) : undefined;

      const resolution = resolveEndEngagement(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(engagement ? { engagement } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simEngagements)
        .set({ state: "ended", updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            eq(simEngagements.engagementId, resolution.engagement.id),
            inArray(simEngagements.state, [...claimHoldingEngagementStates]),
          ),
        )
        .returning({ engagementId: simEngagements.engagementId });
      if (!updated) throw new Error("Locked engagement changed before its end update");
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

/**
 * Combined claim picture for a set of actors: activity claims plus open
 * engagement claims. Imported lazily by stores that need both without
 * creating a store-to-store cycle.
 */
async function loadHeldClaims(
  tx: SimTx,
  branchId: string,
  actorIds: readonly string[],
  openEngagements: readonly Engagement[],
) {
  const activities = await loadClaimHoldingActivities(tx, branchId);
  const heldClaimsByActor = new Map(
    actorIds.map((actorId) => [
      actorId,
      [...heldClaimsForActor(activities, actorId), ...engagementClaimsForActor(openEngagements, actorId)],
    ]),
  );
  return { heldClaimsByActor };
}
