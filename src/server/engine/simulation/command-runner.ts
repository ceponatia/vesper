import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type {
  SimulationCommandEnvelope,
  SimulationCommandResultRecord,
} from "@/contracts/simulation/branching";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import { branchVersionSchema } from "@/contracts/simulation/identity";
import { db, simBranches, simCommands, simEvents, simWorlds, type Db } from "@/server/db";
import type { SimTx } from "./trigger-projector";

/**
 * The shared §11.1 command transaction shell: idempotency fast path, branch
 * row lock, locked-version admission, duplicate-command defense, optimistic
 * version check, and durable result persistence. Domain stores supply only
 * the view load + resolution + projection writes (`execute`).
 *
 * E3.2 introduces this seam; earlier stores predate it and keep their inlined
 * copies until a dedicated cleanup migrates them.
 */

interface RunnableCommand {
  id: string;
  branchId: string;
  expectedVersion: number;
  idempotencyKey: string;
  principal: { kind: PrincipalKind };
  submittedAtWallClock: string;
  type: string;
  schemaVersion: number;
}

export interface LockedBranchView {
  id: string;
  worldId: string;
  headSequence: number;
  version: number;
  storySecond: number;
  rulesetVersion: string;
}

export interface RunSimulationCommandArgs<
  TCommand extends RunnableCommand,
  TResult extends { status: "accepted" | "rejected" | "conflict" },
> {
  rawCommand: unknown;
  commandSchema: z.ZodType<TCommand>;
  resultSchema: z.ZodType<TResult>;
  invalidResult: () => TResult;
  branchUnavailableResult: (commandId: string) => TResult;
  duplicateCommandIdResult: (commandId: string) => TResult;
  conflictResult: (commandId: string, currentVersion: number) => TResult;
  /**
   * Domain resolution inside the locked transaction: load the authority view,
   * run the pure resolver, apply projection writes and the branch advance for
   * accepted outcomes, and return the command result. Never call a model or
   * network under this lock.
   */
  execute: (tx: SimTx, branch: LockedBranchView, command: TCommand) => Promise<TResult>;
  database?: Db;
  admitAtLockedVersion?: boolean;
}

export async function runSimulationCommand<
  TCommand extends RunnableCommand,
  TResult extends { status: "accepted" | "rejected" | "conflict" },
>(args: RunSimulationCommandArgs<TCommand, TResult>): Promise<TResult> {
  const parsed = args.commandSchema.safeParse(args.rawCommand);
  if (!parsed.success) return args.invalidResult();
  const submitted = parsed.data;
  const database = args.database ?? db();

  const [preLockCached] = await database
    .select({ result: simCommands.result })
    .from(simCommands)
    .where(
      and(eq(simCommands.branchId, submitted.branchId), eq(simCommands.idempotencyKey, submitted.idempotencyKey)),
    )
    .limit(1);
  if (preLockCached) return args.resultSchema.parse(preLockCached.result);

  return database.transaction(async (tx) => {
    const [branch] = await tx
      .select({
        id: simBranches.id,
        worldId: simBranches.worldId,
        headSequence: simBranches.headSequence,
        version: simBranches.version,
        storySecond: simBranches.storySecond,
        rulesetVersion: simWorlds.rulesetVersion,
        worldStatus: simWorlds.status,
      })
      .from(simBranches)
      .innerJoin(simWorlds, eq(simWorlds.id, simBranches.worldId))
      .where(eq(simBranches.id, submitted.branchId))
      .limit(1)
      // Only the branch row is the sequencing mutex; locking the joined world
      // row would serialize independent branches in one world.
      .for("update", { of: simBranches });
    if (!branch) return args.branchUnavailableResult(submitted.id);

    // Resolve the admitted version only once the branch lock is held, so a
    // locked-version admission cannot race the value it is admitted at.
    const command: TCommand = args.admitAtLockedVersion
      ? { ...submitted, expectedVersion: branchVersionSchema.parse(branch.version) }
      : submitted;

    // The pre-lock read is only a fast path; idempotency is re-checked under
    // the lock because a peer may have committed while this transaction waited.
    const [cached] = await tx
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.idempotencyKey, command.idempotencyKey)))
      .limit(1);
    if (cached) return args.resultSchema.parse(cached.result);

    const [sameCommandId] = await tx
      .select({ idempotencyKey: simCommands.idempotencyKey })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.commandId, command.id)))
      .limit(1);

    let commandResult: TResult;
    if (sameCommandId) {
      commandResult = args.duplicateCommandIdResult(command.id);
    } else if (branch.worldStatus !== "active") {
      commandResult = args.branchUnavailableResult(command.id);
    } else if (command.expectedVersion !== branch.version) {
      commandResult = args.conflictResult(command.id, branch.version);
    } else {
      commandResult = await args.execute(
        tx,
        {
          id: branch.id,
          worldId: branch.worldId,
          headSequence: branch.headSequence,
          version: branch.version,
          storySecond: branch.storySecond,
          rulesetVersion: branch.rulesetVersion,
        },
        command,
      );
    }

    await tx.insert(simCommands).values({
      branchId: command.branchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      expectedVersion: command.expectedVersion,
      principalKind: command.principal.kind,
      envelope: command as unknown as SimulationCommandEnvelope,
      status: commandResult.status,
      result: commandResult as unknown as SimulationCommandResultRecord,
      submittedAt: new Date(command.submittedAtWallClock),
    });
    return commandResult;
  });
}

/** Compare-and-swap the branch head after appending events (spec §11.1 step 12). */
export async function advanceLockedBranch(
  tx: SimTx,
  branch: LockedBranchView,
  lastSequence: number,
): Promise<void> {
  const advanced = await tx
    .update(simBranches)
    .set({ headSequence: lastSequence, version: branch.version + 1 })
    .where(
      and(
        eq(simBranches.id, branch.id),
        eq(simBranches.version, branch.version),
        eq(simBranches.headSequence, branch.headSequence),
      ),
    )
    .returning({ id: simBranches.id });
  if (advanced.length !== 1) {
    throw new Error("Locked simulation branch failed its compare-and-swap advance");
  }
}

/** Append one parsed event envelope inside the command transaction. */
export async function appendSimulationEvent(
  tx: SimTx,
  event: {
    id: string;
    worldId: string;
    branchId: string;
    sequence: number;
    storySecond: number;
    type: string;
    schemaVersion: number;
    rulesetVersion: string;
    derivationVersion?: string;
    commandId?: string;
    causationId?: string;
    correlationId: string;
    actorIds: readonly string[];
    entityIds: readonly string[];
    locationId?: string;
    recordedAtWallClock: string;
    payload: unknown;
  },
): Promise<void> {
  await tx.insert(simEvents).values({
    id: event.id,
    worldId: event.worldId,
    branchId: event.branchId,
    sequence: event.sequence,
    storySecond: event.storySecond,
    type: event.type,
    schemaVersion: event.schemaVersion,
    rulesetVersion: event.rulesetVersion,
    derivationVersion: event.derivationVersion,
    commandId: event.commandId,
    causationId: event.causationId,
    correlationId: event.correlationId,
    actorIds: [...event.actorIds],
    entityIds: [...event.entityIds],
    locationId: event.locationId,
    recordedAt: new Date(event.recordedAtWallClock),
    payload: event.payload,
  });
}
