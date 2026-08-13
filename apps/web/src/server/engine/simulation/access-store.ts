import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accessGrantSchema,
  attemptEntryCommandResultSchema,
  attemptEntryCommandSchema,
  storytellerRelocateActorCommandResultSchema,
  storytellerRelocateActorCommandSchema,
  type AccessGrant,
  type AttemptEntryCommandResult,
  type StorytellerRelocateActorCommandResult,
} from "@vesper/simulation-core/contracts/access";
import {
  activityClaimSchema,
  claimHoldingActivityPhases,
} from "@vesper/simulation-core/contracts/activities";
import { worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import { resolveAttemptEntry, resolveStorytellerRelocation } from "@vesper/simulation-core/access";
import { journeyArrivalUniquenessKey } from "@vesper/simulation-core/space";
import {
  db,
  simAccessGrants,
  simActivities,
  simCharacters,
  simJourneys,
  simPhysicalLoci,
  simTriggers,
  simWorlds,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import {
  interruptCoPresentEngagementsForActor,
  journeyFromRow,
  loadSpaceRows,
  locusFromRow,
  spaceProjectionFromRows,
} from "./space-store";
import type { SimTx } from "./trigger-projector";

/**
 * E3.5 durable access authority: threshold entry (granted or explicitly
 * forced) and the audited storyteller relocation. Both flow through the same
 * §11.1 transaction shell as every other command.
 */

export interface AccessStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

const accessGrantSeedSchema = z
  .object({
    branchId: worldBranchIdSchema,
    grants: z.array(accessGrantSchema).min(1),
  })
  .strict();

export type AccessGrantSeed = z.input<typeof accessGrantSeedSchema>;

/** Seed authored grants (owner/resident/key…). Grants are data, not events. */
export async function seedDurableAccessGrants(
  rawSeed: AccessGrantSeed,
  options: { database?: Db } = {},
): Promise<void> {
  const seed = accessGrantSeedSchema.parse(rawSeed);
  const database = options.database ?? db();
  await database.insert(simAccessGrants).values(
    seed.grants.map((grant) => ({
      branchId: seed.branchId,
      grantId: grant.id,
      granteeActorId: grant.granteeActorId,
      locationId: grant.locationId,
      zoneIds: grant.zoneIds ? [...grant.zoneIds] : null,
      basis: grant.basis,
      validFrom: grant.validFrom,
      validUntil: grant.validUntil ?? null,
      revokedAt: grant.revokedAt ?? null,
    })),
  );
}

/** Well-formed grants only: a row that fails its schema admits no one (§13.1). */
async function loadActorGrants(tx: SimTx, branchId: string, actorId: string): Promise<AccessGrant[]> {
  const rows = await tx
    .select()
    .from(simAccessGrants)
    .where(and(eq(simAccessGrants.branchId, branchId), eq(simAccessGrants.granteeActorId, actorId)));
  return rows.flatMap((row) => {
    const parsed = accessGrantSchema.safeParse({
      id: row.grantId,
      granteeActorId: row.granteeActorId,
      locationId: row.locationId,
      ...(row.zoneIds === null ? {} : { zoneIds: row.zoneIds }),
      basis: row.basis,
      validFrom: row.validFrom,
      ...(row.validUntil === null ? {} : { validUntil: row.validUntil }),
      ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

function rejectedResult<TCode extends string>(
  commandId: string,
  code: TCode,
  publicReason: string,
  legalAlternativeCommandTypes: string[] = [],
) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes,
  };
}

/** One threshold crossing: doorstep to interior, by grant or explicit force. */
export async function submitDurableAttemptEntry(
  rawCommand: unknown,
  options: AccessStoreOptions = {},
): Promise<AttemptEntryCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: attemptEntryCommandSchema,
    resultSchema: attemptEntryCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That entry request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That entry has already been attempted."),
    conflictResult: (commandId, currentVersion) =>
      attemptEntryCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
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
      const [world] = await tx
        .select({ permitsTrespass: simWorlds.permitsTrespass })
        .from(simWorlds)
        .where(eq(simWorlds.id, branch.worldId))
        .limit(1);
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
      const locus = space.loci.find((candidate) => candidate.actorId === command.payload.actorId);
      const link = space.links.find((candidate) => candidate.id === command.payload.linkId);
      const farZoneId =
        link && locus?.kind === "at"
          ? locus.zoneId === link.fromZoneId
            ? link.toZoneId
            : link.fromZoneId
          : undefined;
      const destinationZone = space.zones.find((candidate) => candidate.id === farZoneId);
      const grants = await loadActorGrants(tx, branch.id, command.payload.actorId);
      const claimRows = await tx
        .select({ claims: simActivities.claims })
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            inArray(simActivities.phase, [...claimHoldingActivityPhases]),
            sql`${simActivities.actorIds} @> ${JSON.stringify([command.payload.actorId])}::jsonb`,
          ),
        );
      const actorHoldsBodyClaim = claimRows.some((row) =>
        z.array(activityClaimSchema).parse(row.claims).some((claim) => claim.kind === "body"),
      );
      const coLocatedActorIds = space.loci
        .filter(
          (candidate) =>
            candidate.kind === "at" &&
            candidate.actorId !== command.payload.actorId &&
            (candidate.zoneId === (locus?.kind === "at" ? locus.zoneId : "") ||
              candidate.zoneId === farZoneId),
        )
        .map((candidate) => candidate.actorId);

      const resolution = resolveAttemptEntry(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          ...(locus ? { locus } : {}),
          ...(link ? { link } : {}),
          ...(destinationZone ? { destinationZone } : {}),
          grants,
          worldPermitsTrespass: world?.permitsTrespass ?? false,
          actorHoldsBodyClaim,
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) {
        return rejectedResult(
          command.id,
          resolution.code,
          resolution.publicReason,
          resolution.legalAlternativeCommandTypes,
        );
      }

      await appendSimulationEvent(tx, resolution.event);
      const [flipped] = await tx
        .update(simPhysicalLoci)
        .set({
          kind: "at",
          locationId: resolution.locus.kind === "at" ? resolution.locus.locationId : null,
          zoneId: resolution.locus.kind === "at" ? resolution.locus.zoneId : null,
          since: branch.storySecond,
          journeyId: null,
          linkId: null,
          enteredAt: null,
          earliestExitAt: null,
          updatedSequence: resolution.event.sequence,
        })
        .where(
          and(
            eq(simPhysicalLoci.branchId, branch.id),
            eq(simPhysicalLoci.actorId, command.payload.actorId),
            eq(simPhysicalLoci.kind, "at"),
          ),
        )
        .returning({ actorId: simPhysicalLoci.actorId });
      if (!flipped) throw new Error("Locked physical locus changed before its entry flip");

      // Crossing a threshold leaves the previous zone: any open co-present
      // scene there is interrupted, exactly as an ordinary departure.
      const lastSequence = await interruptCoPresentEngagementsForActor(tx, {
        branch: {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
        },
        command: {
          id: command.id,
          correlationId: command.correlationId,
          submittedAtWallClock: command.submittedAtWallClock,
        },
        actorId: command.payload.actorId,
        causationId: resolution.event.id,
        startSequence: resolution.event.sequence,
      });
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/** The privileged relocation (§7, ruling 4): storyteller principals only, audited. */
export async function submitDurableStorytellerRelocation(
  rawCommand: unknown,
  options: AccessStoreOptions = {},
): Promise<StorytellerRelocateActorCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: storytellerRelocateActorCommandSchema,
    resultSchema: storytellerRelocateActorCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That relocation request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That relocation has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      storytellerRelocateActorCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
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
      const locus = locusRow ? locusFromRow(locusRow) : undefined;
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
      const destinationZone = space.zones.find(
        (candidate) => candidate.id === command.payload.destinationZoneId,
      );
      const journeyRow =
        locus?.kind === "in_transit"
          ? (
              await tx
                .select()
                .from(simJourneys)
                .where(and(eq(simJourneys.branchId, branch.id), eq(simJourneys.journeyId, locus.journeyId)))
                .limit(1)
            )[0]
          : undefined;

      const resolution = resolveStorytellerRelocation(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          ...(locus ? { locus } : {}),
          ...(destinationZone ? { destinationZone } : {}),
          ...(journeyRow ? { journey: journeyFromRow(journeyRow) } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      for (const event of resolution.events) await appendSimulationEvent(tx, event);
      if (resolution.abandonedJourneyId) {
        await tx
          .update(simJourneys)
          .set({ status: "abandoned", updatedSequence: resolution.events[0].sequence })
          .where(
            and(eq(simJourneys.branchId, branch.id), eq(simJourneys.journeyId, resolution.abandonedJourneyId)),
          );
        // Retire the pending arrival: an abandoned journey never arrives.
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
              eq(simTriggers.uniquenessKey, journeyArrivalUniquenessKey(resolution.abandonedJourneyId)),
              eq(simTriggers.state, "pending"),
            ),
          );
      }
      const [flipped] = await tx
        .update(simPhysicalLoci)
        .set({
          kind: "at",
          locationId: resolution.locus.kind === "at" ? resolution.locus.locationId : null,
          zoneId: resolution.locus.kind === "at" ? resolution.locus.zoneId : null,
          since: branch.storySecond,
          journeyId: null,
          linkId: null,
          enteredAt: null,
          earliestExitAt: null,
          updatedSequence: resolution.events.at(-1)?.sequence ?? branch.headSequence + 1,
        })
        .where(
          and(eq(simPhysicalLoci.branchId, branch.id), eq(simPhysicalLoci.actorId, command.payload.actorId)),
        )
        .returning({ actorId: simPhysicalLoci.actorId });
      if (!flipped) throw new Error("Locked physical locus changed before its relocation flip");

      const relocationEvent = resolution.events.at(-1);
      if (!relocationEvent) throw new Error("Relocation resolved without events");
      const lastSequence = await interruptCoPresentEngagementsForActor(tx, {
        branch: {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
        },
        command: {
          id: command.id,
          correlationId: command.correlationId,
          submittedAtWallClock: command.submittedAtWallClock,
        },
        actorId: command.payload.actorId,
        causationId: relocationEvent.id,
        startSequence: relocationEvent.sequence,
      });
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.events[0].sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
