import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  buildTriggerScheduledEvent,
  deriveScheduleCommandId,
  deriveTriggerCommandId,
  deriveTriggerId,
  scheduleTransferTriggerCommandSchema,
  scheduleTransferTriggerCommandType,
  scheduleTriggerCommandResultSchema,
  activityCompletionTriggerKind,
  bodyCollapseTriggerKind,
  bodyConditionExpiryTriggerKind,
  bodyThresholdTriggerKind,
  commitmentDeadlineTriggerKind,
  commitmentNoticeTriggerKind,
  householdRestockTriggerKind,
  itemConditionThresholdTriggerKind,
  journeyArrivalTriggerKind,
  scheduledTransferTriggerKind,
  schedulerDerivationVersion,
  schedulerRetryDelaySeconds,
  simulationTriggerSchema,
  type ScheduleTransferTriggerCommand,
  type ScheduleTriggerCommandResult,
  type SimulationTrigger,
} from "@/contracts/simulation/scheduler";
import {
  branchVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldIdSchema,
} from "@/contracts/simulation/identity";
import { completeActivityCommandSchema } from "@/contracts/simulation/activities";
import { transferItemCommandSchema } from "@/contracts/simulation/materials";
import { arriveJourneyCommandSchema } from "@/contracts/simulation/space";
import { db, simBranches, simCommands, simEvents, simTriggers, simWorlds, type Db } from "@/server/db";
import { submitDurableCompleteActivity } from "./activity-store";
import {
  submitDurableEndBodyCondition,
  submitDurableResolveBodyCollapse,
  submitDurableResolveBodyThreshold,
} from "./body-store";
import {
  submitDurableRaisePressure,
  submitDurableResolveCommitmentDeadline,
} from "./commitment-store";
import { submitDurableRunHouseholdRestock } from "./household-store";
import { submitDurableResolveItemConditionThreshold, submitDurableTransferItem } from "./material-store";
import { submitDurableJourneyArrival } from "./space-store";
import { applyTriggerScheduledEvent } from "./trigger-projector";

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

function invalidScheduleResult(): ScheduleTriggerCommandResult {
  return {
    status: "rejected",
    commandId: "invalid",
    code: "invalid_command",
    publicReason: "That scheduling request is invalid.",
    legalAlternativeCommandTypes: [],
  };
}

function scheduleBranchUnavailableResult(
  command: ScheduleTransferTriggerCommand,
): ScheduleTriggerCommandResult {
  return {
    status: "rejected",
    commandId: command.id,
    code: "branch_mismatch",
    publicReason: "That world branch is unavailable.",
    legalAlternativeCommandTypes: [],
  };
}

/**
 * Execute one schedule command against PostgreSQL authority (spec §11.1 step
 * 10): the trigger_scheduled event, the trigger row it projects to, the branch
 * advance, and the command result commit atomically under the branch lock.
 */
