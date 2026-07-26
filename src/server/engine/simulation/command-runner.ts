import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type {
  SimulationCommandEnvelope,
  SimulationCommandResultRecord,
} from "@/contracts/simulation/branching";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import { branchVersionSchema } from "@/contracts/simulation/identity";
import { db, simBranches, simCommands, simEvents, simWorlds, type Db } from "@/server/db";
import { authorizeSimulationCommand } from "./command-authz";
import { recordCommandKnowledge } from "./knowledge-recorder";
import { enqueueMemoryIndexObligations } from "./memory-index-store";
import { recordCommandObservations } from "./observation-store";
import { recordCommandRelationshipLedger } from "./social-recorder";
import { recordCommandSoftCanon } from "./soft-canon-recorder";
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
  /**
   * `principalId` is load-bearing, not decoration: the shell verifies it against
   * the branch's owning chat before anything is read or written (§Follow-ups 1).
   */
  principal: { kind: PrincipalKind; principalId: string };
  submittedAtWallClock: string;
  type: string;
  schemaVersion: number;
}

export interface LockedBranchView {
  id: string;
  worldId: string;
  worldTypeId: string;
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

  // security-authz.plan.md §Follow-ups item 1 — ownership is proven HERE, above
  // the idempotency fast path and the transaction that owns every write, so a
  // refused command leaves no command row, no ledger entry, no projection, no
  // outbox row, no scheduler row and no event behind. It also sits above the
  // cached-result read: replaying someone else's stored result would leak it.
  const authorization = await authorizeSimulationCommand(
    { branchId: submitted.branchId, commandId: submitted.id, type: submitted.type, principal: submitted.principal },
    database,
  );
  // Not-found-shaped on purpose: a foreign branch reads exactly like an absent
  // one, so the refusal is not a branch-existence oracle. The private cause
  // rides the `sim.command_denied` diagnostic instead.
  if (!authorization.allowed) return args.branchUnavailableResult(submitted.id);

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
        worldTypeId: simWorlds.worldTypeId,
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
          worldTypeId: branch.worldTypeId,
          headSequence: branch.headSequence,
          version: branch.version,
          storySecond: branch.storySecond,
          rulesetVersion: branch.rulesetVersion,
        },
        command,
      );
    }

    // E4.1: perception commits atomically with truth — derive who perceived
    // this command's events against the post-command locus rows (§20). Then
    // E4.2: fold any disclosures through the knowledge ledgers against those
    // fresh observation rows (§21) — order matters, beliefs rest on evidence.
    // E5.5: fold relationship-ledger entries (§21.3) — after knowledge, before
    // soft canon, so a newly-recorded entry is visible to memory-index
    // eligibility in the same transaction. E4.3: fold soft-canon snapshots
    // into the bounded store (§23.4). Last, E4.4: enqueue memory-index
    // obligations for the appended events (§24.3) — indexing itself runs
    // later, off the outbox, never under this lock.
    if (commandResult.status === "accepted") {
      await recordCommandObservations(tx, { id: branch.id, headSequence: branch.headSequence });
      await recordCommandKnowledge(tx, { id: branch.id, headSequence: branch.headSequence });
      await recordCommandRelationshipLedger(tx, { id: branch.id, headSequence: branch.headSequence });
      await recordCommandSoftCanon(tx, { id: branch.id, headSequence: branch.headSequence });
      await enqueueMemoryIndexObligations(tx, {
        id: branch.id,
        worldId: branch.worldId,
        headSequence: branch.headSequence,
      });
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
