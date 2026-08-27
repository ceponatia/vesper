import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  itemConditionMeterStateSchema,
  itemConditionModifierSchema,
  itemConditionRegistryVersion,
  itemConditionRegistryVersionSchema,
  type ItemConditionInitializedEvent,
  type ItemConditionMeterState,
  type ItemConditionModifier,
  type ItemConditionModifierAppliedEvent,
  type ItemConditionModifierEndedEvent,
  type ItemConditionThresholdCrossedEvent,
} from "@vesper/simulation-core/contracts/material-condition";
import {
  itemConditionThresholdTriggerKind,
  type TriggerScheduledEvent,
} from "@vesper/simulation-core/contracts/scheduler";
import {
  buildItemConditionInitializedEvent,
  initialConditionMetersFor,
  itemConditionThresholdUniquenessKeyPrefix,
  type ItemConditionView,
} from "@vesper/simulation-core/material-condition";
import type { BodyEventCommandContext } from "@vesper/simulation-core/bodies";
import { simItemConditionMeters, simItemConditionModifiers, simTriggers } from "@/server/db";
import { appendSimulationEvent, type LockedBranchView } from "./command-runner";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E5.3 slice 3 — the item-condition ROW layer, mirroring body-rows.ts
 * over the item-scoped meter/modifier tables (never the body ones). Row
 * mapping, lazy initialization, the material-boundary writes, the alarm
 * retirement, and the shared trailing-event write live here.
 *
 * A LEAF module: it imports no sibling store, which is what lets material-
 * store.ts's two item-condition command shells and activity-store.ts's
 * completion-time use-delta path share one copy. Before this module existed
 * activity-store.ts carried its own duplicates, because importing
 * material-store.ts would have closed the
 * `material-store → body-store → activity-store` cycle.
 */

export function itemConditionMeterFromRow(
  row: typeof simItemConditionMeters.$inferSelect,
): ItemConditionMeterState {
  return itemConditionMeterStateSchema.parse({
    itemId: row.itemId,
    meterKey: row.meterKey,
    valueFixedPoint: row.valueFixedPoint,
    baselineFixedPoint: row.baselineFixedPoint,
    lastIntegratedAtStorySecond: row.lastIntegratedAt,
    registryVersion: row.registryVersion,
  });
}

/**
 * Item-condition modifier rows never persist `visibility` — every modifier
 * this substrate ever creates (the worn-window transition,
 * `buildWornWindowTransition`) is hard-coded "obvious"; see the registry doc
 * comment in `@vesper/simulation-core/contracts/material-condition`.
 */
export function itemConditionModifierFromRow(
  row: typeof simItemConditionModifiers.$inferSelect,
): ItemConditionModifier {
  return itemConditionModifierSchema.parse({
    id: row.modifierId,
    itemId: row.itemId,
    meterKey: row.meterKey,
    operation: row.operation,
    stackingGroup: row.stackingGroup,
    priority: row.priority,
    validFromStorySecond: row.validFrom,
    ...(row.validUntil === null ? {} : { validUntilStorySecond: row.validUntil }),
    visibility: "obvious",
    sourceEventId: row.sourceEventId,
  });
}

/**
 * Row-insert shaping for the item-condition tables, exported for reuse by
 * `branch-store.ts`'s fork replay (mirrors body-rows.ts's
 * `bodyMeterRowInsert`/`bodyModifierRowInsert`).
 */
export function itemConditionMeterRowInsert(
  branchId: string,
  meter: ItemConditionMeterState,
  updatedSequence: number,
): typeof simItemConditionMeters.$inferInsert {
  return {
    branchId,
    itemId: meter.itemId,
    meterKey: meter.meterKey,
    valueFixedPoint: meter.valueFixedPoint,
    baselineFixedPoint: meter.baselineFixedPoint,
    lastIntegratedAt: meter.lastIntegratedAtStorySecond,
    registryVersion: meter.registryVersion,
    updatedSequence,
  };
}

