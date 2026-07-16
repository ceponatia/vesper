import { z } from "zod";
import {
  acceptedSimulationCommandResultSchema,
  commandPrincipalSchema,
  conflictSimulationCommandResultSchema,
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  branchHeadSequenceSchema,
  branchSequenceSchema,
  branchVersionSchema,
  commandIdSchema,
  eventIdSchema,
  holdingContainerIdSchema,
  itemIdSchema,
  narrativeCutIdSchema,
  observationIdSchema,
  rulesetVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
} from "./identity";

export { commandPrincipalSchema };

const GATE1_PERCEPTION_VERSION = "gate1-perception-v1" as const;
const gate1PerceptionVersionSchema = z.literal(GATE1_PERCEPTION_VERSION).brand<"DerivationVersion">();

const holdingContainerIdsSchema = createStableStringSetSchema(
  holdingContainerIdSchema,
  "Holding container IDs",
);
const actorIdsSchema = createStableStringSetSchema(worldCharacterIdSchema, "Actor IDs");

export const holdingContainerKinds = ["actor", "location", "container"] as const;
export const holdingContainerKindSchema = z.enum(holdingContainerKinds);

export const simulationActorSchema = z
  .object({
    id: worldCharacterIdSchema,
    name: z.string().trim().min(1),
    /** Containers whose contents this actor can currently perceive. */
    observedContainerIds: holdingContainerIdsSchema.default([]),
  })
  .strict();

export const holdingContainerSchema = z
  .object({
    id: holdingContainerIdSchema,
    kind: holdingContainerKindSchema,
    name: z.string().trim().min(1),
    capacity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Actors allowed to manipulate this holding locus in the Gate 1 slice. */
    accessibleToActorIds: actorIdsSchema.default([]),
  })
  .strict();

export const simulationItemSchema = z
  .object({
    id: itemIdSchema,
    name: z.string().trim().min(1),
    holdingContainerId: holdingContainerIdSchema,
  })
  .strict();

export const itemTransferObservationSchema = z
  .object({
    id: observationIdSchema,
    sourceEventId: eventIdSchema,
    witnessActorId: worldCharacterIdSchema,
    sequence: branchSequenceSchema,
    storySecond: storySecondSchema,
    itemId: itemIdSchema,
    fromContainerId: holdingContainerIdSchema,
    toContainerId: holdingContainerIdSchema,
    derivationVersion: gate1PerceptionVersionSchema,
  })
  .strict();

export const itemTransferProjectionSchema = z
  .object({
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    rulesetVersion: rulesetVersionSchema,
    version: branchVersionSchema,
    headSequence: branchHeadSequenceSchema,
    storySecond: storySecondSchema,
    actors: z.array(simulationActorSchema),
    containers: z.array(holdingContainerSchema),
    items: z.array(simulationItemSchema),
    observations: z.array(itemTransferObservationSchema).default([]),
  })
  .strict();

const transferItemPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromContainerId: holdingContainerIdSchema,
    toContainerId: holdingContainerIdSchema,
  })
  .strict();

export const transferItemCommandSchema = createCommandEnvelopeSchema(
  "transfer_item",
  1,
  transferItemPayloadSchema,
);

export const itemTransferRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "item_not_found",
  "container_not_found",
  "source_mismatch",
  "same_container",
  "source_inaccessible",
  "destination_inaccessible",
  "destination_full",
] as const;

export const itemTransferRejectionCodeSchema = z.enum(itemTransferRejectionCodes);
export const itemTransferCommandResultSchema = createCommandResultSchema(itemTransferRejectionCodeSchema);

// Compatibility aliases remain local to this first command family while later
// families import the generic result contracts directly.
export const acceptedCommandResultSchema = acceptedSimulationCommandResultSchema;
export const conflictCommandResultSchema = conflictSimulationCommandResultSchema;

