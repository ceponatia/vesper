import { z } from "zod";
import {
  branchSequenceSchema,
  branchVersionSchema,
  commandIdSchema,
  correlationIdSchema,
  derivationVersionSchema,
  eventIdSchema,
  idempotencyKeySchema,
  locationIdSchema,
  principalIdSchema,
  rulesetVersionSchema,
  schemaVersionSchema,
  simulationEntityIdSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
} from "./identity";

export const principalKinds = [
  "player",
  "npc_policy",
  "npc_deliberator",
  "system",
  "director",
  "storyteller",
  "migration",
] as const;

export const principalKindSchema = z.enum(principalKinds);

function isStableSet(values: readonly string[]): boolean {
  if (new Set(values).size !== values.length) return false;
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

export function createStableStringSetSchema<TElement extends z.ZodType<string>>(
  element: TElement,
  label: string,
) {
  return z.array(element).refine(isStableSet, `${label} must be unique and sorted`);
}

export const controlledActorIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Controlled actor IDs",
);

export const commandPrincipalSchema = z
  .object({
    kind: principalKindSchema,
    principalId: principalIdSchema,
    controlledActorIds: controlledActorIdsSchema,
  })
  .strict();

export const wallClockInstantSchema = z.iso.datetime({ offset: true });

const commandEnvelopeFields = {
  id: commandIdSchema,
  branchId: worldBranchIdSchema,
  expectedVersion: branchVersionSchema,
  idempotencyKey: idempotencyKeySchema,
  principal: commandPrincipalSchema,
  /** Operational metadata only; it must never affect simulation resolution. */
  submittedAtWallClock: wallClockInstantSchema,
  requestedStorySecond: storySecondSchema.optional(),
  correlationId: correlationIdSchema,
};

export function createCommandEnvelopeSchema<
  const TType extends string,
  const TSchemaVersion extends number,
  TPayload extends z.ZodType,
>(type: TType, schemaVersion: TSchemaVersion, payload: TPayload) {
  schemaVersionSchema.parse(schemaVersion);
  return z
    .object({
      ...commandEnvelopeFields,
      type: z.literal(type),
      schemaVersion: z.literal(schemaVersion),
      payload,
    })
    .strict();
}

const eventActorIdsSchema = createStableStringSetSchema(worldCharacterIdSchema, "Event actor IDs");
const eventEntityIdsSchema = createStableStringSetSchema(simulationEntityIdSchema, "Event entity IDs");

const eventEnvelopeFields = {
  id: eventIdSchema,
  worldId: worldIdSchema,
  branchId: worldBranchIdSchema,
  sequence: branchSequenceSchema,
  storySecond: storySecondSchema,
  rulesetVersion: rulesetVersionSchema,
  derivationVersion: derivationVersionSchema.optional(),
  commandId: commandIdSchema.optional(),
  causationId: eventIdSchema.optional(),
  correlationId: correlationIdSchema,
  actorIds: eventActorIdsSchema,
  entityIds: eventEntityIdsSchema,
  locationId: locationIdSchema.optional(),
  recordedAtWallClock: wallClockInstantSchema,
};

export function createEventEnvelopeSchema<
  const TType extends string,
  const TSchemaVersion extends number,
  TPayload extends z.ZodType,
>(type: TType, schemaVersion: TSchemaVersion, payload: TPayload) {
  schemaVersionSchema.parse(schemaVersion);
  return z
    .object({
      ...eventEnvelopeFields,
      type: z.literal(type),
      schemaVersion: z.literal(schemaVersion),
      payload,
    })
    .strict();
}

export const acceptedSimulationCommandResultSchema = z
  .object({
    status: z.literal("accepted"),
    commandId: commandIdSchema,
    branchVersion: branchVersionSchema,
    firstSequence: branchSequenceSchema,
    lastSequence: branchSequenceSchema,
    eventIds: z.array(eventIdSchema).min(1),
  })
  .strict()
  .refine((result) => result.lastSequence >= result.firstSequence, {
    message: "Accepted command sequence range is reversed",
    path: ["lastSequence"],
  })
  .refine((result) => new Set(result.eventIds).size === result.eventIds.length, {
    message: "Accepted command event IDs must be unique",
    path: ["eventIds"],
  })
  .refine((result) => result.eventIds.length === result.lastSequence - result.firstSequence + 1, {
    message: "Accepted command event IDs must cover the complete sequence range",
    path: ["eventIds"],
  });

export const conflictSimulationCommandResultSchema = z
  .object({
    status: z.literal("conflict"),
    commandId: commandIdSchema,
    currentVersion: branchVersionSchema,
    retryable: z.boolean(),
  })
  .strict();

export function createCommandResultSchema<TRejectionCode extends z.ZodType<string>>(
  rejectionCode: TRejectionCode,
) {
  const rejected = z
    .object({
      status: z.literal("rejected"),
      // Malformed input may not contain a parseable command identity.
      commandId: z.string().min(1).max(512),
      code: rejectionCode,
      publicReason: z.string().min(1),
      legalAlternativeCommandTypes: createStableStringSetSchema(
        z.string().min(1),
        "Legal alternative command types",
      ),
    })
    .strict();

  return z.discriminatedUnion("status", [
    acceptedSimulationCommandResultSchema,
    rejected,
    conflictSimulationCommandResultSchema,
  ]);
}

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type CommandPrincipal = z.infer<typeof commandPrincipalSchema>;
export type AcceptedSimulationCommandResult = z.infer<typeof acceptedSimulationCommandResultSchema>;
export type ConflictSimulationCommandResult = z.infer<typeof conflictSimulationCommandResultSchema>;
