import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import { bodySourceOperationSchema } from "./bodies";
import {
  branchHeadSequenceSchema,
  branchVersionSchema,
  commandIdSchema,
  itemIdSchema,
  rulesetVersionSchema,
  storySecondSchema,
  worldBranchIdSchema,
  worldCharacterIdSchema,
  worldIdSchema,
  worldTypeIdSchema,
  zoneIdSchema,
} from "./identity";

/**
 * E5.3 slice 1 — the honest material lane. Every item has exactly one holding
 * locus; containers are items; ownership is social, not physical. This contract
 * replaces the Gate 1 `transfer_item` v1 stand-in (pseudo-container rows,
 * captured witness sets) wholesale — no legacy wrappers.
 *
 * Slice 2 (§26.5–26.6) adds resource reservations (activities.ts) and
 * consumption: `consume_item` and the completion path of a `consume`-
 * disposition resource cost both emit `item_consumed`, with trailing
 * `body_source_applied` events for the item's authored `consumptionEffects`
 * integrated through the §25 body kernel in the same transaction.
 */

/** Stamped on every material event, matching the sibling domains' convention (bodies, scheduler). */
export const materialDerivationVersion = "material-v1" as const;

// ---------------------------------------------------------------------------
// Holding locus (§26.1)
// ---------------------------------------------------------------------------

/**
 * The terminal dispositions of a `gone` item. `gone` is a one-way sink: no
 * transition leaves it, so a "found again" is a new item, never a resurrection.
 */
export const itemGoneBases = ["consumed", "destroyed", "lost"] as const;
export const itemGoneBasisSchema = z.enum(itemGoneBases);
export type ItemGoneBasis = z.infer<typeof itemGoneBasisSchema>;

/** Free-text worn slot keys in v1; the chat wardrobe's slot vocabulary ports later. */
const wornSlotKeySchema = z.string().trim().min(1).max(64);

/**
 * Exactly one holding locus per item per story second (the holdings-row primary
 * key is the "an item cannot be in two places" invariant). Held/worn reference
 * an actor directly, container references another item, zone references a zone,
 * and gone is terminal. There are no pseudo-container rows for actors/locations.
 */
export const itemLocusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("held"), actorId: worldCharacterIdSchema }).strict(),
  z
    .object({ kind: z.literal("worn"), actorId: worldCharacterIdSchema, slotKey: wornSlotKeySchema })
    .strict(),
  z.object({ kind: z.literal("container"), containerItemId: itemIdSchema }).strict(),
  z.object({ kind: z.literal("zone"), zoneId: zoneIdSchema }).strict(),
  z.object({ kind: z.literal("gone"), basis: itemGoneBasisSchema }).strict(),
]);
export type ItemLocus = z.infer<typeof itemLocusSchema>;
export type ItemLocusInput = z.input<typeof itemLocusSchema>;

// ---------------------------------------------------------------------------
// Containers (§26.2)
// ---------------------------------------------------------------------------

const containerAllowListSchema = createStableStringSetSchema(
  worldCharacterIdSchema,
  "Container allow-list actor IDs",
);

/**
 * Access policy is fail-closed and checked on the IMMEDIATE container at both
 * ends of a transfer: `open` admits any co-located actor, `holder_only` only the
 * actor at the container chain's root, `allow_list` only a named actor set.
 */
export const containerAccessPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }).strict(),
  z.object({ kind: z.literal("holder_only") }).strict(),
  z.object({ kind: z.literal("allow_list"), actorIds: containerAllowListSchema }).strict(),
]);
export type ContainerAccessPolicy = z.infer<typeof containerAccessPolicySchema>;

/** Capacity is a direct-occupant count in v1 (size/weight classes are headroom). */
export const itemContainerConfigSchema = z
  .object({
    capacityCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    access: containerAccessPolicySchema,
  })
  .strict();
export type ItemContainerConfig = z.infer<typeof itemContainerConfigSchema>;

// ---------------------------------------------------------------------------
// Consumption effects (§26.6) — authored per item, applied through the §25 body kernel
// ---------------------------------------------------------------------------

/** The body-source vocabulary a meal/drink/adjustment may report through (a restricted
 * subset of `bodySourceKinds` — exertion/climax couplings never fire off a consumption). */
