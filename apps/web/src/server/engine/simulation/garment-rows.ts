import { and, eq, inArray } from "drizzle-orm";
import {
  diag,
  emptyGarmentPresentationState,
  garmentConditionStateSchema,
  garmentPresentationStateSchema,
  pristineGarmentConditionState,
  type DiagnosticSink,
  type GarmentConditionState,
  type GarmentPresentationState,
} from "@/contracts";
import { parseOrNull } from "@/lib/parse";
import { simItemGarmentState } from "@/server/db";
import type { SimTx } from "./trigger-projector";

/** Diagnostic code for a garment-state row that would not parse. Stable: consumers and tests key on it. */
export const SIM_GARMENT_STATE_UNREADABLE = "sim_garment.state_unreadable";

/**
 * The garment-state ROW layer over `sim_item_garment_state`: the two JSONB
 * columns parsed both directions, and the one upsert the projector writes
 * through.
 *
 * A LEAF module, on `item-condition-store.ts`'s discipline: it imports no
 * sibling store, so the read adapter and (later) the command lane share one
 * copy of the row shape rather than each re-deriving it.
 *
 * The law this file exists to hold: an ABSENT row is the neutral presentation
 * plus the pristine condition — a garment nobody has touched — and an
 * UNREADABLE row degrades to the same values with a diagnostic. Neither is an
 * error, because neither is evidence about the garment; the read adapter is
 * what decides whether the resulting coverage can be trusted.
 */

/** One item's presentation + condition, as the read side consumes them. */
export interface ItemGarmentStateRow {
  itemId: string;
  presentation: GarmentPresentationState;
  condition: GarmentConditionState;
  updatedSequence: number;
  /** False when a stored column would not parse and the neutral default stood in. */
  readable: boolean;
}

/** The state an item with no row has: nothing displaced, nothing worn in. */
export function neutralItemGarmentState(itemId: string): ItemGarmentStateRow {
  return {
    itemId,
    presentation: emptyGarmentPresentationState(),
    condition: pristineGarmentConditionState(),
    updatedSequence: 0,
    readable: true,
  };
}

/**
 * Batch-load garment state for a set of items. An item absent from the returned
 * map has no row — the caller uses {@link neutralItemGarmentState} rather than
 * treating the absence as a failure.
 *
 * Both columns are parsed independently with `parseOrNull`, so one unreadable
 * channel cannot blank the other: a corrupt presentation blob still leaves the
 * garment's condition gradient intact and vice versa. Neither ever throws
 * (docs/resilience.md) — the row is reported `readable: false` and the caller
 * turns that into a diagnostic.
 */
export async function loadItemGarmentStateRows(
  tx: SimTx,
  branchId: string,
  itemIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<Map<string, ItemGarmentStateRow>> {
  const rows = new Map<string, ItemGarmentStateRow>();
  if (itemIds.length === 0) return rows;
  const selected = await tx
    .select()
    .from(simItemGarmentState)
    .where(
      and(eq(simItemGarmentState.branchId, branchId), inArray(simItemGarmentState.itemId, [...itemIds])),
    );
  for (const row of selected) {
    const presentation = parseOrNull(
      garmentPresentationStateSchema,
      row.presentation,
      sink,
      "sim_item_garment_state.presentation",
    );
    const condition = parseOrNull(
      garmentConditionStateSchema,
      row.condition,
      sink,
      "sim_item_garment_state.condition",
    );
    if (presentation === null || condition === null) {
      sink?.push(
        diag(
          "warn",
          SIM_GARMENT_STATE_UNREADABLE,
          `garment state for item ${row.itemId} would not parse — read as neutral presentation and pristine condition`,
          { path: "sim_garment.state", context: { itemId: row.itemId } },
        ),
      );
    }
    rows.set(row.itemId, {
      itemId: row.itemId,
      presentation: presentation ?? emptyGarmentPresentationState(),
      condition: condition ?? pristineGarmentConditionState(),
      updatedSequence: row.updatedSequence,
      readable: presentation !== null && condition !== null,
    });
  }
  return rows;
}

/**
 * What the two JSONB columns accept on the way IN.
 *
 * Deliberately the opaque object rather than the parsed application shape,
 * which satisfies it anyway. The other writer is the fork rebuild
 * (`branch-store.ts`), which carries the value out of the package's replay fold
 * as the opaque object a `garment_operation_applied` event recorded — and
 * re-parsing that back through the application schemas on the way in is exactly
 * the transformation that could make a child's row differ from the parent row
 * it is supposed to reproduce. Reads still come back parsed
 * ({@link loadItemGarmentStateRows}); it is only the write that is opaque,
 * which is what the column itself is.
 */
export type ItemGarmentStateColumn = Record<string, unknown>;

/**
 * Upsert one item's garment state — the single write path into this table.
 *
 * Idempotent on `(branch_id, item_id)` so a projector replaying the same event
 * lands the same row. The caller supplies the event boundary as
 * `updatedSequence`; the row carries no history of its own, exactly like
 * `sim_item_holdings`, because the event log is the history.
 */
export async function upsertItemGarmentStateRow(
  tx: SimTx,
  branchId: string,
  itemId: string,
  presentation: ItemGarmentStateColumn,
  condition: ItemGarmentStateColumn,
  updatedSequence: number,
): Promise<void> {
  await tx
    .insert(simItemGarmentState)
    .values({ branchId, itemId, presentation, condition, updatedSequence })
    .onConflictDoUpdate({
      target: [simItemGarmentState.branchId, simItemGarmentState.itemId],
      set: { presentation, condition, updatedSequence, updatedAt: new Date() },
    });
}
