import { and, eq } from "drizzle-orm";
import { composeSimulationId } from "@vesper/simulation-core/contracts/identity";
import {
  itemLocusSchema,
  simulationMaterialItemSchema,
  type ContainerAccessPolicy,
  type ItemConsumptionEffect,
  type ItemGoneBasis,
  type ItemLocus,
  type SimulationMaterialItem,
} from "@vesper/simulation-core/contracts/materials";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
} from "@vesper/simulation-core/contracts/outbox";
import { simItemHoldings, simItems, simOutbox } from "@/server/db";
import type { SimTx } from "./trigger-projector";

/**
 * The §26 material ROW layer: the `sim_item_holdings` locus mapping both
 * directions, the item + holding join shape every material read hydrates
 * through, the one live locus write, and the material-feed delivery
 * obligation.
 *
 * A LEAF module: it imports no sibling store. That is what lets material-
 * store.ts, activity-store.ts and household-store.ts share one copy instead of
 * the local re-implementations activity-store.ts used to carry to dodge the
 * `material-store → body-store → activity-store` cycle.
 */

// ---------------------------------------------------------------------------
// Locus <-> row mapping
// ---------------------------------------------------------------------------

/** The flat `sim_item_holdings` column shape both directions convert against (§26.1). */
export interface ItemHoldingRowFields {
  locusKind: "held" | "worn" | "container" | "zone" | "gone";
  actorId: string | null;
  slotKey: string | null;
  containerItemId: string | null;
  zoneId: string | null;
  goneBasis: ItemGoneBasis | null;
}

/** Reconstruct a typed locus from a holdings row; the parse re-brands and validates. */
export function itemLocusFromHoldingRow(row: ItemHoldingRowFields): ItemLocus {
  switch (row.locusKind) {
    case "held":
      return itemLocusSchema.parse({ kind: "held", actorId: row.actorId });
    case "worn":
      return itemLocusSchema.parse({ kind: "worn", actorId: row.actorId, slotKey: row.slotKey });
    case "container":
      return itemLocusSchema.parse({ kind: "container", containerItemId: row.containerItemId });
    case "zone":
      return itemLocusSchema.parse({ kind: "zone", zoneId: row.zoneId });
    case "gone":
      return itemLocusSchema.parse({ kind: "gone", basis: row.goneBasis });
  }
}

/** The holdings-row column patch for one locus — shared by seed inserts, live updates, and fork materialization. */
export function holdingRowFieldsForLocus(locus: ItemLocus): ItemHoldingRowFields {
  const empty = { actorId: null, slotKey: null, containerItemId: null, zoneId: null, goneBasis: null };
  switch (locus.kind) {
    case "held":
      return { ...empty, locusKind: "held", actorId: locus.actorId };
    case "worn":
      return { ...empty, locusKind: "worn", actorId: locus.actorId, slotKey: locus.slotKey };
    case "container":
      return { ...empty, locusKind: "container", containerItemId: locus.containerItemId };
    case "zone":
      return { ...empty, locusKind: "zone", zoneId: locus.zoneId };
    case "gone":
      return { ...empty, locusKind: "gone", goneBasis: locus.basis };
  }
}

// ---------------------------------------------------------------------------
// Item + holding join — the one hydration shape every material read uses
// ---------------------------------------------------------------------------

/**
 * The select map for the `sim_items` ⋈ `sim_item_holdings` join. Callers scope
 * the WHERE (whole branch, a kind set, an explicit id set) and hydrate each
 * row through {@link materialItemFromRow}, so the projected shape can never
 * drift between the whole-branch authority view and the scoped activity-lane
 * loads.
 */
export const materialItemSelection = {
  itemId: simItems.itemId,
  name: simItems.name,
  materialKindKey: simItems.materialKindKey,
  consumptionEffects: simItems.consumptionEffects,
  ownerActorId: simItems.ownerActorId,
  containerCapacityCount: simItems.containerCapacityCount,
  containerAccess: simItems.containerAccess,
  conditionTracked: simItems.conditionTracked,
  locusKind: simItemHoldings.locusKind,
  holdingActorId: simItemHoldings.actorId,
  slotKey: simItemHoldings.slotKey,
  containerItemId: simItemHoldings.containerItemId,
  zoneId: simItemHoldings.zoneId,
  goneBasis: simItemHoldings.goneBasis,
};

export interface MaterialItemRow {
  itemId: string;
  name: string;
  materialKindKey: string | null;
  consumptionEffects: ItemConsumptionEffect[] | null;
  ownerActorId: string | null;
  containerCapacityCount: number | null;
  containerAccess: ContainerAccessPolicy | null;
  /** §26.7: whether this item carries item-condition (wear/cleanliness) meters. */
  conditionTracked: boolean;
  locusKind: "held" | "worn" | "container" | "zone" | "gone";
  holdingActorId: string | null;
  slotKey: string | null;
  containerItemId: string | null;
  zoneId: string | null;
  goneBasis: ItemGoneBasis | null;
}

export function materialItemFromRow(row: MaterialItemRow): SimulationMaterialItem {
  const locus = itemLocusFromHoldingRow({
    locusKind: row.locusKind,
    actorId: row.holdingActorId,
    slotKey: row.slotKey,
    containerItemId: row.containerItemId,
    zoneId: row.zoneId,
    goneBasis: row.goneBasis,
  });
  return simulationMaterialItemSchema.parse({
    id: row.itemId,
    name: row.name,
    ...(row.materialKindKey !== null ? { materialKindKey: row.materialKindKey } : {}),
    ...(row.consumptionEffects ? { consumptionEffects: row.consumptionEffects } : {}),
    ownerActorId: row.ownerActorId,
    ...(row.containerCapacityCount !== null && row.containerAccess !== null
      ? { container: { capacityCount: row.containerCapacityCount, access: row.containerAccess } }
      : {}),
    conditionTracked: row.conditionTracked,
    locus,
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Exported for the E6.2 routine controller's `eat_meal` consumption train. */
export async function updateItemLocus(
  tx: SimTx,
  branchId: string,
  itemId: string,
  locus: ItemLocus,
  updatedSequence: number,
): Promise<void> {
  const updated = await tx
    .update(simItemHoldings)
    .set({ ...holdingRowFieldsForLocus(locus), updatedSequence })
    .where(and(eq(simItemHoldings.branchId, branchId), eq(simItemHoldings.itemId, itemId)))
    .returning({ itemId: simItemHoldings.itemId });
  if (updated.length !== 1) throw new Error("Locked item holding changed before its locus update");
}

/**
 * Insert one material feed delivery obligation — the one place that row shape
 * is built. Both the §26.4 transfer/destroy/consume paths (material-store.ts)
 * and the §26.5 completion-time consume disposition (activity-store.ts)
 * publish the same obligation for each movement event they emit.
 */
export async function publishMaterialFeedObligation(
  tx: SimTx,
  event: { id: string; worldId: string; branchId: string; sequence: number },
): Promise<void> {
  await tx.insert(simOutbox).values({
    id: composeSimulationId("outbox", [itemTransferFeedConsumerKind, event.id]),
    worldId: event.worldId,
    branchId: event.branchId,
    sourceEventId: event.id,
    firstSequence: event.sequence,
    lastSequence: event.sequence,
    consumerKind: itemTransferFeedConsumerKind,
    schemaVersion: itemTransferFeedProjectionSchemaVersion,
    payload: { sourceEventId: event.id },
  });
}
