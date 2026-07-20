import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  commandIdSchema,
  householdIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";
import { simulationMaterialItemSchema } from "./materials";

/**
 * E5.4 — households, means, and money at LOD (engine.spec §26.8–26.11).
 * Households are first-class branch-scoped entities; fungible material lots
 * are branch-scoped accounts with fixed-point/count conserved quantities;
 * means bands are a coarse read for low-detail subjects; promotion (§27.2) is
 * the ONLY path an aggregate fact becomes an explicit `sim_items` row; the
 * household restock routine (§26.11) is a scheduler-armed, self-reconfiguring
 * replenishment cycle.
 */

export const householdsDerivationVersion = "households-v1" as const;

// ---------------------------------------------------------------------------
// Household + membership (§26.8)
// ---------------------------------------------------------------------------

export const householdMemberRoles = ["resident", "dependent", "guest"] as const;
export const householdMemberRoleSchema = z.enum(householdMemberRoles);
export type HouseholdMemberRole = z.infer<typeof householdMemberRoleSchema>;

export const householdMembershipStatuses = ["active", "ended"] as const;
export const householdMembershipStatusSchema = z.enum(householdMembershipStatuses);
export type HouseholdMembershipStatus = z.infer<typeof householdMembershipStatusSchema>;

const householdStockAllowListSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Household stock allow-list actor IDs",
);

/** Fail-closed §26.8 access on a household's shared stores. */
export const householdStockAccessPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("members_only") }).strict(),
  z.object({ kind: z.literal("allow_list"), actorIds: householdStockAllowListSchema }).strict(),
]);
export type HouseholdStockAccessPolicy = z.infer<typeof householdStockAccessPolicySchema>;

const residenceZoneIdsSchema = createStableStringSetSchema(zoneIdSchema, "Residence zone IDs")
  .min(1)
  .max(16);

export const simulationHouseholdSchema = z
  .object({
    id: householdIdSchema,
    name: z.string().trim().min(1),
    residenceZoneIds: residenceZoneIdsSchema,
    stockAccessPolicy: householdStockAccessPolicySchema,
  })
  .strict();
export type SimulationHousehold = z.infer<typeof simulationHouseholdSchema>;

/**
 * A membership row's shape is identical whether read as persisted state,
 * carried on `set_household_membership`'s payload, or carried on
 * `household_membership_set`'s payload — reused for all three below rather
 * than re-declared three times.
 */
export const householdMembershipSchema = z
  .object({
    householdId: householdIdSchema,
    actorId: worldCharacterIdSchema,
    role: householdMemberRoleSchema,
    status: householdMembershipStatusSchema,
    endedAtStorySecond: storySecondSchema.optional(),
  })
  .strict()
  .refine((membership) => (membership.status === "ended") === (membership.endedAtStorySecond !== undefined), {
    message: "endedAtStorySecond must be set iff status is ended",
    path: ["endedAtStorySecond"],
  });
export type HouseholdMembership = z.infer<typeof householdMembershipSchema>;

// ---------------------------------------------------------------------------
// Material kind registry (§26.9) — quantity representation, registry-as-data
// ---------------------------------------------------------------------------

export const materialQuantityKinds = ["fixed_point", "count"] as const;
export const materialQuantityKindSchema = z.enum(materialQuantityKinds);
export type MaterialQuantityKind = z.infer<typeof materialQuantityKindSchema>;

export const materialKindRegistryVersion = "material-kind-v1" as const;
export const materialKindRegistryVersions = [materialKindRegistryVersion] as const;
export const materialKindRegistryVersionSchema = z.enum(materialKindRegistryVersions);
export type MaterialKindRegistryVersion = z.infer<typeof materialKindRegistryVersionSchema>;

/** The one reserved kind key. Every other key is free text, same as `SimulationMaterialItem.materialKindKey`. */
export const RESERVED_CURRENCY_MATERIAL_KIND = "currency" as const;

