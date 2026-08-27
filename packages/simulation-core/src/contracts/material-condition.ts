import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  bodyMeterDefinitionSchema,
  bodyModifierOperationSchema,
  bodySourceOperationSchema,
  bodyThresholdDirectionSchema,
  bodyModifierVisibilitySchema,
  meterFixedPointSchema,
  type BodyMeterDefinition,
} from "./bodies";
import {
  itemConditionModifierIdSchema,
  itemIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  eventIdSchema,
} from "./identity";

/**
 * E5.3 slice 3 — item condition: wear and cleanliness.
 * Wear and cleanliness ride the SAME fixed-point kernel bodies use
 * (registry-as-data, analytic drift, one modifier contract, material
 * thresholds) under an item-scoped registry version and item-scoped tables —
 * the body tables are not reused, only the pure numerics
 * (`integrateMeterValue`, `solveNextThresholdCrossing`,
 * `MeterIntegrationView` in `lib/simulation/bodies.ts`) and the TYPES here
 * (`BodyMeterDefinition` et al. are already subject-agnostic — no actorId
 * anywhere in a meter/threshold/drift-law definition).
 */

// --- Registry version (its own literal, its own one-member enum) -------------

export const itemConditionRegistryVersion = "item-condition-v1" as const;
export const itemConditionRegistryVersions = [itemConditionRegistryVersion] as const;
export const itemConditionRegistryVersionSchema = z.enum(itemConditionRegistryVersions);
export type ItemConditionRegistryVersion = z.infer<typeof itemConditionRegistryVersionSchema>;

// --- Meter registry -----------------------------------------------------------

/**
 * v1 registry. `cleanliness` is a "rate" meter that DOES NOT drift at rest —
 * the base law's rate is zero, so a held/zone-resting garment never fouls on
 * its own. The worn-window modifier (built in `lib/simulation/material-
 * condition.ts`'s `buildWornWindowTransition`) is what actually moves it: a
 * `rate_add` modifier composes with the zero base rate into a genuine
 * approach-mode decay toward the fixed 0 target, which is why the target
 * here is 0 (fully soiled), not the fresh value — a target equal to the
 * meter's own initial/current value is inert under the kernel's approach/flee
 * drift mechanics (there is nowhere left to "approach", and "fleeing" a
 * same-valued target ties toward the ceiling), so a same-valued target could
 * never actually decrease no matter the modifier's rate or sign. `wear` never
 * drifts at all (`driftLaw: "none"`) — it moves only through discrete
 * `use`-disposition activity-completion deltas.
 */
export const itemConditionRegistryV1: readonly BodyMeterDefinition[] = [
  bodyMeterDefinitionSchema.parse({
    key: "cleanliness",
    class: "rate",
    driftLaw: {
      kind: "linear",
      ratePerHourFixedPoint: 0,
      target: { kind: "fixed", valueFixedPoint: 0 },
    },
    initialFixedPoint: 10_000,
    baselineFixedPoint: 10_000,
    thresholds: [
      {
        key: "grimy",
        boundaryFixedPoint: 3_000,
        direction: "falling",
        outcome: { kind: "event_only" },
        noticeable: true,
      },
    ],
  }),
  bodyMeterDefinitionSchema.parse({
    key: "wear",
    class: "load",
    driftLaw: { kind: "none" },
    initialFixedPoint: 0,
    baselineFixedPoint: 0,
    thresholds: [
      {
        key: "worn_out",
        boundaryFixedPoint: 8_000,
        direction: "rising",
        outcome: { kind: "event_only" },
        noticeable: true,
      },
    ],
  }),
];

export const itemConditionRegistryByVersion: Record<
  ItemConditionRegistryVersion,
  readonly BodyMeterDefinition[]
> = {
  [itemConditionRegistryVersion]: itemConditionRegistryV1,
};

// --- Substrate state (mirrors bodyMeterStateSchema, itemId in place of actorId) ---

export const itemConditionMeterStateSchema = z
  .object({
    itemId: itemIdSchema,
    meterKey: z.string().min(1).max(64),
    valueFixedPoint: meterFixedPointSchema,
    baselineFixedPoint: meterFixedPointSchema,
    /** The last MATERIAL write. Queries integrate from here and never persist. */
    lastIntegratedAtStorySecond: storySecondSchema,
    registryVersion: itemConditionRegistryVersionSchema,
  })
  .strict();
