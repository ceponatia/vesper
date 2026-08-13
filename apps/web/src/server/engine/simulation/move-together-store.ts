import { and, eq, inArray } from "drizzle-orm";
import { claimHoldingEngagementStates } from "@vesper/simulation-core/contracts/engagements";
import {
  moveTogetherCommandResultSchema,
  moveTogetherCommandSchema,
  type MoveTogetherCommandResult,
  type MoveTogetherRejectionCode,
} from "@vesper/simulation-core/contracts/space";
import { isStandingCoPresentEngagement } from "@vesper/simulation-core/engagements";
import { resolveMoveTogether } from "@vesper/simulation-core/move-together";
import {
  simCharacters,
  simCommitments,
  simEngagements,
  simJourneys,
  simPhysicalLoci,
  type Db,
} from "@/server/db";
import { loadClaimHoldingActivities } from "./activity-store";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { commitmentFromRow } from "./commitment-store";
import { loadOpenEngagements } from "./engagement-store";
import { journeyInsert, loadSpaceRows, spaceProjectionFromRows } from "./space-store";
import { applyTriggerScheduledEvent } from "./trigger-projector";

/**
 * command-integrity A4 — the atomic `move_together` durable authority. The
 * walk-with-me choreography that once committed scene-end + the player move +
 * the primary move as THREE independent transactions (a crash between them
 * stranded the pair — one in transit, one at origin, no recovery) now commits as
 * ONE branch-locked command: scene-end (grace) + one shared journey carrying
 * BOTH actors + one arrival trigger. "Together" is true by construction — the
 * projectors and the arrival resolver already fan out over `Journey.actorIds`, so
 * they need no change. The deterministic `decideAccompany` policy re-runs INSIDE
 * this locked view (§14.2), closing the read-vs-commit agency race.
 */

export interface MoveTogetherStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

function rejected(
  commandId: string,
  code: MoveTogetherRejectionCode,
  publicReason: string,
  legalAlternatives: readonly string[] = [],
): MoveTogetherCommandResult {
  return {
    status: "rejected",
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [...new Set(legalAlternatives)].sort(),
  };
}

/** Execute one MoveTogether against PostgreSQL authority (spec §11.1 shell). */
export async function submitDurableMoveTogether(
  rawCommand: unknown,
  options: MoveTogetherStoreOptions = {},
): Promise<MoveTogetherCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: moveTogetherCommandSchema,
    resultSchema: moveTogetherCommandResultSchema,
    invalidResult: () => rejected("invalid", "invalid_command", "That walk-together request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejected(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejected(commandId, "duplicate_command_id", "That walk-together has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      moveTogetherCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const { actorId: playerActorId, coTravelerActorId } = command.payload;

      const [actorRows, space, openEngagements, activities, commitmentRows] = await Promise.all([
        tx
          .select({ characterId: simCharacters.characterId, name: simCharacters.name })
          .from(simCharacters)
          .where(
            and(
              eq(simCharacters.branchId, branch.id),
              inArray(simCharacters.characterId, [playerActorId, coTravelerActorId]),
            ),
          ),
        loadSpaceRows(tx, branch.id).then((rows) =>
          spaceProjectionFromRows(
            {
              worldId: branch.worldId,
              branchId: branch.id,
              rulesetVersion: branch.rulesetVersion,
              version: branch.version,
              headSequence: branch.headSequence,
              storySecond: branch.storySecond,
            },
            rows,
          ),
        ),
        loadOpenEngagements(tx, branch.id),
        loadClaimHoldingActivities(tx, branch.id),
        tx.select().from(simCommitments).where(eq(simCommitments.branchId, branch.id)),
      ]);

      const nameById = new Map(actorRows.map((row) => [row.characterId, row.name]));
      const playerLocus = space.loci.find((locus) => locus.actorId === playerActorId);
      const coTravelerLocus = space.loci.find((locus) => locus.actorId === coTravelerActorId);
      const standingEngagement = openEngagements.find((engagement) =>
        isStandingCoPresentEngagement(engagement, playerActorId, coTravelerActorId),
      );

      const resolution = resolveMoveTogether(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          topology: { locations: space.locations, zones: space.zones, links: space.links },
          playerExists: nameById.has(playerActorId),
          coTravelerExists: nameById.has(coTravelerActorId),
          ...(playerLocus ? { playerLocus } : {}),
          ...(coTravelerLocus ? { coTravelerLocus } : {}),
          coTravelerName: nameById.get(coTravelerActorId) ?? "They",
          activities,
          commitments: commitmentRows.map(commitmentFromRow),
          ...(standingEngagement ? { standingEngagement } : {}),
        },
        command,
      );
      if (!resolution.ok) {
        return rejected(command.id, resolution.code, resolution.publicReason, resolution.legalAlternatives ?? []);
      }

      // ONE event batch, ONE transaction — the whole point of A4.
      if (resolution.endedEvent) await appendSimulationEvent(tx, resolution.endedEvent);
      await appendSimulationEvent(tx, resolution.plannedEvent);
      await appendSimulationEvent(tx, resolution.departedEvent);
      await appendSimulationEvent(tx, resolution.triggerEvent);
      await applyTriggerScheduledEvent(tx, resolution.triggerEvent, { branchId: branch.id, worldId: branch.worldId });

      const departedSequence = resolution.departedEvent.sequence;
      await tx.insert(simJourneys).values(journeyInsert(branch.id, resolution.journey, departedSequence));

      if (resolution.endedEngagementId && resolution.endedEvent) {
        const [ended] = await tx
          .update(simEngagements)
          .set({ state: "ended", updatedSequence: resolution.endedEvent.sequence })
          .where(
            and(
              eq(simEngagements.branchId, branch.id),
              eq(simEngagements.engagementId, resolution.endedEngagementId),
              inArray(simEngagements.state, [...claimHoldingEngagementStates]),
            ),
          )
          .returning({ engagementId: simEngagements.engagementId });
        if (!ended) throw new Error("Locked engagement changed before its move_together end");
      }

      // Flip BOTH travellers to in_transit in one update — they share the journey,
      // link, and timings, so a single SET covers the pair (they land together).
      const transit = resolution.loci[0];
      if (!transit || transit.kind !== "in_transit") throw new Error("A move_together must produce transit loci");
      const travelerIds = resolution.loci.map((locus) => locus.actorId);
      const flipped = await tx
        .update(simPhysicalLoci)
        .set({
          kind: "in_transit",
          locationId: null,
          zoneId: null,
          since: null,
          journeyId: transit.journeyId,
          linkId: transit.linkId,
          enteredAt: transit.enteredAt,
          earliestExitAt: transit.earliestExitAt,
          updatedSequence: departedSequence,
        })
        .where(
          and(
            eq(simPhysicalLoci.branchId, branch.id),
            inArray(simPhysicalLoci.actorId, travelerIds),
            eq(simPhysicalLoci.kind, "at"),
          ),
        )
        .returning({ actorId: simPhysicalLoci.actorId });
      if (flipped.length !== travelerIds.length) {
        throw new Error("Locked physical loci changed before their move_together transit flip");
      }

      await advanceLockedBranch(tx, branch, resolution.triggerEvent.sequence);

      const firstSequence = resolution.endedEvent?.sequence ?? resolution.plannedEvent.sequence;
      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence,
        lastSequence: resolution.triggerEvent.sequence,
        eventIds: [
          ...(resolution.endedEvent ? [resolution.endedEvent.id] : []),
          resolution.plannedEvent.id,
          resolution.departedEvent.id,
          resolution.triggerEvent.id,
        ],
      };
    },
  });
}
