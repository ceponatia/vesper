import type { SimulationBranchEvent } from "../../contracts/branching";
import { householdMembershipSchema, householdRestockRoutineSchema, householdsProjectionSchema, materialLotStateSchema, meansBandStateSchema, simulationHouseholdSchema, type HouseholdMembership, type HouseholdRestockRoutine, type HouseholdsProjection, type LotLocus, type MaterialLotState, type MeansBandState, type SimulationHousehold } from "../../contracts/households";
import { compareStableText } from "../hash";
import { deriveMaterialLotRowKey, deriveMeansSubjectRowKey } from "./lots";

// ---------------------------------------------------------------------------
// Projection: canonical order, projector, replay, seed
// ---------------------------------------------------------------------------

function compareHouseholds(left: SimulationHousehold, right: SimulationHousehold): number {
  return compareStableText(left.id, right.id);
}

function compareMemberships(left: HouseholdMembership, right: HouseholdMembership): number {
  return (
    compareStableText(left.householdId, right.householdId) || compareStableText(left.actorId, right.actorId)
  );
}

function compareLots(left: MaterialLotState, right: MaterialLotState): number {
  return compareStableText(
    deriveMaterialLotRowKey(left.locus, left.materialKindKey),
    deriveMaterialLotRowKey(right.locus, right.materialKindKey),
  );
}

function compareMeansBandRows(left: MeansBandState, right: MeansBandState): number {
  return compareStableText(deriveMeansSubjectRowKey(left.subject), deriveMeansSubjectRowKey(right.subject));
}

function compareRestockRoutines(left: HouseholdRestockRoutine, right: HouseholdRestockRoutine): number {
  return (
    compareStableText(left.householdId, right.householdId) ||
    compareStableText(left.materialKindKey, right.materialKindKey)
  );
}

/** Canonical ordering shared by live assembly, replay, and hashing. */
export function sortHouseholdsProjection(projection: HouseholdsProjection): HouseholdsProjection {
  return householdsProjectionSchema.parse({
    ...projection,
    households: [...projection.households].sort(compareHouseholds),
    memberships: [...projection.memberships].sort(compareMemberships),
    lots: [...projection.lots].sort(compareLots),
    meansBands: [...projection.meansBands].sort(compareMeansBandRows),
    restockRoutines: [...projection.restockRoutines].sort(compareRestockRoutines),
  });
}

function findLotIndex(lots: readonly MaterialLotState[], locus: LotLocus, materialKindKey: string): number {
  const key = deriveMaterialLotRowKey(locus, materialKindKey);
  return lots.findIndex((lot) => deriveMaterialLotRowKey(lot.locus, lot.materialKindKey) === key);
}

/**
 * Pure synchronous projector for the household event family. It folds seven
 * event types into real state (the six slice-1 rows plus slice-2's restock
 * routine upsert) and passes every other branch event through as a bare
 * boundary advance — the exhaustive passthrough keeps TS exhaustiveness
 * holding so a new event type cannot ship without a ruling.
 */