/** Never carries `visibility` — see `itemConditionModifierFromRow` above. */
export function itemConditionModifierRowInsert(
  branchId: string,
  modifier: ItemConditionModifier,
  updatedSequence: number,
): typeof simItemConditionModifiers.$inferInsert {
  return {
    branchId,
    modifierId: modifier.id,
    itemId: modifier.itemId,
    meterKey: modifier.meterKey,
    operation: modifier.operation,
    stackingGroup: modifier.stackingGroup,
    priority: modifier.priority,
    validFrom: modifier.validFromStorySecond,
    validUntil: modifier.validUntilStorySecond ?? null,
    sourceEventId: modifier.sourceEventId,
    updatedSequence,
  };
}

/** One item's full condition state, or undefined when it has never been initialized. */
export async function loadItemConditionView(
  tx: SimTx,
  branchId: string,
  itemId: string,
): Promise<ItemConditionView | undefined> {
  const meterRows = await tx
    .select()
    .from(simItemConditionMeters)
    .where(and(eq(simItemConditionMeters.branchId, branchId), eq(simItemConditionMeters.itemId, itemId)))
    .orderBy(asc(simItemConditionMeters.meterKey));
  const [firstMeterRow] = meterRows;
  if (!firstMeterRow) return undefined;
  const modifierRows = await tx
    .select()
    .from(simItemConditionModifiers)
    .where(and(eq(simItemConditionModifiers.branchId, branchId), eq(simItemConditionModifiers.itemId, itemId)))
    .orderBy(asc(simItemConditionModifiers.modifierId));
  return {
    itemId,
    registryVersion: itemConditionRegistryVersionSchema.parse(firstMeterRow.registryVersion),
    meters: meterRows.map(itemConditionMeterFromRow),
    modifiers: modifierRows.map(itemConditionModifierFromRow),
  };
}

/**
 * Batch-load condition state for a set of items under the lock. An item
 * absent from the returned map has never been initialized (LAZY init)
 * — the caller synthesizes a fresh in-memory view and the completion path
 * emits `item_condition_initialized` for it before any delta.
 */
export async function loadItemConditionViews(
  tx: SimTx,
  branchId: string,
  itemIds: readonly string[],
): Promise<Map<string, ItemConditionView>> {
  const views = new Map<string, ItemConditionView>();
  if (itemIds.length === 0) return views;
  const [meterRows, modifierRows] = await Promise.all([
    tx
      .select()
      .from(simItemConditionMeters)
      .where(
        and(eq(simItemConditionMeters.branchId, branchId), inArray(simItemConditionMeters.itemId, [...itemIds])),
      ),
    tx
      .select()
      .from(simItemConditionModifiers)
      .where(
        and(
          eq(simItemConditionModifiers.branchId, branchId),
          inArray(simItemConditionModifiers.itemId, [...itemIds]),
        ),
      ),
  ]);
  const metersByItem = new Map<string, ItemConditionMeterState[]>();
  for (const row of meterRows) {
    const meter = itemConditionMeterFromRow(row);
    const list = metersByItem.get(meter.itemId);
    if (list) list.push(meter);
    else metersByItem.set(meter.itemId, [meter]);
  }
  const modifiersByItem = new Map<string, ItemConditionModifier[]>();
  for (const row of modifierRows) {
    const modifier = itemConditionModifierFromRow(row);
    const list = modifiersByItem.get(modifier.itemId);
    if (list) list.push(modifier);
    else modifiersByItem.set(modifier.itemId, [modifier]);
  }
  for (const [itemId, meters] of metersByItem) {
    views.set(itemId, {
      itemId,
      registryVersion: meters[0]?.registryVersion ?? itemConditionRegistryVersion,
      meters,
      modifiers: modifiersByItem.get(itemId) ?? [],
    });
  }
  return views;
}

