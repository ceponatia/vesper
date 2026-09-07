import { composeSimulationId } from "../../contracts/identity";
import { RESERVED_CURRENCY_MATERIAL_KIND, householdCreatedEventSchema, householdMembershipSetEventSchema, itemInstantiatedFromPromotionEventSchema, materialKindRegistryVersion, materialLotAdjustedEventSchema, materialLotInitializedEventSchema, materialLotStateSchema, materialLotTransferredEventSchema, meansBandRegistryVersion, meansBandSetEventSchema, type AdjustMaterialLotCommand, type AdjustMaterialLotRejectionCode, type CreateHouseholdCommand, type CreateHouseholdRejectionCode, type HouseholdCreatedEvent, type HouseholdMembership, type HouseholdMembershipSetEvent, type ItemInstantiatedFromPromotionEvent, type LotLocus, type MaterialKindRegistryVersion, type MaterialLotAdjustedEvent, type MaterialLotInitializedEvent, type MaterialLotState, type MaterialLotTransferredEvent, type MaterialQuantityKind, type MeansBandSetEvent, type MeansBandState, type PromoteItemFromStockCommand, type PromoteItemFromStockRejectionCode, type PromotionSampledDetail, type SetHouseholdMembershipCommand, type SetHouseholdMembershipRejectionCode, type SetMeansBandCommand, type SetMeansBandRejectionCode, type TransferLotQuantityCommand, type TransferLotQuantityRejectionCode } from "../../contracts/households";
import { deterministicDrawUnit } from "../../contracts/scheduler";
import { sortedUnique } from "../hash";
import { applyLotDelta, applyLotTransfer } from "./lots";
import { checkLotLocusAccess, type HouseholdsResolutionView } from "./access";
import { eventEnvelope, isPrivilegedPrincipal, lotLociEqual, lotLocusEntityIds, rejection, type HouseholdEventCommandContext, type HouseholdRejection, type HouseholdsBranchMeta } from "./shared";

/**
 * Lazy init (mirrors `buildItemConditionInitializedEvent`): the store calls
 * this the first time a lot's row is touched, before persisting it.
 */
export function buildMaterialLotInitializedEvent(input: {
  view: HouseholdsBranchMeta;
  command: HouseholdEventCommandContext;
  locus: LotLocus;
  materialKindKey: string;
  quantityKind: MaterialQuantityKind;
  sequence: number;
  registryVersion?: MaterialKindRegistryVersion;
}): MaterialLotInitializedEvent {
  const registryVersion = input.registryVersion ?? materialKindRegistryVersion;
  return materialLotInitializedEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, "material-lot-initialized"),
    type: "material_lot_initialized",
    actorIds: [],
    entityIds: sortedUnique(lotLocusEntityIds(input.locus)),
    payload: {
      locus: input.locus,
      materialKindKey: input.materialKindKey,
      quantityKind: input.quantityKind,
      registryVersion,
    },
  });
}

// ---------------------------------------------------------------------------
// create_household
// ---------------------------------------------------------------------------

export interface CreateHouseholdResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
  zoneExists(zoneId: string): boolean;
}

export type CreateHouseholdResolution =
  | HouseholdRejection<CreateHouseholdRejectionCode>
  | { ok: true; event: HouseholdCreatedEvent };

export function resolveCreateHouseholdFromView(
  view: CreateHouseholdResolutionView,
  command: CreateHouseholdCommand,
): CreateHouseholdResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can found a household.");
  }
  if (view.householdExists) {
    return rejection("household_already_exists", "That household already exists.");
  }
  for (const zoneId of command.payload.residenceZoneIds) {
    if (!view.zoneExists(zoneId)) {
      return rejection("zone_not_found", "That residence zone is unavailable.");
    }
  }

  const event = householdCreatedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-created"),
    type: "household_created",
    actorIds: [],
    entityIds: sortedUnique([command.payload.householdId]),
    payload: {
      householdId: command.payload.householdId,
      name: command.payload.name,
      residenceZoneIds: command.payload.residenceZoneIds,
      stockAccessPolicy: command.payload.stockAccessPolicy,
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// set_household_membership
// ---------------------------------------------------------------------------

export interface SetHouseholdMembershipResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
  actorExists: boolean;
  /** Undefined means no membership row exists yet for this (householdId, actorId) pair. */
  currentMembership?: HouseholdMembership;
}