export const materialKindDefinitionSchema = z
  .object({
    key: z.string().min(1).max(64),
    quantityKind: materialQuantityKindSchema,
  })
  .strict();
export type MaterialKindDefinition = z.infer<typeof materialKindDefinitionSchema>;

/**
 * Unregistered keys default to `count` (§26.9) — this list only needs entries
 * that are NOT `count`, i.e. today just currency. Extending it is a data edit.
 */
export const materialKindRegistryV1: readonly MaterialKindDefinition[] = [
  materialKindDefinitionSchema.parse({ key: RESERVED_CURRENCY_MATERIAL_KIND, quantityKind: "fixed_point" }),
];
export const materialKindRegistryByVersion: Record<
  MaterialKindRegistryVersion,
  readonly MaterialKindDefinition[]
> = {
  [materialKindRegistryVersion]: materialKindRegistryV1,
};

// ---------------------------------------------------------------------------
// Lot locus + substrate (§26.9) — flat, no container nesting, zero is not terminal
// ---------------------------------------------------------------------------

export const lotLocusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("household"), householdId: householdIdSchema }).strict(),
  z.object({ kind: z.literal("actor"), actorId: worldCharacterIdSchema }).strict(),
  z.object({ kind: z.literal("zone"), zoneId: zoneIdSchema }).strict(),
]);
export type LotLocus = z.infer<typeof lotLocusSchema>;

const quantityRawSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Signed request/delta magnitudes; sign/zero semantics are a resolver rejection, not a schema failure. */
const signedRawSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

export const materialLotStateSchema = z
  .object({
    locus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    quantityKind: materialQuantityKindSchema,
    quantityRaw: quantityRawSchema,
    registryVersion: materialKindRegistryVersionSchema,
  })
  .strict();
export type MaterialLotState = z.infer<typeof materialLotStateSchema>;

// ---------------------------------------------------------------------------
// Means bands (§26.10) — closed, ordered, versioned world-type vocabulary
// ---------------------------------------------------------------------------

export const meansBandKeys = [
  "destitute",
  "struggling",
  "modest",
  "comfortable",
  "wealthy",
  "opulent",
] as const;
export const meansBandKeySchema = z.enum(meansBandKeys);
export type MeansBandKey = z.infer<typeof meansBandKeySchema>;

export const meansBandRegistryVersion = "means-band-v1" as const;
export const meansBandRegistryVersions = [meansBandRegistryVersion] as const;
export const meansBandRegistryVersionSchema = z.enum(meansBandRegistryVersions);
export type MeansBandRegistryVersion = z.infer<typeof meansBandRegistryVersionSchema>;

/** Ordinal rank, least to most means — `meansBandKeys` index order IS the ranking. */
export function compareMeansBands(a: MeansBandKey, b: MeansBandKey): number {
  return meansBandKeys.indexOf(a) - meansBandKeys.indexOf(b);
}

export const meansSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("actor"), actorId: worldCharacterIdSchema }).strict(),
  z.object({ kind: z.literal("household"), householdId: householdIdSchema }).strict(),
]);
export type MeansSubject = z.infer<typeof meansSubjectSchema>;

export const meansBandStateSchema = z
  .object({
    subject: meansSubjectSchema,
    bandKey: meansBandKeySchema,
    registryVersion: meansBandRegistryVersionSchema,
    setAtStorySecond: storySecondSchema,
  })
  .strict();
export type MeansBandState = z.infer<typeof meansBandStateSchema>;

