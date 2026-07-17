import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  deriveTriggerId,
  scheduledTransferTriggerKind,
  schedulerDerivationVersion,
  schedulerRetryDelaySeconds,
  simulationTriggerSchema,
  type SimulationTrigger,
} from "@/contracts/simulation/scheduler";
import { composeSimulationId, storySecondSchema } from "@/contracts/simulation/identity";
import { db, simBranches, simTriggers, type Db } from "@/server/db";
import { submitDurableItemTransfer } from "./item-transfer-store";

export interface ScheduleTriggerOptions {
  database?: Db;
}

/**
 * Callers supply unbranded identifiers; branding is the schema's job, and this
 * function parses before it writes.
 */
export type ScheduleTriggerInput = Omit<
  z.input<typeof simulationTriggerSchema>,
  "id" | "stableOrder"
>;

export interface ClaimTriggerOptions {
  workerId: string;
  leaseSeconds?: number;
  now?: Date;
  database?: Db;
}

export interface ResolveTriggerOptions extends ClaimTriggerOptions {
  maxAttempts?: number;
}

export interface AdvanceStoryTimeOptions extends ResolveTriggerOptions {
  /** Hard ceiling on triggers drained in one advance. */
  maxTriggers?: number;
  /** Wall-clock budget in milliseconds for the drain loop. */
  budgetMs?: number;
}

/**
 * A claimed trigger plus the attempt number assigned when it was claimed.
 * Attempts increment at claim time, not at failure time: a worker that dies mid
 * resolution never runs its own failure path, so a failure-time increment lets a
 * crash-looping trigger be reclaimed forever without ever reaching maxAttempts.
 */
interface ClaimedTrigger {
  trigger: SimulationTrigger;
  attempts: number;
}

/**
 * Claiming either takes the work or quarantines it. A worker that dies mid
 * resolution never runs its own failure path, so terminal state cannot only be
 * written there: an exhausted trigger must be retired by whoever next tries to
 * claim it, or a crash loop reclaims it forever and never reaches maxAttempts.
 */
type ClaimResult =
  | { kind: "claimed"; claimed: ClaimedTrigger }
  | { kind: "quarantined"; trigger: SimulationTrigger; attempts: number };

export type ResolveTriggerOutcome =
  | { status: "idle" }
  | { status: "completed"; triggerId: string; commandId: string }
  | { status: "rejected"; triggerId: string; code: string }
  | { status: "retry"; triggerId: string; attempts: number; availableAt: Date }
  | { status: "failed"; triggerId: string; attempts: number }
  | { status: "lease_lost"; triggerId: string };

export type AdvanceStoryTimeOutcome =
  | { status: "advanced"; branchId: string; storySecond: number; drained: number }
  | {
      status: "catch_up_required";
      branchId: string;
      storySecond: number;
      drained: number;
      reason: "trigger_budget" | "time_budget";
    };