export type SetHouseholdMembershipResolution =
  | HouseholdRejection<SetHouseholdMembershipRejectionCode>
  | { ok: true; event: HouseholdMembershipSetEvent };

export function resolveSetHouseholdMembershipFromView(
  view: SetHouseholdMembershipResolutionView,
  command: SetHouseholdMembershipCommand,
): SetHouseholdMembershipResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can change household membership.");
  }
  if (!view.householdExists) return rejection("household_not_found", "That household is unavailable.");
  if (!view.actorExists) return rejection("actor_not_found", "That actor is unavailable.");

  const current = view.currentMembership;
  if (
    current &&
    current.role === command.payload.role &&
    current.status === command.payload.status &&
    current.endedAtStorySecond === command.payload.endedAtStorySecond
  ) {
    return rejection("no_op", "That membership is already set that way.");
  }

  const event = householdMembershipSetEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-membership-set"),
    type: "household_membership_set",
    actorIds: [command.payload.actorId],
    entityIds: sortedUnique([command.payload.householdId, command.payload.actorId]),
    payload: {
      householdId: command.payload.householdId,
      actorId: command.payload.actorId,
      role: command.payload.role,
      status: command.payload.status,
      ...(command.payload.endedAtStorySecond === undefined
        ? {}
        : { endedAtStorySecond: command.payload.endedAtStorySecond }),
    },
  });
  return { ok: true, event };
}

// ---------------------------------------------------------------------------
// adjust_material_lot — privileged authoring, exempt from co-location
// ---------------------------------------------------------------------------

export interface AdjustMaterialLotResolutionView extends HouseholdsBranchMeta {
  /** Whether the locus's referenced household/actor/zone exists. */
  localeExists: boolean;
  /** The lot's current state — the store has already lazily initialized it. */
  lot: MaterialLotState;
}

export type AdjustMaterialLotResolution =
  | HouseholdRejection<AdjustMaterialLotRejectionCode>
  | { ok: true; event: MaterialLotAdjustedEvent; nextLot: MaterialLotState };

export function resolveAdjustMaterialLotFromView(
  view: AdjustMaterialLotResolutionView,
  command: AdjustMaterialLotCommand,
): AdjustMaterialLotResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can author a stock adjustment.");
  }
  if (command.payload.deltaRaw === 0) {
    return rejection("non_zero_delta_required", "That adjustment has no effect.");
  }
  if (!view.localeExists) return rejection("locus_not_found", "That stock's location is unavailable.");

  const delta = applyLotDelta(view.lot, command.payload.deltaRaw);
  if (!delta.ok) return rejection("insufficient_balance", "That stock cannot go below zero.");

  const event = materialLotAdjustedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-adjusted"),
    type: "material_lot_adjusted",
    actorIds: [],
    entityIds: sortedUnique(lotLocusEntityIds(command.payload.locus)),
    payload: {
      locus: command.payload.locus,
      materialKindKey: command.payload.materialKindKey,
      deltaRaw: command.payload.deltaRaw,
      resultingQuantityRaw: delta.resultingQuantityRaw,
      quantityKind: view.lot.quantityKind,
      reason: "authoring",
    },
  });
  return {
    ok: true,
    event,
    nextLot: materialLotStateSchema.parse({ ...view.lot, quantityRaw: delta.resultingQuantityRaw }),
  };
}

// ---------------------------------------------------------------------------
// transfer_lot_quantity — same-kind conserved movement between lots
// ---------------------------------------------------------------------------