export async function submitDurableTriggerSchedule(
  rawCommand: unknown,
  options: { database?: Db; admitAtLockedVersion?: boolean } = {},
): Promise<ScheduleTriggerCommandResult> {
  const parsed = scheduleTransferTriggerCommandSchema.safeParse(rawCommand);
  if (!parsed.success) return invalidScheduleResult();

  const submitted = parsed.data;
  const database = options.database ?? db();

  const [preLockCached] = await database
    .select({ result: simCommands.result })
    .from(simCommands)
    .where(
      and(
        eq(simCommands.branchId, submitted.branchId),
        eq(simCommands.idempotencyKey, submitted.idempotencyKey),
      ),
    )
    .limit(1);
  if (preLockCached) return scheduleTriggerCommandResultSchema.parse(preLockCached.result);

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
      .for("update", { of: simBranches });
    if (!branch) return scheduleBranchUnavailableResult(submitted);

    const command: ScheduleTransferTriggerCommand = options.admitAtLockedVersion
      ? { ...submitted, expectedVersion: branchVersionSchema.parse(branch.version) }
      : submitted;

    const [cached] = await tx
      .select({ result: simCommands.result })
      .from(simCommands)
      .where(
        and(
          eq(simCommands.branchId, command.branchId),
          eq(simCommands.idempotencyKey, command.idempotencyKey),
        ),
      )
      .limit(1);
    if (cached) return scheduleTriggerCommandResultSchema.parse(cached.result);

    const [sameCommandId] = await tx
      .select({ idempotencyKey: simCommands.idempotencyKey })
      .from(simCommands)
      .where(and(eq(simCommands.branchId, command.branchId), eq(simCommands.commandId, command.id)))
      .limit(1);

    let commandResult: ScheduleTriggerCommandResult;
    if (sameCommandId) {
      commandResult = {
        status: "rejected",
        commandId: command.id,
        code: "duplicate_command_id",
        publicReason: "That scheduling request has already been submitted.",
        legalAlternativeCommandTypes: [],
      };
    } else if (branch.worldStatus !== "active") {
      commandResult = scheduleBranchUnavailableResult(command);
    } else if (command.expectedVersion !== branch.version) {
      commandResult = {
        status: "conflict",
        commandId: command.id,
        currentVersion: branch.version,
        retryable: true,
      };
    } else {
      const [existingTrigger] = await tx
        .select({ id: simTriggers.id })
        .from(simTriggers)
        .where(
          and(
            eq(simTriggers.branchId, command.branchId),
            eq(simTriggers.uniquenessKey, command.payload.uniquenessKey),
          ),
        )
        .limit(1);
      if (existingTrigger) {
        commandResult = {
          status: "rejected",
          commandId: command.id,
          code: "duplicate_trigger",
          publicReason: "That trigger is already scheduled.",
          legalAlternativeCommandTypes: [],
        };
      } else {
        const event = buildTriggerScheduledEvent(
          {
            worldId: branch.worldId,
            branchId: branch.id,
            headSequence: branch.headSequence,
            storySecond: branch.storySecond,
            rulesetVersion: branch.rulesetVersion,
          },
          command,
        );
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
          correlationId: event.correlationId,
          actorIds: event.actorIds,
          entityIds: event.entityIds,
          recordedAt: new Date(event.recordedAtWallClock),
          payload: event.payload,
        });
        await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });

        const advanced = await tx
          .update(simBranches)
          .set({ headSequence: event.sequence, version: branch.version + 1 })
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

        commandResult = {
          status: "accepted",
          commandId: command.id,
          branchVersion: branch.version + 1,
          firstSequence: event.sequence,
          lastSequence: event.sequence,
          eventIds: [event.id],
        };
      }
    }

    await tx.insert(simCommands).values({
      branchId: command.branchId,
      idempotencyKey: command.idempotencyKey,
      commandId: command.id,
      type: command.type,
      schemaVersion: command.schemaVersion,
      expectedVersion: command.expectedVersion,
      principalKind: command.principal.kind,
      envelope: command,
      status: commandResult.status,
      result: commandResult,
      submittedAt: new Date(command.submittedAtWallClock),
    });
    return commandResult;
  });
}

/**
 * Schedule one branch-unique trigger as a committed event effect (plan R1).
 *
 * The signature is unchanged from E2.4, but the row is now created by a
 * schedule command whose trigger_scheduled event replays on fork. Repeat calls
 * for the same uniqueness key stay idempotent: the command identity derives
 * from the trigger identity, so retries hit the stored result and return the
 * existing row.
 */
