import { z } from "zod";
import {
  activityCancelledEventSchema,
  activityCompletedEventSchema,
  activityFailedEventSchema,
  activityInterruptedEventSchema,
  activityResumedEventSchema,
  activityStartedEventSchema,
  type CancelActivityCommand,
  type CancelActivityCommandResult,
  type CompleteActivityCommand,
  type CompleteActivityCommandResult,
  type StartActivityCommand,
  type StartActivityCommandResult,
} from "./activities";
import {
  commitmentCreatedEventSchema,
  commitmentKeptEventSchema,
  commitmentLateEventSchema,
  commitmentMissedEventSchema,
  pressureRaisedEventSchema,
  type CreateCommitmentCommand,
  type CreateCommitmentCommandResult,
  type RaisePressureCommand,
  type RaisePressureCommandResult,
  type ResolveCommitmentDeadlineCommand,
  type ResolveCommitmentDeadlineCommandResult,
} from "./commitments";
import {
  engagementEndedEventSchema,
  engagementInterruptedEventSchema,
  engagementOpenedEventSchema,
  engagementWindingDownEventSchema,
  type EndEngagementCommand,
  type EndEngagementCommandResult,
  type OpenEngagementCommand,
  type OpenEngagementCommandResult,
} from "./engagements";
import {
  storytellerRelocationEventSchema,
  zoneEnteredEventSchema,
  type AttemptEntryCommand,
  type AttemptEntryCommandResult,
  type StorytellerRelocateActorCommand,
  type StorytellerRelocateActorCommandResult,
} from "./access";
import {
  speechActDeliveredEventSchema,
  type ConfirmNarratorResultCommand,
  type ConfirmNarratorResultCommandResult,
} from "./narrative";
import {
  disclosureMadeEventSchema,
  type MakeDisclosureCommand,
  type MakeDisclosureCommandResult,
} from "./knowledge";
import { commandPrincipalSchema, principalKindSchema } from "./envelopes";
import {
  branchHeadSequenceSchema,
  branchSequenceSchema,
  branchVersionSchema,
  commandIdSchema,
  composeSimulationId,
  eventIdSchema,
  holdingContainerIdSchema,
  itemIdSchema,
  principalIdSchema,
  rulesetVersionSchema,
  snapshotIdSchema,
  storySecondSchema,
  triggerIdSchema,
  worldBranchIdSchema,
  worldIdSchema,
} from "./identity";
import {
  itemTransferProjectionSchema,
  itemTransferredEventSchema,
  type ItemTransferCommandResult,
  type TransferItemCommand,
} from "./item-transfer";
import {
  triggerScheduledEventSchema,
  type ScheduleTransferTriggerCommand,
  type ScheduleTriggerCommandResult,
} from "./scheduler";
import {
  actorArrivedEventSchema,
  actorDepartedEventSchema,
  journeyAbandonedEventSchema,
  journeyDelayedEventSchema,
  journeyInterruptedEventSchema,
  journeyPlannedEventSchema,
  type ArriveJourneyCommand,
  type ArriveJourneyCommandResult,
  type MoveActorCommand,
  type MoveActorCommandResult,
} from "./space";

/**
 * Every event family a branch's ordered stream can contain. Branch-scoped
 * reads and replay parse rows through this union rather than assuming one
 * family, so adding an event type is a contract edit, not a read-path hunt.
 */
export const simulationBranchEventSchema = z.discriminatedUnion("type", [
  itemTransferredEventSchema,
  triggerScheduledEventSchema,
  journeyPlannedEventSchema,
  actorDepartedEventSchema,
  journeyDelayedEventSchema,
  journeyInterruptedEventSchema,
  actorArrivedEventSchema,
  journeyAbandonedEventSchema,
  activityStartedEventSchema,
  activityCompletedEventSchema,
  activityCancelledEventSchema,
  activityFailedEventSchema,
  activityInterruptedEventSchema,
  activityResumedEventSchema,
  commitmentCreatedEventSchema,
  pressureRaisedEventSchema,
  commitmentKeptEventSchema,
  commitmentLateEventSchema,
  commitmentMissedEventSchema,
  engagementOpenedEventSchema,
  engagementEndedEventSchema,
  engagementInterruptedEventSchema,
  engagementWindingDownEventSchema,
  zoneEnteredEventSchema,
  storytellerRelocationEventSchema,
  speechActDeliveredEventSchema,
  disclosureMadeEventSchema,
]);

