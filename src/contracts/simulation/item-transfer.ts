import { z } from "zod";

const simulationIdSchema = z.string().trim().min(1).max(200);

export const holdingContainerKinds = ["actor", "location", "container"] as const;
export const holdingContainerKindSchema = z.enum(holdingContainerKinds);

export const simulationActorSchema = z
  .object({
    id: simulationIdSchema,
    name: z.string().trim().min(1),
    /** Containers whose contents this actor can currently perceive. */
    observedContainerIds: z.array(simulationIdSchema).default([]),
  })
  .strict();

export const holdingContainerSchema = z
  .object({
    id: simulationIdSchema,
    kind: holdingContainerKindSchema,
    name: z.string().trim().min(1),
    capacity: z.number().int().nonnegative(),
    /** Actors allowed to manipulate this holding locus in the Gate 1 slice. */
    accessibleToActorIds: z.array(simulationIdSchema).default([]),
  })
  .strict();

export const simulationItemSchema = z
  .object({
    id: simulationIdSchema,
    name: z.string().trim().min(1),
    holdingContainerId: simulationIdSchema,
  })
  .strict();

export const itemTransferObservationSchema = z
  .object({
    id: simulationIdSchema,
    sourceEventId: simulationIdSchema,
    witnessActorId: simulationIdSchema,
    sequence: z.number().int().positive(),
    storySecond: z.number().int().nonnegative(),
    itemId: simulationIdSchema,
    fromContainerId: simulationIdSchema,
    toContainerId: simulationIdSchema,
    derivationVersion: z.literal("gate1-perception-v1"),
  })
  .strict();

export const itemTransferProjectionSchema = z
  .object({
    worldId: simulationIdSchema,
    branchId: simulationIdSchema,
    rulesetVersion: z.string().trim().min(1),
    version: z.number().int().nonnegative(),
    headSequence: z.number().int().nonnegative(),
    storySecond: z.number().int().nonnegative(),
    actors: z.array(simulationActorSchema),
    containers: z.array(holdingContainerSchema),
    items: z.array(simulationItemSchema),
    observations: z.array(itemTransferObservationSchema).default([]),
  })
  .strict();

export const commandPrincipalSchema = z
  .object({
    kind: z.enum(["player", "npc_policy", "storyteller", "migration"]),
    principalId: simulationIdSchema,
    controlledActorIds: z.array(simulationIdSchema),
  })
  .strict();

export const transferItemCommandSchema = z
  .object({
    id: simulationIdSchema,
    branchId: simulationIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: simulationIdSchema,
    principal: commandPrincipalSchema,
    /** Operational metadata only; it never advances story time. */
    submittedAtWallClock: z.string().trim().min(1),
    requestedStorySecond: z.number().int().nonnegative().optional(),
    type: z.literal("transfer_item"),
    schemaVersion: z.literal(1),
    correlationId: simulationIdSchema,
    payload: z
      .object({
        actorId: simulationIdSchema,
        itemId: simulationIdSchema,
        fromContainerId: simulationIdSchema,
        toContainerId: simulationIdSchema,
      })
      .strict(),
  })
  .strict();

export const itemTransferRejectionCodes = [
  "invalid_command",
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

export const acceptedCommandResultSchema = z
  .object({
    status: z.literal("accepted"),
    commandId: simulationIdSchema,
    branchVersion: z.number().int().positive(),
    firstSequence: z.number().int().positive(),
    lastSequence: z.number().int().positive(),
    eventIds: z.array(simulationIdSchema),
  })
  .strict();

export const rejectedCommandResultSchema = z
  .object({
    status: z.literal("rejected"),
    commandId: z.string(),
    code: itemTransferRejectionCodeSchema,
    publicReason: z.string(),
    legalAlternativeCommandTypes: z.array(z.string()),
  })
  .strict();

export const conflictCommandResultSchema = z
  .object({
    status: z.literal("conflict"),
    commandId: simulationIdSchema,
    currentVersion: z.number().int().nonnegative(),
    retryable: z.boolean(),
  })
  .strict();

export const itemTransferCommandResultSchema = z.discriminatedUnion("status", [
  acceptedCommandResultSchema,
  rejectedCommandResultSchema,
  conflictCommandResultSchema,
]);

export const itemTransferredEventSchema = z
  .object({
    id: simulationIdSchema,
    worldId: simulationIdSchema,
    branchId: simulationIdSchema,
    sequence: z.number().int().positive(),
    storySecond: z.number().int().nonnegative(),
    type: z.literal("item_transferred"),
    schemaVersion: z.literal(1),
    rulesetVersion: z.string().trim().min(1),
    derivationVersion: z.literal("gate1-perception-v1"),
    commandId: simulationIdSchema,
    correlationId: simulationIdSchema,
    actorIds: z.array(simulationIdSchema),
    entityIds: z.array(simulationIdSchema),
    recordedAtWallClock: z.string().trim().min(1),
    payload: z
      .object({
        actorId: simulationIdSchema,
        itemId: simulationIdSchema,
        fromContainerId: simulationIdSchema,
        toContainerId: simulationIdSchema,
        /** Captured derived value: replay does not recompute historical eligibility. */
        observerActorIds: z.array(simulationIdSchema),
      })
      .strict(),
  })
  .strict();

export type SimulationActor = z.infer<typeof simulationActorSchema>;
export type HoldingContainer = z.infer<typeof holdingContainerSchema>;
export type SimulationItem = z.infer<typeof simulationItemSchema>;
export type ItemTransferObservation = z.infer<typeof itemTransferObservationSchema>;
export type ItemTransferProjection = z.infer<typeof itemTransferProjectionSchema>;
export type TransferItemCommand = z.infer<typeof transferItemCommandSchema>;
export type ItemTransferRejectionCode = z.infer<typeof itemTransferRejectionCodeSchema>;
export type ItemTransferCommandResult = z.infer<typeof itemTransferCommandResultSchema>;
export type ItemTransferredEvent = z.infer<typeof itemTransferredEventSchema>;

export interface ItemTransferNarrativeBeat {
  kind: "item_transferred";
  eventId: string;
  sequence: number;
  actorId: string;
  actorName: string;
  itemId: string;
  itemName: string;
  fromContainerId: string;
  fromContainerName: string;
  toContainerId: string;
  toContainerName: string;
}

export interface ItemTransferForbiddenClaim {
  kind: "additional_item_transfer" | "unobserved_inventory_change";
  publicText: string;
}

/** The deliberately small, perspective-safe Gate 1 subset of engine.spec §22. */
export interface ItemTransferNarrativeCut {
  id: string;
  semanticHash: string;
  worldId: string;
  branchId: string;
  branchVersion: number;
  fromSequence: number;
  throughSequence: number;
  fromStorySecond: number;
  throughStorySecond: number;
  viewpointActorId: string;
  mustEnact: ItemTransferNarrativeBeat[];
  perceptibleNow: ItemTransferNarrativeBeat[];
  allowedTransitions: [];
  forbiddenClaims: ItemTransferForbiddenClaim[];
  provenance: Array<{ eventId: string; observationId: string }>;
}