export async function scheduleDurableTrigger(
  rawTrigger: ScheduleTriggerInput,
  options: ScheduleTriggerOptions = {},
): Promise<SimulationTrigger> {
  const database = options.database ?? db();
  const branchId = worldBranchIdSchema.parse(rawTrigger.branchId);
  const worldId = worldIdSchema.parse(rawTrigger.worldId);
  const triggerId = deriveTriggerId(branchId, rawTrigger.uniquenessKey);

  const loadTrigger = async () => {
    const [row] = await database.select().from(simTriggers).where(eq(simTriggers.id, triggerId)).limit(1);
    return row ? simulationTriggerSchema.parse(row) : undefined;
  };

  const existing = await loadTrigger();
  if (existing) return existing;

  const [branch] = await database
    .select({ id: simBranches.id, worldId: simBranches.worldId })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch || branch.worldId !== worldId) {
    throw new Error("Cannot schedule a trigger for an unavailable branch");
  }

  const template =
    rawTrigger.kind === scheduledTransferTriggerKind
      ? transferItemCommandSchema.parse(rawTrigger.payload.command)
      : rawTrigger.kind === journeyArrivalTriggerKind
        ? arriveJourneyCommandSchema.parse(rawTrigger.payload.command)
        : completeActivityCommandSchema.parse(rawTrigger.payload.command);
  const commandId = deriveScheduleCommandId(triggerId);
  const command = scheduleTransferTriggerCommandSchema.parse({
    id: commandId,
    branchId,
    expectedVersion: 0,
    idempotencyKey: commandId,
    principal: template.principal,
    submittedAtWallClock: template.submittedAtWallClock,
    type: scheduleTransferTriggerCommandType,
    schemaVersion: 1,
    correlationId: template.correlationId,
    payload: {
      kind: rawTrigger.kind,
      triggerSchemaVersion: rawTrigger.schemaVersion,
      dueStorySecond: rawTrigger.dueStorySecond,
      priority: rawTrigger.priority ?? 0,
      uniquenessKey: rawTrigger.uniquenessKey,
      command: template,
    },
  });

  // A schedule depends on no optimistic read — its only precondition is key
  // uniqueness, checked under the branch lock — so it admits at the locked
  // version like any scheduler-originated command.
  const result = await submitDurableTriggerSchedule(command, { database, admitAtLockedVersion: true });
  if (result.status === "rejected" && result.code === "branch_mismatch") {
    throw new Error("Cannot schedule a trigger for an unavailable branch");
  }
  if (result.status === "conflict" || (result.status === "rejected" && result.code !== "duplicate_trigger")) {
    const detail = result.status === "conflict" ? "conflict" : result.code;
    throw new Error(`Trigger scheduling failed unexpectedly: ${detail}`);
  }

  const scheduled = await loadTrigger();
  if (!scheduled) throw new Error("Scheduled trigger row is missing after commit");
  return scheduled;
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
    const commandId = deriveTriggerCommandId(trigger.id);
    // Routing comes from the trigger row, never the template, so a payload
    // aimed at another branch cannot dispatch there.
    const dispatchEnvelope = {
      ...trigger.payload.command,
      branchId: trigger.branchId,
      id: commandId,
      idempotencyKey: commandId,
      submittedAtWallClock: now.toISOString(),
    };
    // The trigger's idempotency key is permanent, so an optimistic conflict
    // would be stored under it and replayed by every retry. See the option's
    // contract in material-store.
    const dispatchOptions = { database, admitAtLockedVersion: true };
    const dispatch = () => {
      switch (trigger.kind) {
        case scheduledTransferTriggerKind:
          return submitDurableTransferItem(dispatchEnvelope, dispatchOptions);
        case journeyArrivalTriggerKind:
          return submitDurableJourneyArrival(dispatchEnvelope, dispatchOptions);
        case activityCompletionTriggerKind:
          return submitDurableCompleteActivity(dispatchEnvelope, dispatchOptions);
        case commitmentNoticeTriggerKind:
          return submitDurableRaisePressure(dispatchEnvelope, dispatchOptions);
        case commitmentDeadlineTriggerKind:
          return submitDurableResolveCommitmentDeadline(dispatchEnvelope, dispatchOptions);
        case bodyThresholdTriggerKind:
          return submitDurableResolveBodyThreshold(dispatchEnvelope, dispatchOptions);
        case bodyConditionExpiryTriggerKind:
          return submitDurableEndBodyCondition(dispatchEnvelope, dispatchOptions);
        case bodyCollapseTriggerKind:
          return submitDurableResolveBodyCollapse(dispatchEnvelope, dispatchOptions);
        case itemConditionThresholdTriggerKind:
          return submitDurableResolveItemConditionThreshold(dispatchEnvelope, dispatchOptions);
        case householdRestockTriggerKind:
          return submitDurableRunHouseholdRestock(dispatchEnvelope, dispatchOptions);
      }
    };
    const result = await dispatch();

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