export interface TransferLotQuantityResolutionView extends HouseholdsResolutionView, HouseholdsBranchMeta {
  actorById(actorId: string): { id: string; name: string } | undefined;
  /** Both lots' current state — the store has already lazily initialized whichever were untouched. */
  fromLot: MaterialLotState;
  toLot: MaterialLotState;
}

export type TransferLotQuantityResolution =
  | HouseholdRejection<TransferLotQuantityRejectionCode>
  | {
      ok: true;
      event: MaterialLotTransferredEvent;
      nextFromLot: MaterialLotState;
      nextToLot: MaterialLotState;
    };

/** Pure resolver, mirroring `resolveTransferItemFromView`'s numbered validation order. */
export function resolveTransferLotQuantityFromView(
  view: TransferLotQuantityResolutionView,
  command: TransferLotQuantityCommand,
): TransferLotQuantityResolution {
  const { actorId, fromLocus, toLocus, materialKindKey, quantityRaw } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. actor existence + control (storyteller bypasses controlledActorIds)
  if (!view.actorById(actorId)) return rejection("actor_not_found", "That actor is unavailable.");
  const isStoryteller = command.principal.kind === "storyteller";
  if (!isStoryteller && !command.principal.controlledActorIds.includes(actorId)) {
    return rejection("unauthorized_actor", "You cannot direct that actor.");
  }
  // 3. actor embodied at a zone
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return rejection("actor_not_embodied", "They are not anywhere they can do that.");
  // 4. positive quantity
  if (quantityRaw <= 0) return rejection("non_positive_quantity", "That amount must be positive.");
  // 5. no-op rejection
  if (lotLociEqual(fromLocus, toLocus)) return rejection("same_locus", "That stock is already there.");
  // 6. access at both ends
  const fromCheck = checkLotLocusAccess(view, fromLocus, actorId, actorZoneId);
  if (!fromCheck.ok) {
    return rejection(
      fromCheck.code,
      fromCheck.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That stock is not within reach.",
    );
  }
  const toCheck = checkLotLocusAccess(view, toLocus, actorId, actorZoneId);
  if (!toCheck.ok) {
    return rejection(
      toCheck.code,
      toCheck.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That destination is not within reach.",
    );
  }
  // 7. sufficient balance
  const transfer = applyLotTransfer(view.fromLot, view.toLot, quantityRaw);
  if (!transfer.ok) return rejection("insufficient_balance", "There is not enough there to move.");

  const event = materialLotTransferredEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-transferred"),
    type: "material_lot_transferred",
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, ...lotLocusEntityIds(fromLocus), ...lotLocusEntityIds(toLocus)]),
    payload: {
      actorId,
      fromLocus,
      toLocus,
      materialKindKey,
      quantityRaw,
      resultingFromQuantityRaw: transfer.from.quantityRaw,
      resultingToQuantityRaw: transfer.to.quantityRaw,
    },
  });
  return { ok: true, event, nextFromLot: transfer.from, nextToLot: transfer.to };
}

// ---------------------------------------------------------------------------
// set_means_band
// ---------------------------------------------------------------------------

export interface SetMeansBandResolutionView extends HouseholdsBranchMeta {
  subjectExists: boolean;
  currentBand?: MeansBandState;
}

export type SetMeansBandResolution =
  | HouseholdRejection<SetMeansBandRejectionCode>
  | { ok: true; event: MeansBandSetEvent };