/** The three read outcomes (§26.10) — a discriminated union, never a bare number+flag. */
export const meansReadSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lot_tracked"),
      quantityRaw: quantityRawSchema,
      quantityKind: materialQuantityKindSchema,
    })
    .strict(),
  z.object({ kind: z.literal("band_tracked"), bandKey: meansBandKeySchema }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
export type MeansRead = z.infer<typeof meansReadSchema>;

// ---------------------------------------------------------------------------
// Restock routine (§26.11) — authored per-household-per-kind, registry-as-data ROWS
// ---------------------------------------------------------------------------

export const restockFundingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("lot"),
      currencyLocus: lotLocusSchema,
      unitPriceRaw: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("means_band_envelope"), minimumBandKey: meansBandKeySchema }).strict(),
]);
export type RestockFunding = z.infer<typeof restockFundingSchema>;

export const householdRestockRoutineSchema = z
  .object({
    householdId: householdIdSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    targetQuantityRaw: quantityRawSchema,
    lowWaterThresholdRaw: quantityRawSchema,
    cadenceSeconds: z.number().int().positive().max(31_536_000), // capped at one year
    funding: restockFundingSchema,
    active: z.boolean(),
  })
  .strict()
  .refine((routine) => routine.lowWaterThresholdRaw <= routine.targetQuantityRaw, {
    message: "lowWaterThresholdRaw must not exceed targetQuantityRaw",
    path: ["lowWaterThresholdRaw"],
  });
export type HouseholdRestockRoutine = z.infer<typeof householdRestockRoutineSchema>;

// ---------------------------------------------------------------------------
// Promotion funding (§26.10 / §27.2)
// ---------------------------------------------------------------------------

export const promotionFundingSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("stock"), sourceLocus: lotLocusSchema, quantityRaw: z.number().int().positive() })
    .strict(),
  z
    .object({
      kind: z.literal("purchase"),
      currencyLocus: lotLocusSchema,
      unitPriceRaw: z.number().int().positive(),
      quantityRaw: z.number().int().positive(),
    })
    .strict(),
]);
export type PromotionFunding = z.infer<typeof promotionFundingSchema>;

/** The command-supplied item shape, minus `id` and `locus` (both engine-assigned). */
export const promotedItemInputSchema = simulationMaterialItemSchema.omit({ id: true, locus: true }).extend({
  name: z.string().trim().min(1).optional(), // omit to sample from the name pool
});
export type PromotedItemInput = z.infer<typeof promotedItemInputSchema>;

/** §6.3/§6.4 derivation capture — replay reads the recorded draw, never resamples. */
export const promotionSampledDetailSchema = z
  .object({
    stream: z.string().min(1).max(512),
    drawIndex: z.number().int().nonnegative(),
    sampledName: z.string().trim().min(1).optional(),
    registryVersion: z.string().min(1).max(64),
  })
  .strict();
export type PromotionSampledDetail = z.infer<typeof promotionSampledDetailSchema>;

// ---------------------------------------------------------------------------
// Projection (mirrors `materialsProjectionSchema` / `itemConditionsProjectionSchema`)
// ---------------------------------------------------------------------------

export const householdsProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    households: z.array(simulationHouseholdSchema),
    memberships: z.array(householdMembershipSchema),
    lots: z.array(materialLotStateSchema),
    meansBands: z.array(meansBandStateSchema),
    restockRoutines: z.array(householdRestockRoutineSchema),
  })
  .strict();
export type HouseholdsProjection = z.infer<typeof householdsProjectionSchema>;

// ---------------------------------------------------------------------------
// create_household (§26.8)
// ---------------------------------------------------------------------------

const createHouseholdPayloadSchema = z
  .object({
    householdId: householdIdSchema,
    name: z.string().trim().min(1),
    residenceZoneIds: residenceZoneIdsSchema,
    stockAccessPolicy: householdStockAccessPolicySchema,
  })
  .strict();

export const createHouseholdCommandSchema = createCommandEnvelopeSchema(
  "create_household",
  1,
  createHouseholdPayloadSchema,
);

