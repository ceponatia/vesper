import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import {
  branchHeadSequenceSchema,
  branchSequenceSchema,
  commandIdSchema,
  composeSimulationId,
  derivationVersionSchema,
  rulesetVersionSchema,
  storySecondSchema,
  triggerIdSchema,
  worldBranchIdSchema,
  worldIdSchema,
} from "./identity";
import { completeActivityCommandSchema } from "./activities";
import {
  endBodyConditionCommandSchema,
  resolveBodyCollapseCommandSchema,
  resolveBodyThresholdCommandSchema,
} from "./bodies";
import {
  raisePressureCommandSchema,
  resolveCommitmentDeadlineCommandSchema,
} from "./commitments";
import { runHouseholdRestockCommandSchema } from "./households";
import { resolveItemConditionThresholdCommandSchema } from "./material-condition";
import { transferItemCommandSchema, type ItemLocus } from "./materials";
import { arriveJourneyCommandSchema } from "./space";

export const simulationTriggerStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const scheduledTransferTriggerKind = "scheduled_transfer_item" as const;
export const journeyArrivalTriggerKind = "journey_arrival_due" as const;
export const activityCompletionTriggerKind = "activity_completion_due" as const;
export const commitmentNoticeTriggerKind = "commitment_notice_due" as const;
export const commitmentDeadlineTriggerKind = "commitment_deadline_due" as const;
export const bodyThresholdTriggerKind = "body_threshold_due" as const;
export const bodyConditionExpiryTriggerKind = "body_condition_expiry_due" as const;
export const bodyCollapseTriggerKind = "body_collapse_due" as const;
export const itemConditionThresholdTriggerKind = "item_condition_threshold_due" as const;
export const householdRestockTriggerKind = "household_restock_due" as const;
export const simulationTriggerKinds = [
  scheduledTransferTriggerKind,
  journeyArrivalTriggerKind,
  activityCompletionTriggerKind,
  commitmentNoticeTriggerKind,
  commitmentDeadlineTriggerKind,
  bodyThresholdTriggerKind,
  bodyConditionExpiryTriggerKind,
  bodyCollapseTriggerKind,
  itemConditionThresholdTriggerKind,
  householdRestockTriggerKind,
] as const;
export const scheduledTransferTriggerSchemaVersion = 1 as const;
export const schedulerDerivationVersion = "scheduler-v1" as const;

/**
 * Each trigger kind pairs with exactly one dispatchable command family. The
 * pairing is structural — a journey-arrival trigger cannot smuggle a transfer
 * command and vice versa.
 */
function createTriggerRowSchema<TKind extends string, TCommand extends z.ZodType>(
  kind: TKind,
  command: TCommand,
) {
  // Deliberately non-strict: database coordination columns (state, attempts,
  // lease, …) are stripped when a durable row projects back into the domain
  // trigger contract.
  return z.object({
    id: triggerIdSchema,
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    kind: z.literal(kind),
    schemaVersion: z.literal(scheduledTransferTriggerSchemaVersion),
    dueStorySecond: storySecondSchema,
    /** Spec §12.1: lower is more urgent. Ties fall through to stableOrder. */
    priority: z.number().int().min(0).max(9_999).default(0),
    stableOrder: branchSequenceSchema,
    uniquenessKey: z.string().min(1).max(512),
    payload: z.object({ command }).strict(),
  });
}

export const scheduledTransferTriggerPayloadSchema = z
  .object({ command: transferItemCommandSchema })
  .strict();

// Database coordination columns are intentionally stripped when a durable row is
// projected back into the immutable domain trigger contract.
export const simulationTriggerSchema = z
  .discriminatedUnion("kind", [
    createTriggerRowSchema(scheduledTransferTriggerKind, transferItemCommandSchema),
    createTriggerRowSchema(journeyArrivalTriggerKind, arriveJourneyCommandSchema),
    createTriggerRowSchema(activityCompletionTriggerKind, completeActivityCommandSchema),
    createTriggerRowSchema(commitmentNoticeTriggerKind, raisePressureCommandSchema),
    createTriggerRowSchema(commitmentDeadlineTriggerKind, resolveCommitmentDeadlineCommandSchema),
    createTriggerRowSchema(bodyThresholdTriggerKind, resolveBodyThresholdCommandSchema),
    createTriggerRowSchema(bodyConditionExpiryTriggerKind, endBodyConditionCommandSchema),
    createTriggerRowSchema(bodyCollapseTriggerKind, resolveBodyCollapseCommandSchema),
    createTriggerRowSchema(itemConditionThresholdTriggerKind, resolveItemConditionThresholdCommandSchema),
    createTriggerRowSchema(householdRestockTriggerKind, runHouseholdRestockCommandSchema),
  ])
  // A trigger on one branch must never carry a command aimed at another. The
  // command envelope has no worldId, so branch equality is the whole check;
  // world equality follows from the trigger's branch/world foreign key.
  .refine((trigger) => trigger.payload.command.branchId === trigger.branchId, {
    message: "Trigger payload command must target the trigger's own branch",
    path: ["payload", "command", "branchId"],
  });