export const itemConsumptionSourceKinds = ["meal", "drink", "adjustment"] as const;
export const itemConsumptionSourceKindSchema = z.enum(itemConsumptionSourceKinds);
export type ItemConsumptionSourceKind = z.infer<typeof itemConsumptionSourceKindSchema>;

export const itemConsumptionEffectSchema = z
  .object({
    meterKey: z.string().trim().min(1).max(64),
    sourceKind: itemConsumptionSourceKindSchema,
    operation: bodySourceOperationSchema,
  })
  .strict();
export type ItemConsumptionEffect = z.infer<typeof itemConsumptionEffectSchema>;

// ---------------------------------------------------------------------------
// Material item + projection (§26)
// ---------------------------------------------------------------------------

export const simulationMaterialItemSchema = z
  .object({
    id: itemIdSchema,
    name: z.string().trim().min(1),
    /** Authored classification key resource costs reference (slice 2). Optional. */
    materialKindKey: z.string().trim().min(1).max(64).optional(),
    /** Social ownership, distinct from holding; changed only by item_ownership_set. */
    ownerActorId: worldCharacterIdSchema.nullable().default(null),
    /** Present iff this item is itself a container (capacity + access both set). */
    container: itemContainerConfigSchema.optional(),
    /** Authored §26.6 body effects a consumption applies, in authored order. */
    consumptionEffects: z.array(itemConsumptionEffectSchema).max(4).optional(),
    /** §26.7: whether this item carries item-condition (wear/cleanliness) meters. */
    conditionTracked: z.boolean().default(false),
    locus: itemLocusSchema,
  })
  .strict();
export type SimulationMaterialItem = z.infer<typeof simulationMaterialItemSchema>;
export type SimulationMaterialItemInput = z.input<typeof simulationMaterialItemSchema>;

/** Actors keep only identity here; perception (`observedContainerIds`) is §20's job now. */
export const simulationMaterialActorSchema = z
  .object({
    id: worldCharacterIdSchema,
    name: z.string().trim().min(1),
  })
  .strict();
export type SimulationMaterialActor = z.infer<typeof simulationMaterialActorSchema>;

export const materialsProjectionSchema = z
  .object({
    worldId: worldIdSchema,
    branchId: worldBranchIdSchema,
    rulesetVersion: rulesetVersionSchema,
    version: branchVersionSchema,
    headSequence: branchHeadSequenceSchema,
    storySecond: storySecondSchema,
    actors: z.array(simulationMaterialActorSchema),
    items: z.array(simulationMaterialItemSchema),
  })
  .strict();
export type MaterialsProjection = z.infer<typeof materialsProjectionSchema>;
export type MaterialsProjectionInput = z.input<typeof materialsProjectionSchema>;

// ---------------------------------------------------------------------------
// Branch seed (replaces the Gate 1 item-transfer seed contract)
// ---------------------------------------------------------------------------

const materialWorldSeedSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value, "World seeds cannot have surrounding whitespace")
  .refine((value) => !/\s/u.test(value), "World seeds cannot contain whitespace");

/**
 * World lifecycle vocabulary. "archived" was dropped with the `sim_worlds.status`
 * column's enum (successor-world-lifecycle.plan.md slice 1, owner ruling E20-1):
 * nothing ever set it and a successor world is hard-deleted with its chat, so an
 * archived world had no way back and no UI. "paused" stays unused-but-reserved.
 */
export const materialWorldStatuses = ["active", "paused"] as const;
export const materialWorldStatusSchema = z.enum(materialWorldStatuses);

/**
 * The atomic bootstrap for one new material branch. It carries the world/branch
 * identity the old `seedDurableItemTransferBranch` options carried plus the
 * origin actors and items; version/headSequence are implicitly zero at seed.
 */
export const materialBranchSeedSchema = z
  .object({
    worldId: worldIdSchema,
    worldTypeId: worldTypeIdSchema,
    worldSeed: materialWorldSeedSchema,
    worldStatus: materialWorldStatusSchema.default("active"),
    /** Ruling 3: whether this world admits explicit forced-entry attempts. */
    permitsTrespass: z.boolean().default(false),
    branchId: worldBranchIdSchema,
    rulesetVersion: rulesetVersionSchema,
    originStorySecond: storySecondSchema,
    actors: z.array(simulationMaterialActorSchema),
    items: z.array(simulationMaterialItemSchema),
  })
  .strict();