export type SimulationBranchEvent = z.infer<typeof simulationBranchEventSchema>;

/** The movement family (E3.1). Replay treats these as space-projection events. */
const movementEventTypeList = [
  "journey_planned",
  "actor_departed",
  "journey_delayed",
  "journey_interrupted",
  "actor_arrived",
  "journey_abandoned",
] as const;
export type MovementEventType = (typeof movementEventTypeList)[number];
export type SimulationMovementEvent = Extract<SimulationBranchEvent, { type: MovementEventType }>;
export const movementEventTypes: ReadonlySet<string> = new Set(movementEventTypeList);

export function isMovementEvent(event: SimulationBranchEvent): event is SimulationMovementEvent {
  return movementEventTypes.has(event.type);
}

/** The activity family (E3.2). Replay treats these as activities-projection events. */
const activityEventTypeList = [
  "activity_started",
  "activity_completed",
  "activity_cancelled",
  "activity_failed",
  "activity_interrupted",
  "activity_resumed",
] as const;
export type ActivityEventType = (typeof activityEventTypeList)[number];
export type SimulationActivityEvent = Extract<SimulationBranchEvent, { type: ActivityEventType }>;
export const activityEventTypes: ReadonlySet<string> = new Set(activityEventTypeList);

export function isActivityEvent(event: SimulationBranchEvent): event is SimulationActivityEvent {
  return activityEventTypes.has(event.type);
}

/** The commitment family (E3.3). Replay treats these as commitments-projection events. */
const commitmentEventTypeList = [
  "commitment_created",
  "pressure_raised",
  "commitment_kept",
  "commitment_late",
  "commitment_missed",
] as const;
export type CommitmentEventType = (typeof commitmentEventTypeList)[number];
export type SimulationCommitmentEvent = Extract<SimulationBranchEvent, { type: CommitmentEventType }>;
export const commitmentEventTypes: ReadonlySet<string> = new Set(commitmentEventTypeList);

export function isCommitmentEvent(event: SimulationBranchEvent): event is SimulationCommitmentEvent {
  return commitmentEventTypes.has(event.type);
}

/** The engagement family (E3.4). Replay treats these as engagements-projection events. */
const engagementEventTypeList = [
  "engagement_opened",
  "engagement_ended",
  "engagement_interrupted",
  "engagement_winding_down",
] as const;
export type EngagementEventType = (typeof engagementEventTypeList)[number];
export type SimulationEngagementEvent = Extract<SimulationBranchEvent, { type: EngagementEventType }>;
export const engagementEventTypes: ReadonlySet<string> = new Set(engagementEventTypeList);

export function isEngagementEvent(event: SimulationBranchEvent): event is SimulationEngagementEvent {
  return engagementEventTypes.has(event.type);
}

/** The knowledge family (E4.2). Replay treats these as knowledge-projection events. */
const knowledgeEventTypeList = ["disclosure_made"] as const;
export type KnowledgeEventType = (typeof knowledgeEventTypeList)[number];
export type SimulationKnowledgeEvent = Extract<SimulationBranchEvent, { type: KnowledgeEventType }>;
export const knowledgeEventTypes: ReadonlySet<string> = new Set(knowledgeEventTypeList);

export function isKnowledgeEvent(event: SimulationBranchEvent): event is SimulationKnowledgeEvent {
  return knowledgeEventTypes.has(event.type);
}

