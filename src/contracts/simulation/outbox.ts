import { z } from "zod";
import {
  branchSequenceSchema,
  eventIdSchema,
  holdingContainerIdSchema,
  itemIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
} from "./identity";
import { itemTransferredEventSchema, type ItemTransferredEvent } from "./item-transfer";

export const itemTransferFeedConsumerKind = "item_transfer_feed" as const;
export const itemTransferFeedProjectionSchemaVersion = 1 as const;

export const simulationOutboxStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const itemTransferOutboxPayloadSchema = z
  .object({ sourceEventId: eventIdSchema })
  .strict();

export const itemTransferFeedRowSchema = z
  .object({
    consumerKind: z.literal(itemTransferFeedConsumerKind),
    projectionSchemaVersion: z.literal(itemTransferFeedProjectionSchemaVersion),
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    sourceEventId: eventIdSchema,
    sourceSequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromContainerId: holdingContainerIdSchema,
    toContainerId: holdingContainerIdSchema,
  })
  .strict();

export type ItemTransferFeedRow = z.infer<typeof itemTransferFeedRowSchema>;

/** Pure projector shared by live delivery and rebuild-from-zero. */
export function projectItemTransferredFeedRow(rawEvent: unknown): ItemTransferFeedRow {
  const event: ItemTransferredEvent = itemTransferredEventSchema.parse(rawEvent);
  return itemTransferFeedRowSchema.parse({
    consumerKind: itemTransferFeedConsumerKind,
    projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
    worldId: event.worldId,
    branchId: event.branchId,
    sourceEventId: event.id,
    sourceSequence: event.sequence,
    storySecond: event.storySecond,
    actorId: event.payload.actorId,
    itemId: event.payload.itemId,
    fromContainerId: event.payload.fromContainerId,
    toContainerId: event.payload.toContainerId,
  });
}

/** Deterministic capped exponential retry; jitter belongs to a later named draw stream. */
export function outboxRetryDelaySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Outbox attempt must be a positive safe integer");
  }
  return Math.min(300, 2 ** Math.min(attempt - 1, 8));
}