export interface ItemConditionLazyInit {
  /** The condition view a causing resolver should see: loaded, or freshly initialized in memory. */
  condition: ItemConditionView;
  /** Present only on first touch — the caller must append it and insert its meter rows before resolving. */
  initEvent?: ItemConditionInitializedEvent;
  /** The headSequence a causing resolver's OWN view must carry (post-init when initEvent is present). */
  headSequence: number;
}

/**
 * Lazy item-condition initialization — there is no dedicated command: rows are
 * loaded if they already exist, otherwise built purely in memory (registry
 * defaults at the branch's current story second) with an
 * `item_condition_initialized` event at `branch.headSequence + 1` for the
 * caller to persist BEFORE calling its own causing resolver at the returned
 * (post-init) headSequence — mirrors the composition
 * `material-condition.test.ts`'s projector-parity fixture demonstrates.
 */
export async function loadOrInitializeItemConditionView(
  tx: SimTx,
  branch: LockedBranchView,
  command: BodyEventCommandContext,
  itemId: string,
): Promise<ItemConditionLazyInit> {
  const existing = await loadItemConditionView(tx, branch.id, itemId);
  if (existing) return { condition: existing, headSequence: branch.headSequence };

  const meters = initialConditionMetersFor({ itemId, atStorySecond: branch.storySecond });
  const initEvent = buildItemConditionInitializedEvent({
    view: {
      worldId: branch.worldId,
      branchId: branch.id,
      rulesetVersion: branch.rulesetVersion,
      headSequence: branch.headSequence,
      storySecond: branch.storySecond,
    },
    command,
    itemId,
    meters,
    sequence: branch.headSequence + 1,
  });
  return {
    condition: { itemId, registryVersion: itemConditionRegistryVersion, meters, modifiers: [] },
    initEvent,
    headSequence: initEvent.sequence,
  };
}

/** Persist a just-built lazy-init event: the event row, then its meter rows. */
export async function commitItemConditionInit(
  tx: SimTx,
  branch: LockedBranchView,
  lazy: ItemConditionLazyInit,
): Promise<void> {
  const initEvent = lazy.initEvent;
  if (!initEvent) return;
  await appendSimulationEvent(tx, initEvent);
  await tx
    .insert(simItemConditionMeters)
    .values(lazy.condition.meters.map((meter) => itemConditionMeterRowInsert(branch.id, meter, initEvent.sequence)));
}

/** Analogous to body-rows.ts's `upsertMeterRow`, item-scoped. */
export async function upsertItemConditionMeterRow(
  tx: SimTx,
  branchId: string,
  meter: ItemConditionMeterState,
  updatedSequence: number,
): Promise<void> {
  const [updated] = await tx
    .update(simItemConditionMeters)
    .set({
      valueFixedPoint: meter.valueFixedPoint,
      baselineFixedPoint: meter.baselineFixedPoint,
      lastIntegratedAt: meter.lastIntegratedAtStorySecond,
      updatedSequence,
    })
    .where(
      and(
        eq(simItemConditionMeters.branchId, branchId),
        eq(simItemConditionMeters.itemId, meter.itemId),
        eq(simItemConditionMeters.meterKey, meter.meterKey),
      ),
    )
    .returning({ meterKey: simItemConditionMeters.meterKey });
  if (!updated) throw new Error("Locked item condition meter changed before its material update");
}

/**
 * The completion-time use-delta write: value and integration boundary
 * straight off the resolved `item_condition_source_applied` event, with no
 * resolved meter state to carry a baseline — deliberately narrower than
 * {@link upsertItemConditionMeterRow}, which the command shells use.
 */