export type MaterialBranchSeed = z.infer<typeof materialBranchSeedSchema>;
export type MaterialBranchSeedInput = z.input<typeof materialBranchSeedSchema>;

// ---------------------------------------------------------------------------
// transfer_item (v2) — §26.4 transfer law
// ---------------------------------------------------------------------------

/**
 * `fromLocus` is the caller-asserted source, re-checked against current truth
 * (`stale_source`). A `gone` destination is invalid here — destruction is the
 * `destroy_item` command's job — so it is refined out of the payload.
 */
const transferItemPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromLocus: itemLocusSchema,
    toLocus: itemLocusSchema,
  })
  .strict()
  .refine((payload) => payload.toLocus.kind !== "gone", {
    message: "A transfer destination cannot be gone; use destroy_item",
    path: ["toLocus"],
  });

export const transferItemCommandSchema = createCommandEnvelopeSchema(
  "transfer_item",
  2,
  transferItemPayloadSchema,
);

export const transferItemRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "item_not_found",
  "item_gone",
  "stale_source",
  "destination_not_found",
  "root_not_colocated",
  "held_by_other",
  "worn_by_other",
  "not_self_dressing",
  "container_access_denied",
  "item_reserved",
  "destination_full",
  "container_cycle",
  "same_locus",
] as const;
export const transferItemRejectionCodeSchema = z.enum(transferItemRejectionCodes);
export const transferItemCommandResultSchema = createCommandResultSchema(
  transferItemRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// destroy_item (v1) — §26.1 gone/terminal (consumed arrives with slice 2)
// ---------------------------------------------------------------------------

/** `consumed` arrives with slice 2's consume path — excluded here on purpose. */
export const destroyItemBases = ["destroyed", "lost"] as const;
export const destroyItemBasisSchema = z.enum(destroyItemBases);
export type DestroyItemBasis = z.infer<typeof destroyItemBasisSchema>;

const destroyItemPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    basis: destroyItemBasisSchema,
  })
  .strict();

export const destroyItemCommandSchema = createCommandEnvelopeSchema(
  "destroy_item",
  1,
  destroyItemPayloadSchema,
);

export const destroyItemRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "item_not_found",
  "item_gone",
  "root_not_colocated",
  "held_by_other",
  "worn_by_other",
  "container_access_denied",
  "item_reserved",
] as const;
export const destroyItemRejectionCodeSchema = z.enum(destroyItemRejectionCodes);
export const destroyItemCommandResultSchema = createCommandResultSchema(
  destroyItemRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// consume_item (v1) — §26.6 consumption
// ---------------------------------------------------------------------------

const consumeItemPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
  })
  .strict();

export const consumeItemCommandSchema = createCommandEnvelopeSchema(
  "consume_item",
  1,
  consumeItemPayloadSchema,
);

export const consumeItemRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "item_not_found",
  "item_gone",
  "not_consumable",
  "root_not_colocated",
  "held_by_other",
  "worn_by_other",
  "container_access_denied",
  "item_reserved",
] as const;
export const consumeItemRejectionCodeSchema = z.enum(consumeItemRejectionCodes);
export const consumeItemCommandResultSchema = createCommandResultSchema(
  consumeItemRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// set_item_ownership (v1) — §26.3 ownership is social, not physical
// ---------------------------------------------------------------------------

const setItemOwnershipPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    newOwnerActorId: worldCharacterIdSchema.nullable(),
  })
  .strict();

export const setItemOwnershipCommandSchema = createCommandEnvelopeSchema(
  "set_item_ownership",
  1,
  setItemOwnershipPayloadSchema,
);

export const setItemOwnershipRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "item_not_found",
  "item_gone",
  "actor_not_found",
  "unauthorized_principal",
] as const;
export const setItemOwnershipRejectionCodeSchema = z.enum(setItemOwnershipRejectionCodes);
export const setItemOwnershipCommandResultSchema = createCommandResultSchema(
  setItemOwnershipRejectionCodeSchema,
);