export function resolveSetMeansBandFromView(
  view: SetMeansBandResolutionView,
  command: SetMeansBandCommand,
): SetMeansBandResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can set a means band.");
  }
  if (!view.subjectExists) return rejection("subject_not_found", "That subject is unavailable.");
  if (view.currentBand?.bandKey === command.payload.bandKey) {
    return rejection("no_op", "That means band is already set.");
  }

  const subject = command.payload.subject;
  const subjectEntityIds: readonly string[] =
    subject.kind === "actor"
      ? [subject.actorId]
      : subject.kind === "household"
        ? [subject.householdId]
        : [subject.cohortId];
  const event = meansBandSetEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "means-band-set"),
    type: "means_band_set",
    actorIds: command.payload.subject.kind === "actor" ? [command.payload.subject.actorId] : [],
    entityIds: sortedUnique(subjectEntityIds),
    payload: {
      subject: command.payload.subject,
      bandKey: command.payload.bandKey,
      registryVersion: meansBandRegistryVersion,
      setAtStorySecond: view.storySecond,
    },
  });
  return { ok: true, event };
}


// ---------------------------------------------------------------------------
// promote_item_from_stock — the only path an aggregate fact
// becomes an explicit `sim_items` row
// ---------------------------------------------------------------------------

export interface PromoteItemFromStockResolutionView extends HouseholdsResolutionView, HouseholdsBranchMeta {
  actorById(actorId: string): { id: string; name: string } | undefined;
  /** The funding lot's current state — the store has already lazily initialized it. */
  fundingLot: MaterialLotState;
  /**
   * Authored per-`materialKindKey` display-name pool; an empty array means no
   * pool. No pool is authored yet anywhere in the codebase as of E5.4 slice 2 —
   * the store's implementation returns `[]` unconditionally today, so a caller
   * that omits `item.name` MUST supply it explicitly until a pool registry
   * exists (a future data edit, per the registry-as-data convention — no schema
   * change).
   */
  namePool(materialKindKey: string): readonly string[];
  worldSeed: string;
}

export type PromoteItemFromStockResolution =
  | HouseholdRejection<PromoteItemFromStockRejectionCode>
  | {
      ok: true;
      lotAdjustedEvent: MaterialLotAdjustedEvent;
      itemEvent: ItemInstantiatedFromPromotionEvent;
      nextFundingLot: MaterialLotState;
    };