export const createHouseholdRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "household_already_exists",
  "zone_not_found",
] as const;
export const createHouseholdRejectionCodeSchema = z.enum(createHouseholdRejectionCodes);
export const createHouseholdCommandResultSchema = createCommandResultSchema(
  createHouseholdRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// set_household_membership (§26.8)
// ---------------------------------------------------------------------------

export const setHouseholdMembershipCommandSchema = createCommandEnvelopeSchema(
  "set_household_membership",
  1,
  householdMembershipSchema,
);

export const setHouseholdMembershipRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "household_not_found",
  "actor_not_found",
  "no_op",
] as const;
export const setHouseholdMembershipRejectionCodeSchema = z.enum(setHouseholdMembershipRejectionCodes);
export const setHouseholdMembershipCommandResultSchema = createCommandResultSchema(
  setHouseholdMembershipRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// adjust_material_lot (§26.9) — privileged authoring, exempt from co-location
// ---------------------------------------------------------------------------

/**
 * `authoring` is a privileged storyteller/system injection (slice 1).
 * `promotion_cost` debits a promotion's funding lot; `restock_purchase`
 * debits/credits a `lot`-funded restock cycle's two causally-linked
 * adjustments; `restock_topup_unconserved` credits a `means_band_envelope`-
 * funded restock cycle's single, deliberately non-conserved top-up (slice 2,
 * §26.11).
 */
export const materialLotAdjustReasons = [
  "authoring",
  "promotion_cost",
  "restock_purchase",
  "restock_topup_unconserved",
] as const;
export const materialLotAdjustReasonSchema = z.enum(materialLotAdjustReasons);
export type MaterialLotAdjustReason = z.infer<typeof materialLotAdjustReasonSchema>;

const adjustMaterialLotPayloadSchema = z
  .object({
    locus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    deltaRaw: signedRawSchema,
  })
  .strict();

export const adjustMaterialLotCommandSchema = createCommandEnvelopeSchema(
  "adjust_material_lot",
  1,
  adjustMaterialLotPayloadSchema,
);

export const adjustMaterialLotRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "non_zero_delta_required",
  "locus_not_found",
  "insufficient_balance",
] as const;
export const adjustMaterialLotRejectionCodeSchema = z.enum(adjustMaterialLotRejectionCodes);
export const adjustMaterialLotCommandResultSchema = createCommandResultSchema(
  adjustMaterialLotRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// transfer_lot_quantity (§26.9) — same-kind conserved movement between lots
// ---------------------------------------------------------------------------

const transferLotQuantityPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    fromLocus: lotLocusSchema,
    toLocus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    quantityRaw: signedRawSchema,
  })
  .strict();

export const transferLotQuantityCommandSchema = createCommandEnvelopeSchema(
  "transfer_lot_quantity",
  1,
  transferLotQuantityPayloadSchema,
);

export const transferLotQuantityRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "non_positive_quantity",
  "same_locus",
  "root_not_colocated",
  "household_access_denied",
  "insufficient_balance",
] as const;
export const transferLotQuantityRejectionCodeSchema = z.enum(transferLotQuantityRejectionCodes);
export const transferLotQuantityCommandResultSchema = createCommandResultSchema(
  transferLotQuantityRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// set_means_band (§26.10)
// ---------------------------------------------------------------------------

const setMeansBandPayloadSchema = z
  .object({
    subject: meansSubjectSchema,
    bandKey: meansBandKeySchema,
  })
  .strict();

export const setMeansBandCommandSchema = createCommandEnvelopeSchema(
  "set_means_band",
  1,
  setMeansBandPayloadSchema,
);

export const setMeansBandRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "subject_not_found",
  "no_op",
] as const;
export const setMeansBandRejectionCodeSchema = z.enum(setMeansBandRejectionCodes);
export const setMeansBandCommandResultSchema = createCommandResultSchema(setMeansBandRejectionCodeSchema);

// ---------------------------------------------------------------------------
// configure_restock_routine (§26.11)
// ---------------------------------------------------------------------------

