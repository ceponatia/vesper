import { and, eq } from "drizzle-orm";
import { composeSimulationId } from "@/contracts/simulation/identity";
import {
  demoteSoftCanonCommandResultSchema,
  demoteSoftCanonCommandSchema,
  SOFT_CANON_DERIVATION_VERSION,
  softCanonDemotedEventSchema,
  type DemoteSoftCanonCommandResult,
  type DemoteSoftCanonRejectionCode,
} from "@/contracts/simulation/soft-canon";
import { resolveDemoteSoftCanon } from "@/lib/simulation/soft-canon";
import { simSoftCanon, type Db } from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { softCanonEntryFromRow } from "./soft-canon-recorder";

/**
 * E4.3 — ruling 14's demotion path: an explicit, audited storyteller command
 * that retracts a soft-canon record (promoted or still active) without
 * touching event history. The row update itself rides the shell's
 * `recordCommandSoftCanon` fold, exactly like every other soft-canon write.
 */

export interface SoftCanonStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

function rejectedResult(
  commandId: string,
  code: DemoteSoftCanonRejectionCode,
  publicReason: string,
): DemoteSoftCanonCommandResult {
  return demoteSoftCanonCommandResultSchema.parse({
    status: "rejected",
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  });
}

export async function submitDurableDemoteSoftCanon(
  rawCommand: unknown,
  options: SoftCanonStoreOptions = {},
): Promise<DemoteSoftCanonCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: demoteSoftCanonCommandSchema,
    resultSchema: demoteSoftCanonCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That demotion is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That demotion has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      demoteSoftCanonCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      // Ruling 4: privileged canon surgery is storyteller-mode only, audited.
      if (command.principal.kind !== "storyteller") {
        return rejectedResult(command.id, "unauthorized_principal", "Only a storyteller can retract canon.");
      }
      const [entryRow] = await tx
        .select()
        .from(simSoftCanon)
        .where(and(eq(simSoftCanon.branchId, branch.id), eq(simSoftCanon.entryId, command.payload.entryId)))
        .limit(1);
      const resolution = resolveDemoteSoftCanon(
        entryRow ? softCanonEntryFromRow(entryRow) : undefined,
        branch.storySecond,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const eventId = composeSimulationId("event", [branch.id, command.id, "soft-canon-demoted"]);
      const event = softCanonDemotedEventSchema.parse({
        id: eventId,
        worldId: branch.worldId,
        branchId: branch.id,
        sequence: branch.headSequence + 1,
        storySecond: branch.storySecond,
        type: "soft_canon_demoted",
        schemaVersion: 1,
        rulesetVersion: branch.rulesetVersion,
        derivationVersion: SOFT_CANON_DERIVATION_VERSION,
        commandId: command.id,
        correlationId: command.correlationId,
        actorIds: [],
        entityIds: [...resolution.entry.subjectIds].sort(),
        recordedAtWallClock: command.submittedAtWallClock,
        payload: {
          entry: { ...resolution.entry, statusCauseEventId: eventId },
          reason: command.payload.reason,
        },
      });
      await appendSimulationEvent(tx, event);
      await advanceLockedBranch(tx, branch, event.sequence);

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
}