/** Pure resolver, mirroring `resolveTransferLotQuantityFromView`'s numbered validation order. */
export function resolvePromoteItemFromStockFromView(
  view: PromoteItemFromStockResolutionView,
  command: PromoteItemFromStockCommand,
): PromoteItemFromStockResolution {
  const { actorId, funding, item } = command.payload;

  // 1. branch
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  // 2. actor existence + control (storyteller bypasses controlledActorIds)
  if (!view.actorById(actorId)) return rejection("actor_not_found", "That actor is unavailable.");
  const isStoryteller = command.principal.kind === "storyteller";
  if (!isStoryteller && !command.principal.controlledActorIds.includes(actorId)) {
    return rejection("unauthorized_actor", "You cannot direct that actor.");
  }
  // 3. actor embodied at a zone
  const actorZoneId = view.actorZoneId(actorId);
  if (actorZoneId === null) return rejection("actor_not_embodied", "They are not anywhere they can do that.");

  // 4. access on the funding locus only (an actor-locus source needs no
  // co-location check for its own holder — `checkLotLocusAccess` already
  // encodes that).
  const fundingLocus = funding.kind === "stock" ? funding.sourceLocus : funding.currencyLocus;
  const access = checkLotLocusAccess(view, fundingLocus, actorId, actorZoneId);
  if (!access.ok) {
    return rejection(
      access.code,
      access.code === "household_access_denied"
        ? "That household's stores are closed to them."
        : "That stock is not within reach.",
    );
  }

  // 5. funding kind well-formedness. `stock` draws N whole units of the SAME
  // materialKindKey the item declares — an item with no declared kind has no
  // stock lot to identify. `purchase` always debits the reserved currency
  // kind, so it is well-formed by construction.
  let sourceMaterialKindKey: string;
  let cost: number;
  if (funding.kind === "stock") {
    if (item.materialKindKey === undefined) {
      return rejection("invalid_funding_kind", "That item has no stock kind to draw from.");
    }
    sourceMaterialKindKey = item.materialKindKey;
    cost = funding.quantityRaw;
  } else {
    sourceMaterialKindKey = RESERVED_CURRENCY_MATERIAL_KIND;
    cost = funding.unitPriceRaw * funding.quantityRaw;
  }

  // 6. sufficient funding balance
  const delta = applyLotDelta(view.fundingLot, -cost);
  if (!delta.ok) return rejection("insufficient_balance", "There is not enough there to cover that.");

  // Sample any detail the command did not supply — the stream identity and
  // drawn result are captured on the event so replay never resamples.
  let sampledName: string | undefined;
  let sampledDetail: PromotionSampledDetail | undefined;
  if (item.name === undefined) {
    const stream = composeSimulationId("promotion-detail", [command.id, "item-name"]);
    const pool = item.materialKindKey === undefined ? [] : view.namePool(item.materialKindKey);
    const draw = deterministicDrawUnit({
      worldSeed: view.worldSeed,
      branchId: view.branchId,
      stream,
      drawIndex: 0,
    });
    sampledName = pool.length > 0 ? pool[Math.floor(draw * pool.length)] : undefined;
    sampledDetail = {
      stream,
      drawIndex: 0,
      ...(sampledName === undefined ? {} : { sampledName }),
      registryVersion: materialKindRegistryVersion,
    };
  }
  // Invariant 3.2.4 / step 5: the caller, never the narrator, supplies any
  // narratively-established name. An unauthored pool plus an omitted name is a
  // foreseeable runtime state (no pool is authored anywhere yet), so it is a
  // structured rejection rather than a thrown exception — resilience.md:
  // diagnostics over exceptions, degraded defaults over failed turns.
  const finalName = item.name ?? sampledName;
  if (finalName === undefined) {
    return rejection("name_required", "That item needs a name — none was given and none could be sampled.");
  }

  const lotAdjustedEvent = materialLotAdjustedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "material-lot-adjusted"),
    type: "material_lot_adjusted",
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, ...lotLocusEntityIds(fundingLocus)]),
    payload: {
      locus: fundingLocus,
      materialKindKey: sourceMaterialKindKey,
      deltaRaw: -cost,
      resultingQuantityRaw: delta.resultingQuantityRaw,
      quantityKind: view.fundingLot.quantityKind,
      reason: "promotion_cost",
    },
  });

  // A one-level derivation from already-bounded ids (branchId + commandId +
  // one literal) — no hash compaction needed (the E3.5 lesson applies only to
  // chained/growing derivations, e.g. `deriveBodyConditionId`).
  const itemId = composeSimulationId("item", [view.branchId, command.id, "promoted"]);
  const itemEvent = itemInstantiatedFromPromotionEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 2, "item-instantiated-from-promotion"),
    type: "item_instantiated_from_promotion",
    causationId: lotAdjustedEvent.id,
    actorIds: [actorId],
    entityIds: sortedUnique([actorId, itemId, ...lotLocusEntityIds(fundingLocus)]),
    payload: {
      item: {
        id: itemId,
        name: finalName,
        ...(item.materialKindKey === undefined ? {} : { materialKindKey: item.materialKindKey }),
        ownerActorId: item.ownerActorId,
        ...(item.container === undefined ? {} : { container: item.container }),
        ...(item.consumptionEffects === undefined ? {} : { consumptionEffects: item.consumptionEffects }),
        conditionTracked: item.conditionTracked,
        locus: { kind: "held", actorId },
      },
      sourceLocus: fundingLocus,
      sourceMaterialKindKey,
      ...(sampledDetail === undefined ? {} : { sampledDetail }),
    },
  });

  return {
    ok: true,
    lotAdjustedEvent,
    itemEvent,
    nextFundingLot: materialLotStateSchema.parse({ ...view.fundingLot, quantityRaw: delta.resultingQuantityRaw }),
  };
}