/** Access-family locus changes (E3.5): applied by the space projection. */
const accessEventTypeList = ["zone_entered", "storyteller_relocation"] as const;
export type AccessEventType = (typeof accessEventTypeList)[number];
export type SimulationAccessEvent = Extract<SimulationBranchEvent, { type: AccessEventType }>;
export const accessEventTypes: ReadonlySet<string> = new Set(accessEventTypeList);

export function isAccessEvent(event: SimulationBranchEvent): event is SimulationAccessEvent {
  return accessEventTypes.has(event.type);
}

/** Union persisted in sim_commands; each family keeps its own result contract. */
export type SimulationCommandEnvelope =
  | TransferItemCommand
  | ScheduleTransferTriggerCommand
  | MoveActorCommand
  | ArriveJourneyCommand
  | StartActivityCommand
  | CompleteActivityCommand
  | CancelActivityCommand
  | CreateCommitmentCommand
  | RaisePressureCommand
  | ResolveCommitmentDeadlineCommand
  | OpenEngagementCommand
  | EndEngagementCommand
  | AttemptEntryCommand
  | StorytellerRelocateActorCommand
  | ConfirmNarratorResultCommand
  | MakeDisclosureCommand;
export type SimulationCommandResultRecord =
  | ItemTransferCommandResult
  | ScheduleTriggerCommandResult
  | MoveActorCommandResult
  | ArriveJourneyCommandResult
  | StartActivityCommandResult
  | CompleteActivityCommandResult
  | CancelActivityCommandResult
  | CreateCommitmentCommandResult
  | RaisePressureCommandResult
  | ResolveCommitmentDeadlineCommandResult
  | OpenEngagementCommandResult
  | EndEngagementCommandResult
  | AttemptEntryCommandResult
  | StorytellerRelocateActorCommandResult
  | ConfirmNarratorResultCommandResult
  | MakeDisclosureCommandResult;

// ---------------------------------------------------------------------------
// Branch fork (spec §29.3)
// ---------------------------------------------------------------------------

export const forkReasonSchema = z.string().trim().min(1).max(500);

/** Who initiated a fork. Forks act on branches, not actors, so no controlled-actor set. */
export const forkPrincipalSchema = z
  .object({
    kind: principalKindSchema,
    principalId: principalIdSchema,
  })
  .strict();

export const branchForkInputSchema = z
  .object({
    parentBranchId: worldBranchIdSchema,
    childBranchId: worldBranchIdSchema,
    /** The last inherited sequence. Zero forks the world at its creation state. */
    atSequence: branchHeadSequenceSchema,
    principal: forkPrincipalSchema,
    reason: forkReasonSchema,
  })
  .strict()
  .refine((input) => input.childBranchId !== input.parentBranchId, {
    message: "A branch cannot fork onto itself",
    path: ["childBranchId"],
  });

export type BranchForkInput = z.infer<typeof branchForkInputSchema>;

export const simulationChecksumSchema = z.string().regex(/^[0-9a-f]{8}$/u);

export const branchForkResultSchema = z
  .object({
    childBranchId: worldBranchIdSchema,
    parentBranchId: worldBranchIdSchema,
    worldId: worldIdSchema,
    forkSequence: branchHeadSequenceSchema,
    forkStorySecond: storySecondSchema,
    version: branchVersionSchema,
    inheritedEventCount: z.number().int().nonnegative(),
    /** Checksum of the child's materialized projection at the fork point. */
    inheritedSnapshotChecksum: simulationChecksumSchema,
    pendingTriggerIds: z.array(triggerIdSchema),
    completedTriggerIds: z.array(triggerIdSchema),
    snapshotId: snapshotIdSchema,
  })
  .strict();

export type BranchForkResult = z.infer<typeof branchForkResultSchema>;

// ---------------------------------------------------------------------------
// Snapshots (spec §10.4)
// ---------------------------------------------------------------------------

export const itemTransferSnapshotProjectionKind = "item_transfer" as const;
export const itemTransferSnapshotSchemaVersion = 1 as const;

