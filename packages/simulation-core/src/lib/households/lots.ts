import { composeSimulationId } from "../../contracts/identity";
import { materialKindRegistryV1, materialKindRegistryVersion, materialLotStateSchema, type LotLocus, type MaterialKindDefinition, type MaterialLotState, type MaterialQuantityKind, type MeansSubject } from "../../contracts/households";

// ---------------------------------------------------------------------------
// Persistence-layer row keys (NEVER appear in a contracts schema or an event
// payload — lots/means-bands are addressed by (locus, materialKindKey) /
// subject everywhere in contracts/events; see schema.ts's migration note).
// ---------------------------------------------------------------------------

export function deriveMaterialLotRowKey(locus: LotLocus, materialKindKey: string): string {
  const locusTag =
    locus.kind === "household"
      ? ["household", locus.householdId]
      : locus.kind === "actor"
        ? ["actor", locus.actorId]
        : ["zone", locus.zoneId];
  return composeSimulationId("material-lot", [...locusTag, materialKindKey]);
}
export function deriveMeansSubjectRowKey(subject: MeansSubject): string {
  switch (subject.kind) {
    case "actor":
      return composeSimulationId("means-subject", ["actor", subject.actorId]);
    case "household":
      return composeSimulationId("means-subject", ["household", subject.householdId]);
    case "cohort":
      return composeSimulationId("means-subject", ["cohort", subject.cohortId]);
  }
}

// ---------------------------------------------------------------------------
// Lot arithmetic (pure, no IO)
// ---------------------------------------------------------------------------

/** Registered key -> its declared kind; unregistered keys default to `count`. */
export function resolveQuantityKind(
  materialKindKey: string,
  registry: readonly MaterialKindDefinition[] = materialKindRegistryV1,
): MaterialQuantityKind {
  return registry.find((definition) => definition.key === materialKindKey)?.quantityKind ?? "count";
}

export function initializeLot(locus: LotLocus, materialKindKey: string): MaterialLotState {
  return materialLotStateSchema.parse({
    locus,
    materialKindKey,
    quantityKind: resolveQuantityKind(materialKindKey),
    quantityRaw: 0,
    registryVersion: materialKindRegistryVersion,
  });
}

/**
 * A discriminated-union TYPE ALIAS (not the invalid `interface X {…} | {…}`
 * shape) — matches how `materials.ts`'s resolvers type their results.
 */
export type LotAdjustResult =
  | { ok: true; resultingQuantityRaw: number }
  | { ok: false; code: "insufficient_balance" };

/** Clamp-reject below zero; accept exact zero. No upper clamp beyond the safe-integer range. */
export function applyLotDelta(lot: MaterialLotState, deltaRaw: number): LotAdjustResult {
  const resultingQuantityRaw = lot.quantityRaw + deltaRaw;
  if (resultingQuantityRaw < 0) return { ok: false, code: "insufficient_balance" };
  if (!Number.isSafeInteger(resultingQuantityRaw)) {
    throw new Error("Material lot adjustment produced an unsafe integer quantity");
  }
  return { ok: true, resultingQuantityRaw };
}

export type LotTransferResult =
  | { ok: true; from: MaterialLotState; to: MaterialLotState }
  | { ok: false; code: "insufficient_balance" };

/** Same-kind, both loci already resolved to lots; pure arithmetic only — no IO. */
export function applyLotTransfer(
  from: MaterialLotState,
  to: MaterialLotState,
  quantityRaw: number,
): LotTransferResult {
  if (from.quantityRaw < quantityRaw) return { ok: false, code: "insufficient_balance" };
  const nextFromQuantityRaw = from.quantityRaw - quantityRaw;
  const nextToQuantityRaw = to.quantityRaw + quantityRaw;
  if (!Number.isSafeInteger(nextToQuantityRaw)) {
    throw new Error("Material lot transfer produced an unsafe integer quantity");
  }
  return {
    ok: true,
    from: materialLotStateSchema.parse({ ...from, quantityRaw: nextFromQuantityRaw }),
    to: materialLotStateSchema.parse({ ...to, quantityRaw: nextToQuantityRaw }),
  };
}


// ---------------------------------------------------------------------------
// Conservation checker (property-test support, not runtime-called by a
// command path — runtime conservation is structural).
// ---------------------------------------------------------------------------

/**
 * For a set of same-transaction lot deltas that CLAIM to be conserved (every
 * `material_lot_transferred`, decomposed into its two same-kind deltas),
 * assert same-`materialKindKey` deltas sum to zero. Used by property tests,
 * not by any store command.
 */
export function assertConservedDeltasBalance(
  deltas: readonly { materialKindKey: string; deltaRaw: number }[],
): void {
  const totals = new Map<string, number>();
  for (const delta of deltas) {
    totals.set(delta.materialKindKey, (totals.get(delta.materialKindKey) ?? 0) + delta.deltaRaw);
  }
  for (const [materialKindKey, total] of totals) {
    if (total !== 0) {
      throw new Error(`Conservation violated for material kind "${materialKindKey}": net delta ${total}`);
    }
  }
}
