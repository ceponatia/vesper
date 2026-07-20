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

/**
 * E5.4 slice 1 — households, fungible lots, conservation, and means bands
 * (engine.spec §26.8–26.10). Households are first-class branch-scoped
 * entities; fungible material lots are branch-scoped accounts with
 * fixed-point/count conserved quantities; means bands are a coarse read for
 * low-detail subjects. Promotion (§27.2) and the household restock routine
 * (§26.11) are slice 2 — their commands, events, and the `promotion_cost` /
 * `restock_purchase` / `restock_topup_unconserved` lot-adjustment reasons do
 * not exist yet (mirrors how E5.3 slice 1's `destroyItemBases` excluded
 * `consumed` until slice 2 landed).
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
 * Slice 1 only ever produces `authoring` (a privileged storyteller/system
 * injection). Slice 2 widens this to `promotion_cost` | `restock_purchase` |
 * `restock_topup_unconserved` — mirrors `destroyItemBases` excluding
 * `consumed` until E5.3 slice 2 landed the consume path.
 */
export const materialLotAdjustReasons = ["authoring"] as const;
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

export type HouseholdCreatedEvent = z.infer<typeof householdCreatedEventSchema>;
export type HouseholdMembershipSetEvent = z.infer<typeof householdMembershipSetEventSchema>;
export type MaterialLotInitializedEvent = z.infer<typeof materialLotInitializedEventSchema>;
export type MaterialLotAdjustedEvent = z.infer<typeof materialLotAdjustedEventSchema>;
export type MaterialLotTransferredEvent = z.infer<typeof materialLotTransferredEventSchema>;
export type MeansBandSetEvent = z.infer<typeof meansBandSetEventSchema>;
