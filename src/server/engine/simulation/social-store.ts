import { eq } from "drizzle-orm";
import {
  recordRelationshipChangeCommandResultSchema,
  recordRelationshipChangeCommandSchema,
  recordRelationshipEntryCommandResultSchema,
  recordRelationshipEntryCommandSchema,
  type RecordRelationshipChangeCommand,
  type RecordRelationshipChangeCommandResult,
  type RecordRelationshipEntryCommand,
  type RecordRelationshipEntryCommandResult,
} from "@/contracts/simulation/social";
import {
  resolveRecordRelationshipChangeFromView,
  resolveRecordRelationshipEntryFromView,
} from "@/lib/simulation/social";
import { simCharacters, type Db } from "@/server/db";
import { advanceLockedBranch, appendSimulationEvent, runSimulationCommand, type LockedBranchView } from "./command-runner";
import { InjectedSimulationCrash } from "./material-store";
import type { SimTx } from "./trigger-projector";

/**
 * E5.5 slice 1 durable relationship-ledger authority (engine.spec §21.3):
 * `record_relationship_entry` and `record_relationship_change`, the two
 * privileged authoring commands. Modeled on `household-store.ts`'s
 * `create_household`/`set_household_membership` shape — both commands are
 * event-append-only, no lazy-init, no triggers, so this store's choreography
 * is the simplest of the E5.x durable stores.
 *
 * The ledger row itself is written by `social-recorder.ts`'s
 * `recordCommandRelationshipLedger`, invoked by `command-runner.ts`'s shell
 * right after this command's event commits — NOT by this file, mirroring how
 * `knowledge-store.ts`'s `make_disclosure` never writes an assertion/belief
 * row itself. The row mapping (`relationshipLedgerEntryFromRow`/
 * `relationshipLedgerEntryRowInsert`) lives in `social-recorder.ts`, NOT
 * here — this file must not import the recorder (it would close a cycle back
 * through `command-runner.ts`, which imports the recorder to wire it into
 * the §11.1 shell), mirroring exactly how `knowledge-store.ts` never imports
 * `knowledge-recorder.ts`'s row mappers either.
 */

export type DurableRelationshipCrashPoint = "after_event_append" | "after_branch_advance" | "after_commit";

export interface RelationshipSubmitOptions {
  database?: Db;
  crashAt?: DurableRelationshipCrashPoint;
  admitAtLockedVersion?: boolean;
}

function injectCrash(
  configured: DurableRelationshipCrashPoint | undefined,
  point: Exclude<DurableRelationshipCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
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

// ---------------------------------------------------------------------------
// Authority context — just actor existence; neither slice-1 command touches
// households, means, or the ledger itself.
// ---------------------------------------------------------------------------

async function loadRelationshipActorIds(tx: SimTx, branchId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ characterId: simCharacters.characterId })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  return new Set(rows.map((row) => row.characterId));
}

// ---------------------------------------------------------------------------
// record_relationship_entry (§5.2)
// ---------------------------------------------------------------------------

export async function submitDurableRecordRelationshipEntry(
  rawCommand: unknown,
  options: RelationshipSubmitOptions = {},
): Promise<RecordRelationshipEntryCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: recordRelationshipEntryCommandSchema,
    resultSchema: recordRelationshipEntryCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That relationship entry is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That relationship entry has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      recordRelationshipEntryCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RecordRelationshipEntryCommand) => {
      const actorIds = await loadRelationshipActorIds(tx, branch.id);
      const resolution = resolveRecordRelationshipEntryFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: (actorId) => actorIds.has(actorId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

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

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// record_relationship_change (§5.3)
// ---------------------------------------------------------------------------

export async function submitDurableRecordRelationshipChange(
  rawCommand: unknown,
  options: RelationshipSubmitOptions = {},
): Promise<RecordRelationshipChangeCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: recordRelationshipChangeCommandSchema,
    resultSchema: recordRelationshipChangeCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That relationship change is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That relationship change has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      recordRelationshipChangeCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RecordRelationshipChangeCommand) => {
      const actorIds = await loadRelationshipActorIds(tx, branch.id);
      const resolution = resolveRecordRelationshipChangeFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: (actorId) => actorIds.has(actorId),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

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

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}