function safeDiagnostic(error: unknown, claimed: ClaimedTrigger): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "Trigger resolution failed";
  return `trigger=${claimed.trigger.id} branch=${claimed.trigger.branchId} due=${claimed.trigger.dueStorySecond} kind=${claimed.trigger.kind} attempt=${claimed.attempts} ${name}: ${message}`
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 500);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be positive`);
  return value;
}

/** Insert one branch-unique trigger and assign its immutable simultaneous-order key. */
export async function scheduleDurableTrigger(
  rawTrigger: ScheduleTriggerInput,
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

/**
 * Claim the earliest eligible trigger on one branch and increment its attempt
 * count in the same transaction. Ties break by stable order then ID, so workers
 * racing one due second agree on which trigger is next.
 */
async function claimDueTrigger(
  branchId: string,
  maxAttempts: number,
  options: ClaimTriggerOptions,
): Promise<ClaimResult | null> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const leaseSeconds = options.leaseSeconds ?? 30;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw new RangeError("leaseSeconds must be an integer from 1 through 3600");
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

  return database.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ trigger: simTriggers })
      .from(simTriggers)
      .innerJoin(simBranches, eq(simBranches.id, simTriggers.branchId))
      .where(
        and(
          eq(simTriggers.branchId, branchId),
          lte(simTriggers.dueStorySecond, simBranches.storySecond),
          lte(simTriggers.availableAt, now),
          or(
            eq(simTriggers.state, "pending"),
            and(eq(simTriggers.state, "processing"), lte(simTriggers.leaseExpiresAt, now)),
          ),
        ),
      )
      .orderBy(
        asc(simTriggers.dueStorySecond),
        asc(simTriggers.priority),
        asc(simTriggers.stableOrder),
        asc(simTriggers.id),
      )
      .limit(1)
      .for("update", { of: simTriggers, skipLocked: true });
    if (!candidate) return null;

    const trigger = simulationTriggerSchema.parse(candidate.trigger);

    // Retire work that has already spent its budget. Reaching here with attempts
    // at the ceiling means previous workers died before their failure path ran.
    if (candidate.trigger.attempts >= maxAttempts) {
      await tx
        .update(simTriggers)
        .set({
          state: "failed",
          derivationVersion: schedulerDerivationVersion,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: `trigger=${trigger.id} branch=${trigger.branchId} exhausted ${candidate.trigger.attempts}/${maxAttempts} attempts without a terminal outcome`,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(simTriggers.id, trigger.id));
      return { kind: "quarantined", trigger, attempts: candidate.trigger.attempts };
    }

    const [claimed] = await tx
      .update(simTriggers)
      .set({
        state: "processing",
        attempts: sql`${simTriggers.attempts} + 1`,
        leaseOwner: options.workerId,
        leaseExpiresAt,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(simTriggers.id, candidate.trigger.id))
      .returning({ attempts: simTriggers.attempts });
    if (!claimed) return null;

    return { kind: "claimed", claimed: { trigger, attempts: claimed.attempts } };
  });
}

/**
 * Resolve one due trigger on a branch through the same command transaction a
 * player command uses. Retries reuse a derived command identity and idempotency
 * key, so a crash after the command commits but before the trigger row is
 * completed cannot duplicate the event.
 */
export async function resolveNextDueTrigger(
  branchId: string,
  options: ResolveTriggerOptions,
): Promise<ResolveTriggerOutcome> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const maxAttempts = positiveSafeInteger(options.maxAttempts ?? 5, "maxAttempts");
  const claim = await claimDueTrigger(branchId, maxAttempts, { ...options, database, now });
  if (!claim) return { status: "idle" };
  if (claim.kind === "quarantined") {
    return { status: "failed", triggerId: claim.trigger.id, attempts: claim.attempts };
  }
  const claimed = claim.claimed;
  const { trigger } = claimed;

  /** Every terminal write is fenced on this worker still owning the lease. */
  const fence = and(
    eq(simTriggers.id, trigger.id),
    eq(simTriggers.state, "processing"),
    eq(simTriggers.leaseOwner, options.workerId),
  );

  try {
    if (trigger.kind !== scheduledTransferTriggerKind) {
      throw new Error(`Unsupported trigger kind: ${trigger.kind}`);
    }

    const commandId = composeSimulationId("trigger-command", [trigger.id]);
    const result = await submitDurableItemTransfer(
      {
        ...trigger.payload.command,
        // Routing comes from the trigger row, never the template, so a payload
        // aimed at another branch cannot dispatch there.
        branchId: trigger.branchId,
        id: commandId,
        idempotencyKey: commandId,
        submittedAtWallClock: now.toISOString(),
      },
      // The trigger's idempotency key is permanent, so an optimistic conflict
      // would be stored under it and replayed by every retry. See the option's
      // contract in item-transfer-store.
      { database, admitAtLockedVersion: true },
    );

    switch (result.status) {
      case "accepted": {
        const [completed] = await database
          .update(simTriggers)
          .set({
            state: "completed",
            resultCommandId: result.commandId,
            derivationVersion: schedulerDerivationVersion,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(fence)
          .returning({ id: simTriggers.id });
        if (!completed) return { status: "lease_lost", triggerId: trigger.id };
        return { status: "completed", triggerId: trigger.id, commandId: result.commandId };
      }
      case "rejected": {
        // A rejection is a deterministic refusal by world rules. Retrying the
        // same committed payload cannot change it, so quarantine now rather than
        // burning the attempt budget on a certain failure.
        const [failed] = await database
          .update(simTriggers)
          .set({
            state: "failed",
            derivationVersion: schedulerDerivationVersion,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: `rejected code=${result.code} ${result.publicReason}`.slice(0, 500),
            completedAt: now,
            updatedAt: now,
          })
          .where(fence)
          .returning({ id: simTriggers.id });
        if (!failed) return { status: "lease_lost", triggerId: trigger.id };
        return { status: "rejected", triggerId: trigger.id, code: result.code };
      }
      case "conflict": {
        // Unreachable while locked-version admission holds. If it ever fires that
        // guarantee has regressed; surface it instead of marking work completed.
        throw new Error(
          `Scheduler command conflicted at version ${result.currentVersion}; locked-version admission has regressed`,
        );
      }
    }
  } catch (error) {
    const terminal = claimed.attempts >= maxAttempts;
    const availableAt = new Date(now.getTime() + schedulerRetryDelaySeconds(claimed.attempts) * 1000);
    const [updated] = await database
      .update(simTriggers)
      .set({
        state: terminal ? "failed" : "pending",
        availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: safeDiagnostic(error, claimed),
        ...(terminal ? { derivationVersion: schedulerDerivationVersion, completedAt: now } : {}),
        updatedAt: now,
      })
      .where(fence)
      .returning({ id: simTriggers.id });
    if (!updated) return { status: "lease_lost", triggerId: trigger.id };
    return terminal
      ? { status: "failed", triggerId: trigger.id, attempts: claimed.attempts }
      : { status: "retry", triggerId: trigger.id, attempts: claimed.attempts, availableAt };
  }
}

/** The earliest story second at or before `target` that still has eligible work. */
async function nextDueStorySecond(
  branchId: string,
  target: number,
  now: Date,
  database: Db,
): Promise<number | null> {
  const [row] = await database
    .select({ due: simTriggers.dueStorySecond })
    .from(simTriggers)
    .where(
      and(
        eq(simTriggers.branchId, branchId),
        lte(simTriggers.dueStorySecond, target),
        lte(simTriggers.availableAt, now),
        or(
          eq(simTriggers.state, "pending"),
          and(eq(simTriggers.state, "processing"), lte(simTriggers.leaseExpiresAt, now)),
        ),
      ),
    )
    .orderBy(asc(simTriggers.dueStorySecond))
    .limit(1);
  return row?.due ?? null;
}

async function setStorySecond(branchId: string, storySecond: number, database: Db): Promise<void> {
  await database.update(simBranches).set({ storySecond }).where(eq(simBranches.id, branchId));
}

/**
 * Advance one branch's story time to `toStorySecond`, draining every trigger that
 * becomes due along the way (spec §12.2). Triggers are never skipped: exceeding a
 * declared bound persists the boundary reached so far and returns
 * `catch_up_required` for the caller to resume.
 *
 * The clock steps to each trigger's own due second before that trigger resolves,
 * rather than jumping straight to the target. An event takes its story second from
 * the branch clock, so jumping first would stamp every drained event with the
 * target and break the §12.4 partition-invariance property: advance(T0,T3) would
 * disagree with advance(T0,T1); advance(T1,T2); advance(T2,T3).
 *
 * Analytical rate integration (§12.2 steps 2 and 6) is deliberately absent — no
 * continuous rate exists until Gate 5 bodies. This drain loop is the seam it will
 * slot into.
 */
export async function advanceBranchStoryTime(
  rawBranchId: string,
  toStorySecond: number,
  options: AdvanceStoryTimeOptions,
): Promise<AdvanceStoryTimeOutcome> {
  const database = options.database ?? db();
  const now = options.now ?? new Date();
  const target = storySecondSchema.parse(toStorySecond);
  const maxTriggers = positiveSafeInteger(options.maxTriggers ?? 1000, "maxTriggers");
  const budgetMs = positiveSafeInteger(options.budgetMs ?? 30_000, "budgetMs");
  const startedAt = Date.now();
  let drained = 0;

  const [start] = await database
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, rawBranchId))
    .limit(1);
  if (!start) throw new Error("Cannot advance an unavailable branch");
  if (start.storySecond > target) throw new Error("Story time cannot move backwards");

  let clock = start.storySecond;
  const partial = (reason: "trigger_budget" | "time_budget"): AdvanceStoryTimeOutcome => ({
    status: "catch_up_required",
    branchId: rawBranchId,
    storySecond: clock,
    drained,
    reason,
  });

  for (;;) {
    if (drained >= maxTriggers) return partial("trigger_budget");
    if (Date.now() - startedAt >= budgetMs) return partial("time_budget");

    const due = await nextDueStorySecond(rawBranchId, target, now, database);
    if (due === null) break;

    // Step to this trigger's own second so its event is stamped there.
    if (due > clock) {
      clock = due;
      await setStorySecond(rawBranchId, clock, database);
    }

    const outcome = await resolveNextDueTrigger(rawBranchId, { ...options, database, now });
    if (outcome.status === "idle") break;
    // A retrying trigger stays due at this second. Leaving the loop lets its
    // backoff elapse instead of spinning on it for the rest of this advance.
    if (outcome.status === "retry") return partial("time_budget");
    drained += 1;
  }

  clock = target;
  await setStorySecond(rawBranchId, clock, database);
  return { status: "advanced", branchId: rawBranchId, storySecond: target, drained };
}
