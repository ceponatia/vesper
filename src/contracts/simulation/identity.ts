import { z } from "zod";

/**
 * Runtime shape shared by every opaque simulation identifier.
 *
 * IDs are deliberately not trimmed or case-folded: normalizing an identity at a
 * trust boundary can alias two commands or entities. Prefixes remain an adapter
 * concern so persisted cuid2 values and deterministic test IDs are both legal.
 */
const opaqueSimulationIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "Simulation IDs cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Simulation IDs cannot contain whitespace");

const stableTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "Stable tokens cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Stable tokens cannot contain whitespace");

export const worldTypeIdSchema = opaqueSimulationIdSchema.brand<"WorldTypeId">();
export const worldIdSchema = opaqueSimulationIdSchema.brand<"WorldId">();
export const worldBranchIdSchema = opaqueSimulationIdSchema.brand<"WorldBranchId">();
export const characterTemplateIdSchema = opaqueSimulationIdSchema.brand<"CharacterTemplateId">();
export const worldCharacterIdSchema = opaqueSimulationIdSchema.brand<"WorldCharacterId">();
export const playerCharacterIdSchema = opaqueSimulationIdSchema.brand<"PlayerCharacterId">();
export const locationIdSchema = opaqueSimulationIdSchema.brand<"LocationId">();
export const zoneIdSchema = opaqueSimulationIdSchema.brand<"ZoneId">();
export const linkIdSchema = opaqueSimulationIdSchema.brand<"LinkId">();
export const itemIdSchema = opaqueSimulationIdSchema.brand<"ItemId">();
export const holdingContainerIdSchema = opaqueSimulationIdSchema.brand<"HoldingContainerId">();
export const actionDefinitionIdSchema = opaqueSimulationIdSchema.brand<"ActionDefinitionId">();
export const activityInstanceIdSchema = opaqueSimulationIdSchema.brand<"ActivityInstanceId">();
export const commitmentIdSchema = opaqueSimulationIdSchema.brand<"CommitmentId">();
export const journeyIdSchema = opaqueSimulationIdSchema.brand<"JourneyId">();
export const engagementIdSchema = opaqueSimulationIdSchema.brand<"EngagementId">();
export const commandIdSchema = opaqueSimulationIdSchema.brand<"CommandId">();
export const eventIdSchema = opaqueSimulationIdSchema.brand<"EventId">();
export const triggerIdSchema = opaqueSimulationIdSchema.brand<"TriggerId">();
export const observationIdSchema = opaqueSimulationIdSchema.brand<"ObservationId">();
export const narrativeCutIdSchema = opaqueSimulationIdSchema.brand<"NarrativeCutId">();
export const principalIdSchema = opaqueSimulationIdSchema.brand<"PrincipalId">();
export const correlationIdSchema = opaqueSimulationIdSchema.brand<"CorrelationId">();
export const outboxMessageIdSchema = opaqueSimulationIdSchema.brand<"OutboxMessageId">();
export const snapshotIdSchema = opaqueSimulationIdSchema.brand<"SnapshotId">();

/** Heterogeneous event references use this registry identity, never a display name. */
export const simulationEntityIdSchema = opaqueSimulationIdSchema.brand<"SimulationEntityId">();

export const rulesetVersionSchema = stableTokenSchema.brand<"RulesetVersion">();
export const idempotencyKeySchema = stableTokenSchema.brand<"IdempotencyKey">();
export const derivationVersionSchema = stableTokenSchema.brand<"DerivationVersion">();

export const storySecondSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const branchVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const branchSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const schemaVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export type WorldTypeId = z.infer<typeof worldTypeIdSchema>;
export type WorldId = z.infer<typeof worldIdSchema>;
export type WorldBranchId = z.infer<typeof worldBranchIdSchema>;
export type CharacterTemplateId = z.infer<typeof characterTemplateIdSchema>;
export type WorldCharacterId = z.infer<typeof worldCharacterIdSchema>;
export type PlayerCharacterId = z.infer<typeof playerCharacterIdSchema>;
export type LocationId = z.infer<typeof locationIdSchema>;
export type ZoneId = z.infer<typeof zoneIdSchema>;
export type LinkId = z.infer<typeof linkIdSchema>;
export type ItemId = z.infer<typeof itemIdSchema>;
export type HoldingContainerId = z.infer<typeof holdingContainerIdSchema>;
export type ActionDefinitionId = z.infer<typeof actionDefinitionIdSchema>;
export type ActivityInstanceId = z.infer<typeof activityInstanceIdSchema>;
export type CommitmentId = z.infer<typeof commitmentIdSchema>;
export type JourneyId = z.infer<typeof journeyIdSchema>;
export type EngagementId = z.infer<typeof engagementIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type TriggerId = z.infer<typeof triggerIdSchema>;
export type ObservationId = z.infer<typeof observationIdSchema>;
export type NarrativeCutId = z.infer<typeof narrativeCutIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type CorrelationId = z.infer<typeof correlationIdSchema>;
export type OutboxMessageId = z.infer<typeof outboxMessageIdSchema>;
export type SnapshotId = z.infer<typeof snapshotIdSchema>;
export type SimulationEntityId = z.infer<typeof simulationEntityIdSchema>;
export type RulesetVersion = z.infer<typeof rulesetVersionSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
export type DerivationVersion = z.infer<typeof derivationVersionSchema>;