export type SimulationTrigger = z.infer<typeof simulationTriggerSchema>;
export type SimulationTriggerKind = SimulationTrigger["kind"];

export function deriveTriggerId(branchId: string, uniquenessKey: string): string {
  return triggerIdSchema.parse(composeSimulationId("trigger", [branchId, uniquenessKey]));
}

// ---------------------------------------------------------------------------
// E2.5 — trigger creation as an event effect (plan R1 prerequisite)
// ---------------------------------------------------------------------------

export const scheduleTransferTriggerCommandType = "schedule_transfer_item" as const;
export const triggerScheduledEventType = "trigger_scheduled" as const;

/**
 * The durable scheduling intent an event carries. Applying the event on any
 * branch — live commit or fork replay — reconstructs the trigger row from this
 * payload alone; coordination columns (state, attempts, lease) are never part
 * of the intent.
 */
function createTriggerIntentSchema<TKind extends string, TCommand extends z.ZodType>(
  kind: TKind,
  command: TCommand,
) {
  return z
    .object({
      kind: z.literal(kind),
      triggerSchemaVersion: z.literal(scheduledTransferTriggerSchemaVersion),
      dueStorySecond: storySecondSchema,
      priority: z.number().int().min(0).max(9_999).default(0),
      uniquenessKey: z.string().min(1).max(512),
      /**
       * The command template the trigger will dispatch when due. Its routing
       * fields (branchId, id, idempotencyKey, submittedAtWallClock) are always
       * overridden at apply/dispatch time, so replaying this intent onto a fork
       * child re-targets it structurally.
       */
      command,
    })
    .strict();
}

const scheduleTriggerIntentSchema = z.discriminatedUnion("kind", [
  createTriggerIntentSchema(scheduledTransferTriggerKind, transferItemCommandSchema),
  createTriggerIntentSchema(journeyArrivalTriggerKind, arriveJourneyCommandSchema),
  createTriggerIntentSchema(activityCompletionTriggerKind, completeActivityCommandSchema),
  createTriggerIntentSchema(commitmentNoticeTriggerKind, raisePressureCommandSchema),
  createTriggerIntentSchema(commitmentDeadlineTriggerKind, resolveCommitmentDeadlineCommandSchema),
  createTriggerIntentSchema(bodyThresholdTriggerKind, resolveBodyThresholdCommandSchema),
  createTriggerIntentSchema(bodyConditionExpiryTriggerKind, endBodyConditionCommandSchema),
  createTriggerIntentSchema(bodyCollapseTriggerKind, resolveBodyCollapseCommandSchema),
  createTriggerIntentSchema(itemConditionThresholdTriggerKind, resolveItemConditionThresholdCommandSchema),
  createTriggerIntentSchema(householdRestockTriggerKind, runHouseholdRestockCommandSchema),
]);

export const scheduleTransferTriggerCommandSchema = createCommandEnvelopeSchema(
  scheduleTransferTriggerCommandType,
  1,
  scheduleTriggerIntentSchema,
).refine((command) => command.payload.command.branchId === command.branchId, {
  message: "Scheduled command template must target its own branch",
  path: ["payload", "command", "branchId"],
});

export const scheduleTriggerRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "duplicate_trigger",
] as const;

export const scheduleTriggerRejectionCodeSchema = z.enum(scheduleTriggerRejectionCodes);
export const scheduleTriggerCommandResultSchema = createCommandResultSchema(
  scheduleTriggerRejectionCodeSchema,
);

export const triggerScheduledEventSchema = createEventEnvelopeSchema(
  triggerScheduledEventType,
  1,
  scheduleTriggerIntentSchema,
).extend({
  derivationVersion: derivationVersionSchema,
  commandId: commandIdSchema,
});

export type ScheduleTransferTriggerCommand = z.infer<typeof scheduleTransferTriggerCommandSchema>;
export type ScheduleTriggerRejectionCode = z.infer<typeof scheduleTriggerRejectionCodeSchema>;
export type ScheduleTriggerCommandResult = z.infer<typeof scheduleTriggerCommandResultSchema>;
export type TriggerScheduledEvent = z.infer<typeof triggerScheduledEventSchema>;

/** The deterministic command identity a schedule wrapper reuses across retries. */
export function deriveScheduleCommandId(triggerId: string): string {
  return commandIdSchema.parse(composeSimulationId("schedule-command", [triggerId]));
}

/**
 * The deterministic command identity a trigger resolution dispatches under.
 * Fork replay recomputes these across every ancestor branch to recognize
 * transfers that a trigger already produced before the fork point.
 */
