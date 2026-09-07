/**
 * Public household/material-lot kernel. Focused owners stay private behind
 * this stable subpath. The kernel is pure: no IO, clock, or ambient
 * randomness.
 *
 * Lot loci are flat — household XOR actor XOR zone — so root co-location is
 * a direct check rather than a container-chain walk. The materials kernel
 * stays independent; promotion events are the explicit seam between them.
 */
export { deriveMaterialLotRowKey, deriveMeansSubjectRowKey, resolveQuantityKind, initializeLot, applyLotDelta, applyLotTransfer, assertConservedDeltasBalance } from "./households/lots";
export type { LotAdjustResult, LotTransferResult } from "./households/lots";
export { householdStockAccessAllowed, lotLocusReachableFrom, deriveMeansRead } from "./households/access";
export type { HouseholdsResolutionView, MeansReadView } from "./households/access";
export type { HouseholdsBranchMeta } from "./households/shared";
export { buildMaterialLotInitializedEvent, resolveCreateHouseholdFromView, resolveSetHouseholdMembershipFromView, resolveAdjustMaterialLotFromView, resolveTransferLotQuantityFromView, resolveSetMeansBandFromView, resolvePromoteItemFromStockFromView } from "./households/commands";
export type { CreateHouseholdResolutionView, CreateHouseholdResolution, SetHouseholdMembershipResolutionView, SetHouseholdMembershipResolution, AdjustMaterialLotResolutionView, AdjustMaterialLotResolution, TransferLotQuantityResolutionView, TransferLotQuantityResolution, SetMeansBandResolutionView, SetMeansBandResolution, PromoteItemFromStockResolutionView, PromoteItemFromStockResolution } from "./households/commands";
export { householdRestockUniquenessKey, householdRestockUniquenessKeyPrefix, resolveConfigureRestockRoutineFromView, resolveRunHouseholdRestockFromView } from "./households/restock";
export type { ConfigureRestockRoutineResolutionView, ConfigureRestockRoutineResolution, RunHouseholdRestockResolutionView, RunHouseholdRestockResolution } from "./households/restock";
export { sortHouseholdsProjection, applyHouseholdEvent, replayHouseholdsHistory, emptyHouseholdsSeed } from "./households/projection";
export type { HouseholdsReplayInput } from "./households/projection";