export const configureRestockRoutineCommandSchema = createCommandEnvelopeSchema(
  "configure_restock_routine",
  1,
  householdRestockRoutineSchema,
);

export const configureRestockRoutineRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "household_not_found",
] as const;
export const configureRestockRoutineRejectionCodeSchema = z.enum(configureRestockRoutineRejectionCodes);
export const configureRestockRoutineCommandResultSchema = createCommandResultSchema(
  configureRestockRoutineRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// promote_item_from_stock (§26.10 / §27.2) — the only path an aggregate fact
// becomes an explicit `sim_items` row
// ---------------------------------------------------------------------------

const promoteItemFromStockPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    funding: promotionFundingSchema,
    item: promotedItemInputSchema,
  })
  .strict();

export const promoteItemFromStockCommandSchema = createCommandEnvelopeSchema(
  "promote_item_from_stock",
  1,
  promoteItemFromStockPayloadSchema,
);

export const promoteItemFromStockRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "root_not_colocated",
  "household_access_denied",
  "invalid_funding_kind",
  "insufficient_balance",
  "name_required",
] as const;
export const promoteItemFromStockRejectionCodeSchema = z.enum(promoteItemFromStockRejectionCodes);
export const promoteItemFromStockCommandResultSchema = createCommandResultSchema(
  promoteItemFromStockRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// run_household_restock (§26.11) — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

const runHouseholdRestockPayloadSchema = z
  .object({
    householdId: householdIdSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    /** The routine's arming sequence at the moment this alarm was scheduled —
     * mirrors `resolveBodyThresholdCommandSchema`'s `armedAtSequence` staleness
     * defense. */
    armedAtSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const runHouseholdRestockCommandSchema = createCommandEnvelopeSchema(
  "run_household_restock",
  1,
  runHouseholdRestockPayloadSchema,
);

export const runHouseholdRestockRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "unauthorized_principal",
  "routine_not_found",
  "threshold_stale",
] as const;
export const runHouseholdRestockRejectionCodeSchema = z.enum(runHouseholdRestockRejectionCodes);
export const runHouseholdRestockCommandResultSchema = createCommandResultSchema(
  runHouseholdRestockRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// Household event family (§9.2, §26.8–26.9)
// ---------------------------------------------------------------------------

const householdCreatedPayloadSchema = z
  .object({
    householdId: householdIdSchema,
    name: z.string().trim().min(1),
    residenceZoneIds: residenceZoneIdsSchema,
    stockAccessPolicy: householdStockAccessPolicySchema,
  })
  .strict();

export const householdCreatedEventSchema = createEventEnvelopeSchema(
  "household_created",
  1,
  householdCreatedPayloadSchema,
).extend({ commandId: commandIdSchema });

export const householdMembershipSetEventSchema = createEventEnvelopeSchema(
  "household_membership_set",
  1,
  householdMembershipSchema,
).extend({ commandId: commandIdSchema });

/** Lazy init (mirrors `item_condition_initialized`): a trailing event, no `.extend`. */
const materialLotInitializedPayloadSchema = z
  .object({
    locus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    quantityKind: materialQuantityKindSchema,
    registryVersion: materialKindRegistryVersionSchema,
  })
  .strict();

export const materialLotInitializedEventSchema = createEventEnvelopeSchema(
  "material_lot_initialized",
  1,
  materialLotInitializedPayloadSchema,
);

const materialLotAdjustedPayloadSchema = z
  .object({
    locus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    deltaRaw: signedRawSchema,
    resultingQuantityRaw: quantityRawSchema,
    quantityKind: materialQuantityKindSchema,
    reason: materialLotAdjustReasonSchema,
  })
  .strict();

export const materialLotAdjustedEventSchema = createEventEnvelopeSchema(
  "material_lot_adjusted",
  1,
  materialLotAdjustedPayloadSchema,
).extend({ commandId: commandIdSchema });

const materialLotTransferredPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    fromLocus: lotLocusSchema,
    toLocus: lotLocusSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    quantityRaw: quantityRawSchema,
    resultingFromQuantityRaw: quantityRawSchema,
    resultingToQuantityRaw: quantityRawSchema,
  })
  .strict();

export const materialLotTransferredEventSchema = createEventEnvelopeSchema(
  "material_lot_transferred",
  1,
  materialLotTransferredPayloadSchema,
).extend({ commandId: commandIdSchema });

const meansBandSetPayloadSchema = z
  .object({
    subject: meansSubjectSchema,
    bandKey: meansBandKeySchema,
    registryVersion: meansBandRegistryVersionSchema,
    setAtStorySecond: storySecondSchema,
  })
  .strict();

export const meansBandSetEventSchema = createEventEnvelopeSchema(
  "means_band_set",
  1,
  meansBandSetPayloadSchema,
).extend({ commandId: commandIdSchema });

/** `configure_restock_routine` always upserts the row wholesale — the event
 * payload IS the routine (mirrors `household_membership_set` reusing
 * `householdMembershipSchema`). */
export const householdRestockRoutineConfiguredEventSchema = createEventEnvelopeSchema(
  "household_restock_routine_configured",
  1,
  householdRestockRoutineSchema,
).extend({ commandId: commandIdSchema });

const itemInstantiatedFromPromotionPayloadSchema = z
  .object({
    item: simulationMaterialItemSchema,
    sourceLocus: lotLocusSchema,
    sourceMaterialKindKey: z.string().trim().min(1).max(64),
    /** Absent when the caller supplied an explicit `item.name` (§27.2 step 5). */
    sampledDetail: promotionSampledDetailSchema.optional(),
  })
  .strict();

/** Trailing (mirrors `itemConditionModifierAppliedEventSchema`): causation-chained to the
 * `material_lot_adjusted` debit that funded this promotion — no `.extend`. */
export const itemInstantiatedFromPromotionEventSchema = createEventEnvelopeSchema(
  "item_instantiated_from_promotion",
  1,
  itemInstantiatedFromPromotionPayloadSchema,
);

const householdRestockFulfilledPayloadSchema = z
  .object({
    householdId: householdIdSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    resultingQuantityRaw: quantityRawSchema,
  })
  .strict();

export const householdRestockFulfilledEventSchema = createEventEnvelopeSchema(
  "household_restock_fulfilled",
  1,
  householdRestockFulfilledPayloadSchema,
).extend({ commandId: commandIdSchema });

export const householdRestockDeferredReasons = ["already_stocked", "insufficient_funds"] as const;
export const householdRestockDeferredReasonSchema = z.enum(householdRestockDeferredReasons);
export type HouseholdRestockDeferredReason = z.infer<typeof householdRestockDeferredReasonSchema>;

const householdRestockDeferredPayloadSchema = z
  .object({
    householdId: householdIdSchema,
    materialKindKey: z.string().trim().min(1).max(64),
    reason: householdRestockDeferredReasonSchema,
  })
  .strict();

export const householdRestockDeferredEventSchema = createEventEnvelopeSchema(
  "household_restock_deferred",
  1,
  householdRestockDeferredPayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateHouseholdCommand = z.infer<typeof createHouseholdCommandSchema>;
export type CreateHouseholdCommandInput = z.input<typeof createHouseholdCommandSchema>;
export type CreateHouseholdRejectionCode = z.infer<typeof createHouseholdRejectionCodeSchema>;
export type CreateHouseholdCommandResult = z.infer<typeof createHouseholdCommandResultSchema>;

export type SetHouseholdMembershipCommand = z.infer<typeof setHouseholdMembershipCommandSchema>;
export type SetHouseholdMembershipCommandInput = z.input<typeof setHouseholdMembershipCommandSchema>;
export type SetHouseholdMembershipRejectionCode = z.infer<typeof setHouseholdMembershipRejectionCodeSchema>;
export type SetHouseholdMembershipCommandResult = z.infer<typeof setHouseholdMembershipCommandResultSchema>;

export type AdjustMaterialLotCommand = z.infer<typeof adjustMaterialLotCommandSchema>;
export type AdjustMaterialLotCommandInput = z.input<typeof adjustMaterialLotCommandSchema>;
export type AdjustMaterialLotRejectionCode = z.infer<typeof adjustMaterialLotRejectionCodeSchema>;
export type AdjustMaterialLotCommandResult = z.infer<typeof adjustMaterialLotCommandResultSchema>;

export type TransferLotQuantityCommand = z.infer<typeof transferLotQuantityCommandSchema>;
export type TransferLotQuantityCommandInput = z.input<typeof transferLotQuantityCommandSchema>;
export type TransferLotQuantityRejectionCode = z.infer<typeof transferLotQuantityRejectionCodeSchema>;
export type TransferLotQuantityCommandResult = z.infer<typeof transferLotQuantityCommandResultSchema>;

export type SetMeansBandCommand = z.infer<typeof setMeansBandCommandSchema>;
export type SetMeansBandCommandInput = z.input<typeof setMeansBandCommandSchema>;
export type SetMeansBandRejectionCode = z.infer<typeof setMeansBandRejectionCodeSchema>;
export type SetMeansBandCommandResult = z.infer<typeof setMeansBandCommandResultSchema>;

export type ConfigureRestockRoutineCommand = z.infer<typeof configureRestockRoutineCommandSchema>;
export type ConfigureRestockRoutineCommandInput = z.input<typeof configureRestockRoutineCommandSchema>;
export type ConfigureRestockRoutineRejectionCode = z.infer<typeof configureRestockRoutineRejectionCodeSchema>;
export type ConfigureRestockRoutineCommandResult = z.infer<typeof configureRestockRoutineCommandResultSchema>;

export type PromoteItemFromStockCommand = z.infer<typeof promoteItemFromStockCommandSchema>;
export type PromoteItemFromStockCommandInput = z.input<typeof promoteItemFromStockCommandSchema>;
export type PromoteItemFromStockRejectionCode = z.infer<typeof promoteItemFromStockRejectionCodeSchema>;
export type PromoteItemFromStockCommandResult = z.infer<typeof promoteItemFromStockCommandResultSchema>;

export type RunHouseholdRestockCommand = z.infer<typeof runHouseholdRestockCommandSchema>;
export type RunHouseholdRestockCommandInput = z.input<typeof runHouseholdRestockCommandSchema>;
export type RunHouseholdRestockRejectionCode = z.infer<typeof runHouseholdRestockRejectionCodeSchema>;
export type RunHouseholdRestockCommandResult = z.infer<typeof runHouseholdRestockCommandResultSchema>;

export type HouseholdCreatedEvent = z.infer<typeof householdCreatedEventSchema>;
export type HouseholdMembershipSetEvent = z.infer<typeof householdMembershipSetEventSchema>;
export type MaterialLotInitializedEvent = z.infer<typeof materialLotInitializedEventSchema>;
export type MaterialLotAdjustedEvent = z.infer<typeof materialLotAdjustedEventSchema>;
export type MaterialLotTransferredEvent = z.infer<typeof materialLotTransferredEventSchema>;
export type MeansBandSetEvent = z.infer<typeof meansBandSetEventSchema>;
export type HouseholdRestockRoutineConfiguredEvent = z.infer<typeof householdRestockRoutineConfiguredEventSchema>;
export type ItemInstantiatedFromPromotionEvent = z.infer<typeof itemInstantiatedFromPromotionEventSchema>;
export type HouseholdRestockFulfilledEvent = z.infer<typeof householdRestockFulfilledEventSchema>;
export type HouseholdRestockDeferredEvent = z.infer<typeof householdRestockDeferredEventSchema>;
