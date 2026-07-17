import { z } from "zod";
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

/**
 * Every event family a branch's ordered stream can contain. Branch-scoped
 * reads and replay parse rows through this union rather than assuming one
 * family, so adding an event type is a contract edit, not a read-path hunt.
 */
export const simulationBranchEventSchema = z.discriminatedUnion("type", [
  itemTransferredEventSchema,
  triggerScheduledEventSchema,
]);

export type SimulationBranchEvent = z.infer<typeof simulationBranchEventSchema>;

/** Union persisted in sim_commands; each family keeps its own result contract. */
export type SimulationCommandEnvelope = TransferItemCommand | ScheduleTransferTriggerCommand;
export type SimulationCommandResultRecord = ItemTransferCommandResult | ScheduleTriggerCommandResult;

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