export function applyHouseholdEvent(
  projection: HouseholdsProjection,
  event: SimulationBranchEvent,
): HouseholdsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "household_created": {
      const household = simulationHouseholdSchema.parse({
        id: event.payload.householdId,
        name: event.payload.name,
        residenceZoneIds: event.payload.residenceZoneIds,
        stockAccessPolicy: event.payload.stockAccessPolicy,
      });
      return sortHouseholdsProjection({ ...bumped, households: [...projection.households, household] });
    }
    case "household_membership_set": {
      const membership = householdMembershipSchema.parse({
        householdId: event.payload.householdId,
        actorId: event.payload.actorId,
        role: event.payload.role,
        status: event.payload.status,
        ...(event.payload.endedAtStorySecond === undefined
          ? {}
          : { endedAtStorySecond: event.payload.endedAtStorySecond }),
      });
      const existingIndex = projection.memberships.findIndex(
        (candidate) =>
          candidate.householdId === membership.householdId && candidate.actorId === membership.actorId,
      );
      const memberships =
        existingIndex === -1
          ? [...projection.memberships, membership]
          : projection.memberships.map((candidate, index) => (index === existingIndex ? membership : candidate));
      return sortHouseholdsProjection({ ...bumped, memberships });
    }
    case "material_lot_initialized": {
      if (findLotIndex(projection.lots, event.payload.locus, event.payload.materialKindKey) !== -1) {
        throw new Error("Household event replay double-initializes a material lot");
      }
      const lot = materialLotStateSchema.parse({
        locus: event.payload.locus,
        materialKindKey: event.payload.materialKindKey,
        quantityKind: event.payload.quantityKind,
        quantityRaw: 0,
        registryVersion: event.payload.registryVersion,
      });
      return sortHouseholdsProjection({ ...bumped, lots: [...projection.lots, lot] });
    }
    case "material_lot_adjusted": {
      const index = findLotIndex(projection.lots, event.payload.locus, event.payload.materialKindKey);
      const existing = index === -1 ? undefined : projection.lots[index];
      if (!existing) throw new Error("material_lot_adjusted replay references an uninitialized lot");
      const next = materialLotStateSchema.parse({ ...existing, quantityRaw: event.payload.resultingQuantityRaw });
      return sortHouseholdsProjection({
        ...bumped,
        lots: projection.lots.map((candidate, i) => (i === index ? next : candidate)),
      });
    }
    case "material_lot_transferred": {
      const fromIndex = findLotIndex(projection.lots, event.payload.fromLocus, event.payload.materialKindKey);
      const toIndex = findLotIndex(projection.lots, event.payload.toLocus, event.payload.materialKindKey);
      const fromExisting = fromIndex === -1 ? undefined : projection.lots[fromIndex];
      const toExisting = toIndex === -1 ? undefined : projection.lots[toIndex];
      if (!fromExisting || !toExisting) {
        throw new Error("material_lot_transferred replay references an uninitialized lot");
      }
      const fromNext = materialLotStateSchema.parse({
        ...fromExisting,
        quantityRaw: event.payload.resultingFromQuantityRaw,
      });
      const toNext = materialLotStateSchema.parse({
        ...toExisting,
        quantityRaw: event.payload.resultingToQuantityRaw,
      });
      return sortHouseholdsProjection({
        ...bumped,
        lots: projection.lots.map((candidate, i) =>
          i === fromIndex ? fromNext : i === toIndex ? toNext : candidate,
        ),
      });
    }
    case "means_band_set": {
      const band = meansBandStateSchema.parse({
        subject: event.payload.subject,
        bandKey: event.payload.bandKey,
        registryVersion: event.payload.registryVersion,
        setAtStorySecond: event.payload.setAtStorySecond,
      });
      const key = deriveMeansSubjectRowKey(band.subject);
      const existingIndex = projection.meansBands.findIndex(
        (candidate) => deriveMeansSubjectRowKey(candidate.subject) === key,
      );
      const meansBands =
        existingIndex === -1
          ? [...projection.meansBands, band]
          : projection.meansBands.map((candidate, index) => (index === existingIndex ? band : candidate));
      return sortHouseholdsProjection({ ...bumped, meansBands });
    }
    case "household_restock_routine_configured": {
      // `configure_restock_routine` always upserts the row wholesale — the
      // event payload IS the routine (mirrors `means_band_set` above).
      const routine = householdRestockRoutineSchema.parse({
        householdId: event.payload.householdId,
        materialKindKey: event.payload.materialKindKey,
        targetQuantityRaw: event.payload.targetQuantityRaw,
        lowWaterThresholdRaw: event.payload.lowWaterThresholdRaw,
        cadenceSeconds: event.payload.cadenceSeconds,
        funding: event.payload.funding,
        active: event.payload.active,
      });
      const existingIndex = projection.restockRoutines.findIndex(
        (candidate) =>
          candidate.householdId === routine.householdId && candidate.materialKindKey === routine.materialKindKey,
      );
      const restockRoutines =
        existingIndex === -1
          ? [...projection.restockRoutines, routine]
          : projection.restockRoutines.map((candidate, index) => (index === existingIndex ? routine : candidate));
      return sortHouseholdsProjection({ ...bumped, restockRoutines });
    }
    // A promotion mutates lots through its own causally-chained
    // `material_lot_adjusted` companion event (already folded above); the
    // promotion/restock-outcome events themselves carry no lot/routine state
    // of their own for THIS projection to fold — households.ts's job here is
    // only to advance the boundary (materials.ts folds the new item itself).
    case "item_instantiated_from_promotion":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
      return householdsProjectionSchema.parse(bumped);
    case "item_transferred":
    case "item_destroyed":
    case "item_consumed":
    case "item_ownership_set":
    case "trigger_scheduled":
    case "journey_planned":
    case "actor_departed":
    case "journey_delayed":
    case "journey_interrupted":
    case "actor_arrived":
    case "journey_abandoned":
    case "activity_started":
    case "activity_completed":
    case "activity_cancelled":
    case "activity_failed":
    case "activity_interrupted":
    case "activity_resumed":
    case "commitment_created":
    case "pressure_raised":
    case "commitment_kept":
    case "commitment_late":
    case "commitment_missed":
    case "engagement_opened":
    case "engagement_ended":
    case "engagement_interrupted":
    case "engagement_winding_down":
    case "zone_entered":
    case "storyteller_relocation":
    case "speech_act_delivered":
    case "disclosure_made":
    case "soft_canon_recorded":
    case "soft_canon_promoted":
    case "soft_canon_demoted":
    case "body_initialized":
    case "body_source_applied":
    case "body_modifier_applied":
    case "body_condition_applied":
    case "body_condition_ended":
    case "body_threshold_crossed":
    case "body_collapsed":
    case "item_condition_initialized":
    case "item_condition_source_applied":
    case "item_condition_modifier_applied":
    case "item_condition_modifier_ended":
    case "item_condition_threshold_crossed":
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "consent_escalation_resolved":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
    case "actor_materialized_from_aggregate":
      // Non-household families advance the boundary without touching this projection.
      return householdsProjectionSchema.parse(bumped);
  }
}

export interface HouseholdsReplayInput {
  /** Households are fully evented past their origin (empty) seed — no branch-seed ambiguity. */
  seed: HouseholdsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its households projection. */
export function replayHouseholdsHistory(input: HouseholdsReplayInput): HouseholdsProjection {
  const seed = sortHouseholdsProjection(householdsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Households replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyHouseholdEvent(projection, event);
    lastSequence = event.sequence;
  }
  return householdsProjectionSchema.parse({ ...projection, version: seed.version + commandIds.size });
}

/** The empty branch-origin households seed — nothing in this domain is ever branch-seeded. */
export function emptyHouseholdsSeed(branchId: string, originStorySecond: number): HouseholdsProjection {
  return householdsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    households: [],
    memberships: [],
    lots: [],
    meansBands: [],
    restockRoutines: [],
  });
}
