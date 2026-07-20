import { z } from "zod";

/**
 * Runtime shape shared by every opaque simulation identifier.
 *
 * IDs are deliberately not trimmed or case-folded: normalizing an identity at a
 * trust boundary can alias two commands or entities. Prefixes remain an adapter
 * concern so persisted cuid2 values and deterministic test IDs are both legal.
 */
function opaqueSimulationIdSchema(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, "Simulation IDs cannot have surrounding whitespace")
    .refine((value) => !/\s/u.test(value), "Simulation IDs cannot contain whitespace");
}

const compactSimulationIdSchema = opaqueSimulationIdSchema(256);
const derivedSimulationIdSchema = opaqueSimulationIdSchema(1_024);
const observationIdentitySchema = opaqueSimulationIdSchema(2_048);

const stableTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "Stable tokens cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "Stable tokens cannot contain whitespace");

export const worldTypeIdSchema = compactSimulationIdSchema.brand<"WorldTypeId">();
export const worldIdSchema = compactSimulationIdSchema.brand<"WorldId">();
export const worldBranchIdSchema = compactSimulationIdSchema.brand<"WorldBranchId">();
export const characterTemplateIdSchema = compactSimulationIdSchema.brand<"CharacterTemplateId">();
export const worldCharacterIdSchema = compactSimulationIdSchema.brand<"WorldCharacterId">();
export const playerCharacterIdSchema = compactSimulationIdSchema.brand<"PlayerCharacterId">();
export const locationIdSchema = compactSimulationIdSchema.brand<"LocationId">();
export const zoneIdSchema = compactSimulationIdSchema.brand<"ZoneId">();
export const linkIdSchema = compactSimulationIdSchema.brand<"LinkId">();
export const itemIdSchema = compactSimulationIdSchema.brand<"ItemId">();
export const holdingContainerIdSchema = compactSimulationIdSchema.brand<"HoldingContainerId">();
export const actionDefinitionIdSchema = compactSimulationIdSchema.brand<"ActionDefinitionId">();
export const activityInstanceIdSchema = compactSimulationIdSchema.brand<"ActivityInstanceId">();
export const commitmentIdSchema = compactSimulationIdSchema.brand<"CommitmentId">();
export const journeyIdSchema = compactSimulationIdSchema.brand<"JourneyId">();
export const engagementIdSchema = compactSimulationIdSchema.brand<"EngagementId">();
export const bodyConditionIdSchema = compactSimulationIdSchema.brand<"BodyConditionId">();
export const bodyModifierIdSchema = compactSimulationIdSchema.brand<"BodyModifierId">();
export const itemConditionModifierIdSchema = compactSimulationIdSchema.brand<"ItemConditionModifierId">();
export const commandIdSchema = compactSimulationIdSchema.brand<"CommandId">();
export const eventIdSchema = derivedSimulationIdSchema.brand<"EventId">();
export const triggerIdSchema = compactSimulationIdSchema.brand<"TriggerId">();
export const observationIdSchema = observationIdentitySchema.brand<"ObservationId">();
export const assertionIdSchema = observationIdentitySchema.brand<"AssertionId">();
export const beliefIdSchema = observationIdentitySchema.brand<"BeliefId">();
export const narrativeCutIdSchema = derivedSimulationIdSchema.brand<"NarrativeCutId">();
export const softCanonEntryIdSchema = observationIdentitySchema.brand<"SoftCanonEntryId">();
export const principalIdSchema = compactSimulationIdSchema.brand<"PrincipalId">();
export const correlationIdSchema = compactSimulationIdSchema.brand<"CorrelationId">();
export const outboxMessageIdSchema = observationIdentitySchema.brand<"OutboxMessageId">();
export const snapshotIdSchema = compactSimulationIdSchema.brand<"SnapshotId">();

/** Heterogeneous event references use this registry identity, never a display name. */
export const simulationEntityIdSchema = compactSimulationIdSchema.brand<"SimulationEntityId">();

export const rulesetVersionSchema = stableTokenSchema.brand<"RulesetVersion">();
export const idempotencyKeySchema = stableTokenSchema.brand<"IdempotencyKey">();
export const derivationVersionSchema = stableTokenSchema.brand<"DerivationVersion">();

export const storySecondSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const branchVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const branchHeadSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const branchSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const schemaVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Length-prefixing prevents delimiter-bearing opaque IDs from aliasing one another. */
export function composeSimulationId(namespace: string, parts: readonly string[]): string {
  return [namespace, ...parts].map((part) => `${part.length}:${part}`).join(":");
}

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
export type BodyConditionId = z.infer<typeof bodyConditionIdSchema>;
export type BodyModifierId = z.infer<typeof bodyModifierIdSchema>;
export type ItemConditionModifierId = z.infer<typeof itemConditionModifierIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type TriggerId = z.infer<typeof triggerIdSchema>;
export type ObservationId = z.infer<typeof observationIdSchema>;
export type AssertionId = z.infer<typeof assertionIdSchema>;
export type BeliefId = z.infer<typeof beliefIdSchema>;
export type NarrativeCutId = z.infer<typeof narrativeCutIdSchema>;
export type SoftCanonEntryId = z.infer<typeof softCanonEntryIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type CorrelationId = z.infer<typeof correlationIdSchema>;
export type OutboxMessageId = z.infer<typeof outboxMessageIdSchema>;
export type SnapshotId = z.infer<typeof snapshotIdSchema>;
export type SimulationEntityId = z.infer<typeof simulationEntityIdSchema>;
export type RulesetVersion = z.infer<typeof rulesetVersionSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
export type DerivationVersion = z.infer<typeof derivationVersionSchema>;
