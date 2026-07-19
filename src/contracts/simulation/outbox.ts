import { z } from "zod";
import {
  branchSequenceSchema,
  eventIdSchema,
  itemIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
} from "./identity";
import {
  itemDestroyedEventSchema,
  itemLocusSchema,
  itemTransferredEventSchema,
} from "./materials";

export const itemTransferFeedConsumerKind = "item_transfer_feed" as const;
/** Bumped for E5.3: the feed carries loci, not container ids, and item_destroyed. */
export const itemTransferFeedProjectionSchemaVersion = 2 as const;

export const simulationOutboxStateSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const itemTransferOutboxPayloadSchema = z
  .object({ sourceEventId: eventIdSchema })
  .strict();

/** The material events the feed publishes one row per (§26.4). */
export const itemMaterialFeedEventKinds = ["item_transferred", "item_destroyed"] as const;
export const itemMaterialFeedEventKindSchema = z.enum(itemMaterialFeedEventKinds);

export const itemTransferFeedRowSchema = z
  .object({
    consumerKind: z.literal(itemTransferFeedConsumerKind),
    projectionSchemaVersion: z.literal(itemTransferFeedProjectionSchemaVersion),
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    sourceEventId: eventIdSchema,
    sourceSequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    eventKind: itemMaterialFeedEventKindSchema,
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromLocus: itemLocusSchema,
    /** The destination locus; a `gone` locus for a destruction. */
    toLocus: itemLocusSchema,
  })
  .strict();

export type ItemTransferFeedRow = z.infer<typeof itemTransferFeedRowSchema>;

const materialFeedEventSchema = z.discriminatedUnion("type", [
  itemTransferredEventSchema,
  itemDestroyedEventSchema,
]);

/**
 * Pure projector shared by live delivery and rebuild-from-zero. It publishes one
 * feed row per material movement — a transfer carries its destination locus, a
 * destruction the terminal `gone` locus it moved to.
 */
export function projectMaterialFeedRow(rawEvent: unknown): ItemTransferFeedRow {
  const event = materialFeedEventSchema.parse(rawEvent);
  const toLocus =
    event.type === "item_transferred"
      ? event.payload.toLocus
      : ({ kind: "gone", basis: event.payload.basis } as const);
  return itemTransferFeedRowSchema.parse({
    consumerKind: itemTransferFeedConsumerKind,
    projectionSchemaVersion: itemTransferFeedProjectionSchemaVersion,
    worldId: event.worldId,
    branchId: event.branchId,
    sourceEventId: event.id,
    sourceSequence: event.sequence,
    storySecond: event.storySecond,
    eventKind: event.type,
    actorId: event.payload.actorId,
    itemId: event.payload.itemId,
    fromLocus: event.payload.fromLocus,
    toLocus,
  });
}

/** Deterministic capped exponential retry; jitter belongs to a later named draw stream. */
export function outboxRetryDelaySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError("Outbox attempt must be a positive safe integer");
  }
  return Math.min(300, 2 ** Math.min(attempt - 1, 8));
}