export type ItemConditionMeterState = z.infer<typeof itemConditionMeterStateSchema>;

/**
 * The modifier contract, itemId in place of actorId. Items have no
 * categorical conditions in v1 (no `conditionId` — every modifier is applied
 * and retired directly, never owned by a condition).
 */
export const itemConditionModifierSchema = z
  .object({
    id: itemConditionModifierIdSchema,
    itemId: itemIdSchema,
    meterKey: z.string().min(1).max(64),
    operation: bodyModifierOperationSchema,
    /** Within one stacking group only the highest-priority live modifier applies. */
    stackingGroup: z.string().min(1).max(64),
    priority: z.number().int().min(0).max(9_999),
    validFromStorySecond: storySecondSchema,
    validUntilStorySecond: storySecondSchema.optional(),
    visibility: bodyModifierVisibilitySchema,
    sourceEventId: eventIdSchema,
  })
  .strict()
  .refine(
    (modifier) =>
      modifier.validUntilStorySecond === undefined ||
      modifier.validUntilStorySecond > modifier.validFromStorySecond,
    { message: "Modifier validity interval is empty", path: ["validUntilStorySecond"] },
  );
export type ItemConditionModifier = z.infer<typeof itemConditionModifierSchema>;

// --- Projection ----------------------------------------------------------------

export const itemConditionsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    meters: z.array(itemConditionMeterStateSchema),
    modifiers: z.array(itemConditionModifierSchema),
  })
  .strict();
export type ItemConditionsProjection = z.infer<typeof itemConditionsProjectionSchema>;

// --- Captured derivation (item modifier ids) ---------------------------------

const itemConditionObserverActorIdsSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Observer actor IDs",
);

/** What the integration knew when it wrote: replay re-derives from exactly this. */
export const itemConditionIntegrationDerivationSchema = z
  .object({
    fromValueFixedPoint: meterFixedPointSchema,
    fromStorySecond: storySecondSchema,
    activeModifierIds: createStableStringSetSchema(
      itemConditionModifierIdSchema,
      "Active item modifier IDs",
    ),
    registryVersion: itemConditionRegistryVersionSchema,
  })
  .strict();
export type ItemConditionIntegrationDerivation = z.infer<
  typeof itemConditionIntegrationDerivationSchema
>;

// --- Source vocabulary --------------------------------------------------------

export const itemConditionSourceKinds = ["use", "clean", "adjustment"] as const;
export const itemConditionSourceKindSchema = z.enum(itemConditionSourceKinds);
export type ItemConditionSourceKind = z.infer<typeof itemConditionSourceKindSchema>;

// --- Commands ------------------------------------------------------------------

const applyItemConditionSourcePayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    sourceKind: itemConditionSourceKindSchema,
    meterKey: z.string().min(1).max(64),
    operation: bodySourceOperationSchema,
  })
  .strict();

export const applyItemConditionSourceCommandSchema = createCommandEnvelopeSchema(
  "apply_item_condition_source",
  1,
  applyItemConditionSourcePayloadSchema,
);

export const applyItemConditionSourceRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "item_not_found",
  "item_gone",
  "condition_not_tracked",
  "unknown_meter_key",
  "root_not_colocated",
  "held_by_other",
  "worn_by_other",
  "container_access_denied",
  "item_reserved",
] as const;
export const applyItemConditionSourceRejectionCodeSchema = z.enum(
  applyItemConditionSourceRejectionCodes,
);
export const applyItemConditionSourceCommandResultSchema = createCommandResultSchema(
  applyItemConditionSourceRejectionCodeSchema,
);

const resolveItemConditionThresholdPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    meterKey: z.string().min(1).max(64),
    thresholdKey: z.string().min(1).max(64),
    /** Versions the trigger's uniqueness key: each re-arm is a distinct alarm. */
    armedAtSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** Dispatched by the threshold trigger; system-only, re-validated at fire time. */
export const resolveItemConditionThresholdCommandSchema = createCommandEnvelopeSchema(
  "resolve_item_condition_threshold",
  1,
  resolveItemConditionThresholdPayloadSchema,
);

export const resolveItemConditionThresholdRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "condition_not_tracked",
  "unknown_meter_key",
  "unknown_threshold_key",
  "threshold_stale",
  "unauthorized_principal",
] as const;
export const resolveItemConditionThresholdRejectionCodeSchema = z.enum(
  resolveItemConditionThresholdRejectionCodes,
);
export const resolveItemConditionThresholdCommandResultSchema = createCommandResultSchema(
  resolveItemConditionThresholdRejectionCodeSchema,
);

