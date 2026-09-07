import type { HouseholdMembership, LotLocus, MaterialLotState, MeansBandState, MeansRead, MeansSubject, SimulationHousehold } from "../../contracts/households";

// ---------------------------------------------------------------------------
// Root/co-location resolution (flat, no chain walk)
// ---------------------------------------------------------------------------

export interface HouseholdsResolutionView {
  householdById(householdId: string): SimulationHousehold | undefined;
  activeMembership(householdId: string, actorId: string): HouseholdMembership | undefined;
  /** The actor's current zone (its physical locus), or null if not embodied. */
  actorZoneId(actorId: string): string | null;
}

/** Fail-closed stock access. */
export function householdStockAccessAllowed(
  view: HouseholdsResolutionView,
  householdId: string,
  actorId: string,
): boolean {
  const household = view.householdById(householdId);
  if (!household) return false;
  switch (household.stockAccessPolicy.kind) {
    case "members_only": {
      const membership = view.activeMembership(householdId, actorId);
      return membership !== undefined && membership.status === "active";
    }
    case "allow_list":
      return household.stockAccessPolicy.actorIds.includes(actorId as never);
  }
}

/**
 * The lot locus's root zone(s) — a household locus roots at ANY of its
 * residence zones, so an acting actor at any one of them satisfies
 * co-location; an actor locus is always reachable (carried with its holder —
 * reachability there is checked as person-sovereignty, not zone, by the
 * caller).
 */
export function lotLocusReachableFrom(
  view: HouseholdsResolutionView,
  locus: LotLocus,
  actorZoneId: string,
): boolean {
  switch (locus.kind) {
    case "zone":
      return locus.zoneId === actorZoneId;
    case "household": {
      const household = view.householdById(locus.householdId);
      return household !== undefined && household.residenceZoneIds.includes(actorZoneId as never);
    }
    case "actor":
      return true;
  }
}

// ---------------------------------------------------------------------------
// Means read (mirrors `deriveEnergyRead`'s total/pure/contextual shape)
// ---------------------------------------------------------------------------

export interface MeansReadView {
  currencyLot(subject: MeansSubject): MaterialLotState | undefined;
  band(subject: MeansSubject): MeansBandState | undefined;
}

/** Precedence is structural: the lot wins whenever it exists. */
export function deriveMeansRead(subject: MeansSubject, view: MeansReadView): MeansRead {
  const lot = view.currencyLot(subject);
  if (lot) return { kind: "lot_tracked", quantityRaw: lot.quantityRaw, quantityKind: lot.quantityKind };
  const band = view.band(subject);
  if (band) return { kind: "band_tracked", bandKey: band.bandKey };
  return { kind: "unknown" };
}


export type LotLocusAccessCode = "root_not_colocated" | "household_access_denied";

/**
 * The three-step access check applied to ONE lot locus end of a transfer:
 * a zone locus needs exact co-location; a household locus needs residence
 * co-location THEN the stock access policy; an actor locus is reachable
 * unconditionally for its own holder, or requires the OTHER actor to be
 * co-located (mirrors `item_transferred`'s "giving" allowance).
 */
export function checkLotLocusAccess(
  view: HouseholdsResolutionView,
  locus: LotLocus,
  actingActorId: string,
  actorZoneId: string,
): { ok: true } | { ok: false; code: LotLocusAccessCode } {
  switch (locus.kind) {
    case "zone":
      return lotLocusReachableFrom(view, locus, actorZoneId)
        ? { ok: true }
        : { ok: false, code: "root_not_colocated" };
    case "household": {
      if (!lotLocusReachableFrom(view, locus, actorZoneId)) {
        return { ok: false, code: "root_not_colocated" };
      }
      return householdStockAccessAllowed(view, locus.householdId, actingActorId)
        ? { ok: true }
        : { ok: false, code: "household_access_denied" };
    }
    case "actor": {
      if (locus.actorId === actingActorId) return { ok: true };
      return view.actorZoneId(locus.actorId) === actorZoneId
        ? { ok: true }
        : { ok: false, code: "root_not_colocated" };
    }
  }
}