const itemTransferredPayloadSchema = transferItemPayloadSchema.extend({
  /** Captured derived value: replay does not recompute historical eligibility. */
  observerActorIds: actorIdsSchema,
});

export const itemTransferredEventSchema = createEventEnvelopeSchema(
  "item_transferred",
  1,
  itemTransferredPayloadSchema,
).extend({
  derivationVersion: gate1PerceptionVersionSchema,
  commandId: commandIdSchema,
});

export const itemTransferNarrativeBeatSchema = z
  .object({
    kind: z.literal("item_transferred"),
    eventId: eventIdSchema,
    sequence: branchSequenceSchema,
    actorId: worldCharacterIdSchema,
    actorName: z.string().trim().min(1),
    itemId: itemIdSchema,
    itemName: z.string().trim().min(1),
    fromContainerId: holdingContainerIdSchema,
    fromContainerName: z.string().trim().min(1),
    toContainerId: holdingContainerIdSchema,
    toContainerName: z.string().trim().min(1),
  })
  .strict();

export const itemTransferForbiddenClaimSchema = z
  .object({
    kind: z.enum(["additional_item_transfer", "unobserved_inventory_change"]),
    publicText: z.string().trim().min(1),
  })
  .strict();

/** The deliberately small, perspective-safe Gate 1 subset of engine.spec §22. */
export const itemTransferNarrativeCutSchema = z
  .object({
    id: narrativeCutIdSchema,
    semanticHash: z.string().regex(/^[0-9a-f]{8}$/u),
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    branchVersion: branchVersionSchema,
    fromSequence: branchHeadSequenceSchema,
    throughSequence: branchHeadSequenceSchema,
    fromStorySecond: storySecondSchema,
    throughStorySecond: storySecondSchema,
    viewpointActorId: worldCharacterIdSchema,
    mustEnact: z.array(itemTransferNarrativeBeatSchema),
    perceptibleNow: z.array(itemTransferNarrativeBeatSchema),
    allowedTransitions: z.tuple([]),
    forbiddenClaims: z.array(itemTransferForbiddenClaimSchema),
    provenance: z.array(
      z
        .object({
          eventId: eventIdSchema,
          observationId: observationIdSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .refine((cut) => cut.throughSequence >= cut.fromSequence, {
    message: "NarrativeCut sequence range is reversed",
    path: ["throughSequence"],
  })
  .refine((cut) => cut.throughStorySecond >= cut.fromStorySecond, {
    message: "NarrativeCut story-time range is reversed",
    path: ["throughStorySecond"],
  });

export type SimulationActor = z.infer<typeof simulationActorSchema>;
export type HoldingContainer = z.infer<typeof holdingContainerSchema>;
export type SimulationItem = z.infer<typeof simulationItemSchema>;
export type ItemTransferObservation = z.infer<typeof itemTransferObservationSchema>;
export type ItemTransferProjection = z.infer<typeof itemTransferProjectionSchema>;
export type ItemTransferProjectionInput = z.input<typeof itemTransferProjectionSchema>;
export type TransferItemCommand = z.infer<typeof transferItemCommandSchema>;
export type TransferItemCommandInput = z.input<typeof transferItemCommandSchema>;
export type ItemTransferRejectionCode = z.infer<typeof itemTransferRejectionCodeSchema>;
export type ItemTransferCommandResult = z.infer<typeof itemTransferCommandResultSchema>;
export type ItemTransferredEvent = z.infer<typeof itemTransferredEventSchema>;
export type ItemTransferNarrativeBeat = z.infer<typeof itemTransferNarrativeBeatSchema>;
export type ItemTransferForbiddenClaim = z.infer<typeof itemTransferForbiddenClaimSchema>;
export type ItemTransferNarrativeCut = z.infer<typeof itemTransferNarrativeCutSchema>;
export type ItemTransferNarrativeCutInput = z.input<typeof itemTransferNarrativeCutSchema>;