// --- Item condition event family ---------------------------------------------

const itemConditionInitializedPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    registryVersion: itemConditionRegistryVersionSchema,
    meters: z
      .array(
        z
          .object({
            meterKey: z.string().min(1).max(64),
            valueFixedPoint: meterFixedPointSchema,
            baselineFixedPoint: meterFixedPointSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const itemConditionInitializedEventSchema = createEventEnvelopeSchema(
  "item_condition_initialized",
  1,
  itemConditionInitializedPayloadSchema,
);

const itemConditionSourceAppliedPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    meterKey: z.string().min(1).max(64),
    sourceKind: itemConditionSourceKindSchema,
    operation: bodySourceOperationSchema,
    valueAfterFixedPoint: meterFixedPointSchema,
    derived: itemConditionIntegrationDerivationSchema,
  })
  .strict();

export const itemConditionSourceAppliedEventSchema = createEventEnvelopeSchema(
  "item_condition_source_applied",
  1,
  itemConditionSourceAppliedPayloadSchema,
);

const itemConditionModifierAppliedPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    modifier: itemConditionModifierSchema,
  })
  .strict();

export const itemConditionModifierAppliedEventSchema = createEventEnvelopeSchema(
  "item_condition_modifier_applied",
  1,
  itemConditionModifierAppliedPayloadSchema,
);

export const itemConditionModifierEndBases = ["doffed", "expired"] as const;
export const itemConditionModifierEndBasisSchema = z.enum(itemConditionModifierEndBases);
export type ItemConditionModifierEndBasis = z.infer<typeof itemConditionModifierEndBasisSchema>;

const itemConditionModifierEndedPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    modifierId: itemConditionModifierIdSchema,
    basis: itemConditionModifierEndBasisSchema,
  })
  .strict();

export const itemConditionModifierEndedEventSchema = createEventEnvelopeSchema(
  "item_condition_modifier_ended",
  1,
  itemConditionModifierEndedPayloadSchema,
);

const itemConditionThresholdCrossedPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    meterKey: z.string().min(1).max(64),
    thresholdKey: z.string().min(1).max(64),
    direction: bodyThresholdDirectionSchema,
    boundaryFixedPoint: meterFixedPointSchema,
    valueFixedPoint: meterFixedPointSchema,
    /** Captured co-located witness set (the noticeable capture idiom, from bodies). */
    observerActorIds: itemConditionObserverActorIdsSchema,
    derived: itemConditionIntegrationDerivationSchema,
  })
  .strict();

export const itemConditionThresholdCrossedEventSchema = createEventEnvelopeSchema(
  "item_condition_threshold_crossed",
  1,
  itemConditionThresholdCrossedPayloadSchema,
);

// --- Types ---------------------------------------------------------------------

export type ApplyItemConditionSourceCommand = z.infer<typeof applyItemConditionSourceCommandSchema>;
export type ApplyItemConditionSourceRejectionCode = z.infer<
  typeof applyItemConditionSourceRejectionCodeSchema
>;
export type ApplyItemConditionSourceCommandResult = z.infer<
  typeof applyItemConditionSourceCommandResultSchema
>;
export type ResolveItemConditionThresholdCommand = z.infer<
  typeof resolveItemConditionThresholdCommandSchema
>;
export type ResolveItemConditionThresholdRejectionCode = z.infer<
  typeof resolveItemConditionThresholdRejectionCodeSchema
>;
export type ResolveItemConditionThresholdCommandResult = z.infer<
  typeof resolveItemConditionThresholdCommandResultSchema
>;
export type ItemConditionInitializedEvent = z.infer<typeof itemConditionInitializedEventSchema>;
export type ItemConditionSourceAppliedEvent = z.infer<typeof itemConditionSourceAppliedEventSchema>;
export type ItemConditionModifierAppliedEvent = z.infer<
  typeof itemConditionModifierAppliedEventSchema
>;
export type ItemConditionModifierEndedEvent = z.infer<typeof itemConditionModifierEndedEventSchema>;
export type ItemConditionThresholdCrossedEvent = z.infer<
  typeof itemConditionThresholdCrossedEventSchema
>;
