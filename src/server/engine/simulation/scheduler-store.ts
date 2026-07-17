import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import {
  deriveTriggerId,
  scheduledTransferTriggerKind,
  scheduledTransferTriggerSchemaVersion,
  schedulerRetryDelaySeconds,
  simulationTriggerSchema,
  type SimulationTrigger,
} from "@/contracts/simulation/scheduler";
import { composeSimulationId } from "@/contracts/simulation/identity";
import { db, simBranches, simTriggers, type Db } from "@/server/db";
import { submitDurableItemTransfer } from "./item-transfer-store";

export interface ScheduleTriggerOptions {
  database?: Db;
}

export interface ClaimTriggerOptions {
  workerId: string;
  leaseSeconds?: number;
  now?: Date;
  database?: Db;
}

export interface ResolveTriggerOptions extends ClaimTriggerOptions {
  maxAttempts?: number;
}

function boundedDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}

/** Insert one branch-unique trigger and assign its immutable simultaneous-order key. */
export async function scheduleDurableTrigger(
  rawTrigger: Omit<SimulationTrigger, "id" | "stableOrder">,
  options: ScheduleTriggerOptions = {},
): Promise<SimulationTrigger> {
  const database = options.database ?? db();
  return database.transaction(async (tx) => {
    const [branch] = await tx
      .select({ id: simBranches.id, worldId: simBranches.worldId })
      .from(simBranches)
      .where(eq(simBranches.id, rawTrigger.branchId))
      .limit(1)
      .for("update");
    if (!branch || branch.worldId !== rawTrigger.worldId) {
      throw new Error("Cannot schedule a trigger for an unavailable branch");
    }

    const [existing] = await tx
      .select()
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, rawTrigger.branchId),
          eq(simTriggers.uniquenessKey, rawTrigger.uniquenessKey),
        ),
      )
      .limit(1);
    if (existing) return simulationTriggerSchema.parse(existing);

    const [orderRow] = await tx
      .select({ next: sql<number>`coalesce(max(${simTriggers.stableOrder}), 0) + 1` })
      .from(simTriggers)
      .where(eq(simTriggers.branchId, rawTrigger.branchId));

    const trigger = simulationTriggerSchema.parse({
      ...rawTrigger,
      id: deriveTriggerId(rawTrigger.branchId, rawTrigger.uniquenessKey),
      stableOrder: Number(orderRow?.next ?? 1),
    });
    await tx.insert(simTriggers).values(trigger);
    return trigger;
  });
}

/** Claim the globally earliest eligible trigger; ties are stable across workers. */
export async function claimDueTrigger(options: ClaimTriggerOptions): Promise<SimulationTrigger | null> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const leaseSeconds = options.leaseSeconds ?? 30;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new RangeError("leaseSeconds must be an integer from 1 through 3600");
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({ trigger: simTriggers })
      .from(simTriggers)
      .innerJoin(simBranches, eq(simBranches.id, simTriggers.branchId))
      .where(
        and(
          lte(simTriggers.dueStorySecond, simBranches.storySecond),
          lte(simTriggers.availableAt, now),
          or(
            eq(simTriggers.state, "pending"),
            and(eq(simTriggers.state, "processing"), lte(simTriggers.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(asc(simTriggers.dueStorySecond), asc(simTriggers.stableOrder), asc(simTriggers.id))
      .limit(1)
      .for("update", { of: simTriggers, skipLocked: true });
    if (!row) return null;

    await tx
      .update(simTriggers)
      .set({
        state: "processing",
        leaseOwner: options.workerId,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(simTriggers.id, row.trigger.id));

    return simulationTriggerSchema.parse(row.trigger);
  });
}

/**
 * Resolve one scheduled transfer through the existing branch command transaction.
 * Trigger retries reuse a derived command/idempotency identity, so a crash after the
 * command commits but before trigger completion cannot duplicate the event.
 */
export async function resolveNextDueTrigger(
  options: ResolveTriggerOptions,
): Promise<{ triggerId: string; outcome: "idle" | "completed" | "retry" | "failed" }> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const trigger = await claimDueTrigger({ ...options, database, now });
  if (!trigger) return { triggerId: "", outcome: "idle" };

  try {
    if (trigger.kind !== scheduledTransferTriggerKind) {
      throw new Error(`Unsupported trigger kind: ${trigger.kind}`);
    }
    const [branch] = await database
      .select({ version: simBranches.version })
      .from(simBranches)
      .where(eq(simBranches.id, trigger.branchId))
      .limit(1);
    if (!branch) throw new Error("Trigger branch disappeared");

    const template = trigger.payload.command;
    const commandId = composeSimulationId("trigger-command", [trigger.id]);
    const result = await submitDurableItemTransfer(
      {
        ...template,
        id: commandId,
        idempotencyKey: commandId,
        expectedVersion: branch.version,
        submittedAtWallClock: now.toISOString(),
      },
      { database },
    );

    await database
      .update(simTriggers)
      .set({
        state: "completed",
        resultCommandId: result.commandId,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(simTriggers.id, trigger.id),
          eq(simTriggers.state, "processing"),
          eq(simTriggers.leaseOwner, options.workerId),
        ),
      );
    return { triggerId: trigger.id, outcome: "completed" };
  } catch (error) {
    const [row] = await database
      .select({ attempts: simTriggers.attempts })
      .from(simTriggers)
      .where(eq(simTriggers.id, trigger.id))
      .limit(1);
    const attempts = (row?.attempts ?? 0) + 1;
    const terminal = attempts >= (options.maxAttempts ?? 5);
    const availableAt = new Date(now.getTime() + schedulerRetryDelaySeconds(attempts) * 1000);
    await database
      .update(simTriggers)
      .set({
        state: terminal ? "failed" : "pending",
        attempts,
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: boundedDiagnostic(error),
        updatedAt: now,
      })
      .where(eq(simTriggers.id, trigger.id));
    return { triggerId: trigger.id, outcome: terminal ? "failed" : "retry" };
  }
}

export const e24ScheduledTransferTrigger = {
  kind: scheduledTransferTriggerKind,
  schemaVersion: scheduledTransferTriggerSchemaVersion,
} as const;