// ---------------------------------------------------------------------------
// Material event family (§9.2)
// ---------------------------------------------------------------------------

/**
 * `againstOwnership` records that the acting actor was not the item's set owner
 * (§26.3). v1 never physically blocks a transfer on ownership — consequences
 * land through the E5.5 social ledger, not through movement rejection.
 */
const itemTransferredPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromLocus: itemLocusSchema,
    toLocus: itemLocusSchema,
    againstOwnership: z.boolean(),
  })
  .strict();

export const itemTransferredEventSchema = createEventEnvelopeSchema(
  "item_transferred",
  2,
  itemTransferredPayloadSchema,
).extend({ commandId: commandIdSchema });

const itemDestroyedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    basis: destroyItemBasisSchema,
    /** The item's locus just before it went gone; reverse-derivation reads it. */
    fromLocus: itemLocusSchema,
    againstOwnership: z.boolean(),
  })
  .strict();

export const itemDestroyedEventSchema = createEventEnvelopeSchema(
  "item_destroyed",
  1,
  itemDestroyedPayloadSchema,
).extend({ commandId: commandIdSchema });

/**
 * `fromLocus` is the item's locus just before it went gone/consumed — the
 * same reverse-derivation shape `item_destroyed` uses (§29's replay reads it
 * identically). Trailing `body_source_applied` events for the item's authored
 * `consumptionEffects` are separate events in the same transaction, causation-
 * chained to this one (§26.6) — not part of this payload.
 */
const itemConsumedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    fromLocus: itemLocusSchema,
    againstOwnership: z.boolean(),
  })
  .strict();

export const itemConsumedEventSchema = createEventEnvelopeSchema(
  "item_consumed",
  1,
  itemConsumedPayloadSchema,
).extend({ commandId: commandIdSchema });

const itemOwnershipSetPayloadSchema = z
  .object({
    itemId: itemIdSchema,
    previousOwnerActorId: worldCharacterIdSchema.nullable(),
    newOwnerActorId: worldCharacterIdSchema.nullable(),
  })
  .strict();

export const itemOwnershipSetEventSchema = createEventEnvelopeSchema(
  "item_ownership_set",
  1,
  itemOwnershipSetPayloadSchema,
).extend({ commandId: commandIdSchema });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransferItemCommand = z.infer<typeof transferItemCommandSchema>;
export type TransferItemCommandInput = z.input<typeof transferItemCommandSchema>;
export type TransferItemRejectionCode = z.infer<typeof transferItemRejectionCodeSchema>;
export type TransferItemCommandResult = z.infer<typeof transferItemCommandResultSchema>;
export type DestroyItemCommand = z.infer<typeof destroyItemCommandSchema>;
export type DestroyItemCommandInput = z.input<typeof destroyItemCommandSchema>;
export type DestroyItemRejectionCode = z.infer<typeof destroyItemRejectionCodeSchema>;
export type DestroyItemCommandResult = z.infer<typeof destroyItemCommandResultSchema>;
export type ConsumeItemCommand = z.infer<typeof consumeItemCommandSchema>;
export type ConsumeItemCommandInput = z.input<typeof consumeItemCommandSchema>;
export type ConsumeItemRejectionCode = z.infer<typeof consumeItemRejectionCodeSchema>;
export type ConsumeItemCommandResult = z.infer<typeof consumeItemCommandResultSchema>;
export type SetItemOwnershipCommand = z.infer<typeof setItemOwnershipCommandSchema>;
export type SetItemOwnershipCommandInput = z.input<typeof setItemOwnershipCommandSchema>;
export type SetItemOwnershipRejectionCode = z.infer<typeof setItemOwnershipRejectionCodeSchema>;
export type SetItemOwnershipCommandResult = z.infer<typeof setItemOwnershipCommandResultSchema>;
export type ItemTransferredEvent = z.infer<typeof itemTransferredEventSchema>;
export type ItemDestroyedEvent = z.infer<typeof itemDestroyedEventSchema>;
export type ItemConsumedEvent = z.infer<typeof itemConsumedEventSchema>;
export type ItemOwnershipSetEvent = z.infer<typeof itemOwnershipSetEventSchema>;