export function deriveTriggerCommandId(triggerId: string): string {
  return commandIdSchema.parse(composeSimulationId("trigger-command", [triggerId]));
}

/** The registry ids a transfer locus references, for the scheduling envelope. */
function transferLocusEntityIds(locus: ItemLocus): string[] {
  switch (locus.kind) {
    case "held":
    case "worn":
      return [locus.actorId];
    case "container":
      return [locus.containerItemId];
    case "zone":
      return [locus.zoneId];
    case "gone":
      return [];
  }
}

/** Per-kind envelope facts for a scheduling event: who acts, what is referenced. */
function triggerIntentEnvelopeFacts(
  intent: z.infer<typeof scheduleTriggerIntentSchema>,
): { actorIds: string[]; entityIds: string[] } {
  switch (intent.kind) {
    case scheduledTransferTriggerKind: {
      const transfer = intent.command.payload;
      return {
        actorIds: [transfer.actorId],
        entityIds: [
          ...new Set<string>([
            transfer.actorId,
            transfer.itemId,
            ...transferLocusEntityIds(transfer.fromLocus),
            ...transferLocusEntityIds(transfer.toLocus),
          ]),
        ].sort(),
      };
    }
    case journeyArrivalTriggerKind:
      // The journey row owns its traveller set; re-validation at fire time
      // reads it there, so the scheduling envelope names only the journey.
      return { actorIds: [], entityIds: [intent.command.payload.journeyId] };
    case activityCompletionTriggerKind:
      // Same rule: the activity row owns its participant set.
      return { actorIds: [], entityIds: [intent.command.payload.activityInstanceId] };
    case commitmentNoticeTriggerKind:
    case commitmentDeadlineTriggerKind:
      return { actorIds: [], entityIds: [intent.command.payload.commitmentId] };
    case bodyThresholdTriggerKind:
    case bodyCollapseTriggerKind:
      // The meter rows own their state; the scheduling envelope names the actor.
      return { actorIds: [], entityIds: [intent.command.payload.actorId] };
    case bodyConditionExpiryTriggerKind:
      return { actorIds: [], entityIds: [intent.command.payload.conditionId] };
    case itemConditionThresholdTriggerKind:
      // The item's meter rows own their state; no actor is a party to this alarm.
      return { actorIds: [], entityIds: [intent.command.payload.itemId] };
    case householdRestockTriggerKind:
      // The routine row owns its own state; the scheduling envelope names the household.
      return { actorIds: [], entityIds: [intent.command.payload.householdId] };
  }
}

/** Deterministic event constructor shared by the live commit path and tests. */
export function buildTriggerScheduledEvent(view: {
  worldId: string;
  branchId: string;
  headSequence: number;
  storySecond: number;
  rulesetVersion: string;
}, command: ScheduleTransferTriggerCommand): TriggerScheduledEvent {
  const facts = triggerIntentEnvelopeFacts(command.payload);
  return triggerScheduledEventSchema.parse({
    id: composeSimulationId("event", [command.branchId, command.id]),
    worldId: worldIdSchema.parse(view.worldId),
    branchId: command.branchId,
    sequence: branchHeadSequenceSchema.parse(view.headSequence) + 1,
    storySecond: storySecondSchema.parse(view.storySecond),
    type: triggerScheduledEventType,
    schemaVersion: 1,
    rulesetVersion: rulesetVersionSchema.parse(view.rulesetVersion),
    derivationVersion: schedulerDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    actorIds: facts.actorIds,
    entityIds: facts.entityIds,
    recordedAtWallClock: command.submittedAtWallClock,
    payload: command.payload,
  });
}

/**
 * A named stream produces stable draws without sharing mutable RNG state.
 * Adding a draw in one stream therefore cannot perturb any other stream.
 */
export function deterministicDrawUnit(input: {
  worldSeed: string;
  branchId: string;
  stream: string;
  drawIndex: number;
}): number {
  if (!Number.isSafeInteger(input.drawIndex) || input.drawIndex < 0) {
    throw new RangeError("drawIndex must be a nonnegative safe integer");
  }
  const material = composeSimulationId("draw", [
    input.worldSeed,
    input.branchId,
    input.stream,
    String(input.drawIndex),
  ]);
  const bytes = createHash("sha256").update(material).digest();
  const high = bytes.readUInt32BE(0);
  const low = bytes.readUInt32BE(4);
  const integer53 = high * 2 ** 21 + (low >>> 11);
  return integer53 / 2 ** 53;
}

export const schedulerRetryCapSeconds = 900 as const;

/**
 * Exponential backoff capped at {@link schedulerRetryCapSeconds}. The exponent is
 * clamped only to stay inside safe-integer range — it must stay above the cap so
 * the cap is what actually binds.
 */
export function schedulerRetryDelaySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Scheduler attempt must be a positive safe integer");
  }
  return Math.min(schedulerRetryCapSeconds, 2 ** Math.min(attempt - 1, 20));
}