export const simulationSnapshotPayloadSchema = z
  .object({ projection: itemTransferProjectionSchema })
  .strict();

export const simulationSnapshotSchema = z
  .object({
    id: snapshotIdSchema,
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    projectionKind: z.literal(itemTransferSnapshotProjectionKind),
    sequence: branchHeadSequenceSchema,
    projectionSchemaVersion: z.literal(itemTransferSnapshotSchemaVersion),
    rulesetVersion: rulesetVersionSchema,
    checksum: simulationChecksumSchema,
    /** Zero means the range starts at the (non-evented) world seed. */
    sourceFirstSequence: branchHeadSequenceSchema,
    sourceLastSequence: branchHeadSequenceSchema,
    payload: simulationSnapshotPayloadSchema,
  })
  .strict()
  .refine((snapshot) => snapshot.sourceLastSequence >= snapshot.sourceFirstSequence, {
    message: "Snapshot source range is reversed",
    path: ["sourceLastSequence"],
  })
  .refine((snapshot) => snapshot.sequence === snapshot.sourceLastSequence, {
    message: "Snapshot boundary must equal the end of its source range",
    path: ["sequence"],
  });

export type SimulationSnapshot = z.infer<typeof simulationSnapshotSchema>;

export function deriveSnapshotId(
  branchId: string,
  projectionKind: string,
  sequence: number,
): string {
  return snapshotIdSchema.parse(
    composeSimulationId("snapshot", [branchId, projectionKind, String(sequence)]),
  );
}

// ---------------------------------------------------------------------------
// Projection rebuild and comparison (spec §10.4, plan deliverable)
// ---------------------------------------------------------------------------

export const projectionRebuildResultSchema = z
  .object({
    branchId: worldBranchIdSchema,
    headSequence: branchHeadSequenceSchema,
    source: z.enum(["zero", "snapshot"]),
    snapshotSequence: branchHeadSequenceSchema.optional(),
    replayedEventCount: z.number().int().nonnegative(),
    liveHash: simulationChecksumSchema,
    rebuiltHash: simulationChecksumSchema,
    matches: z.boolean(),
  })
  .strict();

export type ProjectionRebuildResult = z.infer<typeof projectionRebuildResultSchema>;

// ---------------------------------------------------------------------------
// Causal explanation (spec §35.3, plan deliverable)
// ---------------------------------------------------------------------------

const explainedEventSchema = z
  .object({
    id: eventIdSchema,
    branchId: worldBranchIdSchema,
    sequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    type: z.string().min(1),
  })
  .strict();

const explainedCommandSchema = z
  .object({
    id: commandIdSchema,
    branchId: worldBranchIdSchema,
    type: z.string().min(1),
    principal: commandPrincipalSchema,
  })
  .strict();

/**
 * Why an item is where it is: the event that placed it, the command that
 * produced the event, and — when a scheduler dispatched that command — the
 * trigger, its scheduling event, and the scheduling command. Read-only; every
 * field is quoted from immutable records.
 */
export const itemPlacementExplanationSchema = z
  .object({
    branchId: worldBranchIdSchema,
    itemId: itemIdSchema,
    holdingContainerId: holdingContainerIdSchema,
    /** "seed" when no recorded event has moved the item on this timeline. */
    origin: z.enum(["seed", "event"]),
    event: explainedEventSchema.optional(),
    command: explainedCommandSchema.optional(),
    trigger: z
      .object({
        id: triggerIdSchema,
        branchId: worldBranchIdSchema,
        uniquenessKey: z.string().min(1),
        dueStorySecond: storySecondSchema,
      })
      .strict()
      .optional(),
    schedulingEvent: explainedEventSchema.optional(),
    schedulingCommand: explainedCommandSchema.optional(),
  })
  .strict();

export type ItemPlacementExplanation = z.infer<typeof itemPlacementExplanationSchema>;