export async function upsertItemConditionMeterValue(
  tx: SimTx,
  branchId: string,
  itemId: string,
  meterKey: string,
  valueFixedPoint: number,
  lastIntegratedAtStorySecond: number,
  updatedSequence: number,
): Promise<void> {
  const [updated] = await tx
    .update(simItemConditionMeters)
    .set({
      valueFixedPoint,
      lastIntegratedAt: lastIntegratedAtStorySecond,
      updatedSequence,
    })
    .where(
      and(
        eq(simItemConditionMeters.branchId, branchId),
        eq(simItemConditionMeters.itemId, itemId),
        eq(simItemConditionMeters.meterKey, meterKey),
      ),
    )
    .returning({ meterKey: simItemConditionMeters.meterKey });
  if (!updated) throw new Error("Locked item condition meter changed before its use-delta update");
}

/**
 * Analogous to body-rows.ts's `retirePendingThresholdTriggers`, item-scoped.
 *
 * Item meters retire at the REARM event itself (unlike bodies, which retire at
 * the meter-changed event): wear's `driftLaw: "none"` means a delta does not
 * always produce a rearm (no future crossing left to solve), so retiring only
 * when a new `trigger_scheduled` actually lands avoids a needless sweep on
 * every delta and stays exact — a stale alarm is always superseded by the very
 * next rearm this same (item, meter) pair produces.
 */
export async function retirePendingItemConditionThresholdTriggers(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  itemId: string,
  meterKey: string,
): Promise<void> {
  const prefix = itemConditionThresholdUniquenessKeyPrefix(itemId, meterKey);
  await tx
    .update(simTriggers)
    .set({
      state: "completed",
      resultCommandId: commandId,
      completedAt: new Date(submittedAtWallClock),
    })
    .where(
      and(
        eq(simTriggers.branchId, branch.id),
        eq(simTriggers.state, "pending"),
        sql`starts_with(${simTriggers.uniquenessKey}, ${prefix})`,
      ),
    );
}

export type ItemConditionTrailingEvent =
  | ItemConditionModifierAppliedEvent
  | ItemConditionModifierEndedEvent
  | ItemConditionThresholdCrossedEvent
  | TriggerScheduledEvent;

/**
 * The shared item-condition per-event write, for every event past a command's
 * own primary/meter-carrying event (which each `submitDurableXxx` in
 * material-store.ts handles itself, matching body-store.ts's
 * `[primary, ...trailing]` shape).
 */
export async function applyDurableItemConditionTrailingEvent(
  tx: SimTx,
  branch: LockedBranchView,
  commandId: string,
  submittedAtWallClock: string,
  event: ItemConditionTrailingEvent,
): Promise<void> {
  switch (event.type) {
    case "item_condition_modifier_applied":
      await tx
        .insert(simItemConditionModifiers)
        .values(itemConditionModifierRowInsert(branch.id, event.payload.modifier, event.sequence));
      return;
    case "item_condition_modifier_ended": {
      const [updated] = await tx
        .update(simItemConditionModifiers)
        .set({
          // Mirror the pure projector's clamp exactly (applyItemConditionEvent).
          validUntil: sql`greatest(${event.storySecond}, ${simItemConditionModifiers.validFrom} + 1)`,
          updatedSequence: event.sequence,
        })
        .where(
          and(
            eq(simItemConditionModifiers.branchId, branch.id),
            eq(simItemConditionModifiers.modifierId, event.payload.modifierId),
          ),
        )
        .returning({ modifierId: simItemConditionModifiers.modifierId });
      if (!updated) throw new Error("Locked item condition modifier changed before its ending update");
      return;
    }
    case "item_condition_threshold_crossed":
      // Nothing beyond the event append: an instant crossing carries the SAME
      // value the causing write already persisted to the meter row.
      return;
    case "trigger_scheduled":
      if (event.payload.kind === itemConditionThresholdTriggerKind) {
        await retirePendingItemConditionThresholdTriggers(
          tx,
          branch,
          commandId,
          submittedAtWallClock,
          event.payload.command.payload.itemId,
          event.payload.command.payload.meterKey,
        );
      }
      await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
      return;
  }
}
