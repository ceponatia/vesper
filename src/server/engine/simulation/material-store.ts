import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { composeSimulationId } from "@/contracts/simulation/identity";
import { claimHoldingActivityPhases } from "@/contracts/simulation/activities";
import {
  consumeItemCommandResultSchema,
  consumeItemCommandSchema,
  destroyItemCommandResultSchema,
  destroyItemCommandSchema,
  itemLocusSchema,
  materialBranchSeedSchema,
  setItemOwnershipCommandResultSchema,
  setItemOwnershipCommandSchema,
  simulationMaterialItemSchema,
  transferItemCommandResultSchema,
  transferItemCommandSchema,
  type ConsumeItemCommand,
  type ConsumeItemCommandResult,
  type DestroyItemCommand,
  type DestroyItemCommandResult,
  type ItemGoneBasis,
  type ItemLocus,
  type SetItemOwnershipCommand,
  type SetItemOwnershipCommandResult,
  type SimulationMaterialItem,
  type TransferItemCommand,
  type TransferItemCommandResult,
} from "@/contracts/simulation/materials";
import {
  applyItemConditionSourceCommandResultSchema,
  applyItemConditionSourceCommandSchema,
  itemConditionMeterStateSchema,
  itemConditionModifierSchema,
  itemConditionRegistryVersion,
  itemConditionRegistryVersionSchema,
  resolveItemConditionThresholdCommandResultSchema,
  resolveItemConditionThresholdCommandSchema,
  type ApplyItemConditionSourceCommand,
  type ApplyItemConditionSourceCommandResult,
  type ItemConditionInitializedEvent,
  type ItemConditionMeterState,
  type ItemConditionModifier,
  type ItemConditionModifierAppliedEvent,
  type ItemConditionModifierEndedEvent,
  type ItemConditionThresholdCrossedEvent,
  type ResolveItemConditionThresholdCommand,
  type ResolveItemConditionThresholdCommandResult,
} from "@/contracts/simulation/material-condition";
import {
  itemTransferFeedConsumerKind,
  itemTransferFeedProjectionSchemaVersion,
} from "@/contracts/simulation/outbox";
import { itemConditionThresholdTriggerKind, type TriggerScheduledEvent } from "@/contracts/simulation/scheduler";
import {
  materialsSeedProjection,
  resolveConsumeItemFromView,
  resolveDestroyItemFromView,
  resolveRootLocus,
  resolveSetItemOwnershipFromView,
  resolveTransferItemFromView,
  type ConsumptionBodyView,
  type MaterialResolutionView,
} from "@/lib/simulation/materials";
import {
  buildItemConditionInitializedEvent,
  initialConditionMetersFor,
  itemConditionThresholdUniquenessKeyPrefix,
  meterViewOfItem,
  resolveApplyItemConditionSource,
  resolveItemConditionThreshold,
  type ItemConditionView,
} from "@/lib/simulation/material-condition";
import { bodyMeterRegistryByVersion, bodyRegistryVersionSchema } from "@/contracts/simulation/bodies";
import {
  BODY_THRESHOLD_HORIZON_SECONDS,
  selfCareAdjustmentsBetween,
  type BodyEventCommandContext,
  type MeterIntegrationView,
} from "@/lib/simulation/bodies";
import {
  db,
  simActivities,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simBranches,
  simCharacters,
  simItemConditionMeters,
  simItemConditionModifiers,
  simItemHoldings,
  simItems,
  simOutbox,
  simPhysicalLoci,
  simTriggers,
  simWorlds,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { itemConditionMeterRowInsert, itemConditionModifierRowInsert } from "./activity-store";
import {
  bodyConditionFromRow,
  bodyMeterFromRow,
  bodyModifierFromRow,
  bodyRhythmFromRow,
  loadCoLocatedActorIds,
  retirePendingThresholdTriggers,
  upsertMeterRow,
} from "./body-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E5.3 slice 1 durable material authority (engine.spec §26.1–26.4). Modeled on
 * body-store.ts / activity-store.ts, NOT on the Gate 1 `item-transfer-store.ts`
 * this replaces: every command runs through the shared `runSimulationCommand`
 * shell (§11.1) rather than a hand-rolled transaction, so observation/knowledge/
 * soft-canon/memory folds come free instead of needing to be reimplemented here.
 */

// ---------------------------------------------------------------------------
// Crash injection (soak-harness failpoints)
// ---------------------------------------------------------------------------

/**
 * The pre-commit points the E2.6 soak drives crashes through on the transfer
 * path, carried over from the Gate 1 store. `after_command_result` is dropped:
 * the shared shell persists `sim_commands` and folds observations/knowledge/
 * soft-canon/memory itself, after `execute` returns and outside any hook this
 * module can reach — a store built on the shared shell cannot inject there
 * (command-runner.ts:170 marks the spot; adding a hook is a shell-wide change,
 * out of this slice's scope, not a per-store one).
 */
export type DurableMaterialCrashPoint =
  | "after_event_append"
  | "after_projection_update"
  | "after_outbox_insert"
  | "after_branch_advance"
  | "after_commit";

export class InjectedSimulationCrash extends Error {
  constructor(readonly point: DurableMaterialCrashPoint) {
    super(`Injected E5.3 crash at ${point}`);
    this.name = "InjectedSimulationCrash";
  }
}

function injectCrash(
  configured: DurableMaterialCrashPoint | undefined,
  point: Exclude<DurableMaterialCrashPoint, "after_commit">,
): void {
  if (configured === point) throw new InjectedSimulationCrash(point);
}

export interface MaterialSeedOptions {
  database?: Db;
}

export interface MaterialSubmitOptions {
  database?: Db;
  crashAt?: DurableMaterialCrashPoint;
  /**
   * Admit the command at whatever version the branch holds once its lock is
   * taken, instead of comparing against a caller-supplied expectedVersion —
   * see command-runner.ts's `runSimulationCommand` doc for the trigger-replay
   * rationale (a scheduled transfer resolves under this option).
   */
  admitAtLockedVersion?: boolean;
}

/**
 * §26.7 item-condition commands mirror `BodyStoreOptions` (body-store.ts),
 * not `MaterialSubmitOptions`: they have no soak crash-injection points of
 * their own (the pre-commit failpoints above are transfer/destroy/consume-
 * specific), matching `submitDurableResolveBodyThreshold`'s own option shape.
 */
export interface ItemConditionSubmitOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

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
// Seed — replaces the Gate 1 world/branch/character/item bootstrap
// ---------------------------------------------------------------------------

/**
 * Seed one new E5.3 branch atomically from `materialBranchSeedSchema`. This is
 * the bootstrap/test seam every other durable store's int test also boots
 * through (world + branch + `sim_characters` rows) — a bootstrap/test seam,
 * not a branch-fork implementation (branch-store.ts owns ancestry).
 *
 * Items are inserted in FK-safe order (world, branch, characters, items, then
 * holdings) so a container item and the item it holds land in one statement
 * batch regardless of array order. An item whose seed locus is `zone` needs
 * that zone to already exist in `sim_zones` (a non-deferred FK) — this
 * function does not create zones, so callers wanting a zone-resting item at
 * seed time must call `seedDurableSpaceTopology` first; because that function
 * in turn needs this one's characters to already exist for its physical-locus
 * rows, the practical three-step order for "embodied actors + a zone-resting
 * item" is: this seed (characters + non-zone items), then space topology
 * (zones + loci), then a `transfer_item` command placing the item at a zone.
 */
export async function seedDurableMaterialBranch(
  rawSeed: unknown,
  options: MaterialSeedOptions = {},
): Promise<void> {
  const seed = materialBranchSeedSchema.parse(rawSeed);
  // Asserts §26 projection invariants (unique ids, container refs, capacity,
  // no cycles) before anything is written — the pure layer runs first.
  materialsSeedProjection(seed);
  const database = options.database ?? db();

  await database.transaction(async (tx) => {
    await tx
      .insert(simWorlds)
      .values({
        id: seed.worldId,
        worldTypeId: seed.worldTypeId,
        seed: seed.worldSeed,
        rulesetVersion: seed.rulesetVersion,
        status: seed.worldStatus,
        permitsTrespass: seed.permitsTrespass,
      })
      .onConflictDoNothing();

    const [world] = await tx
      .select({
        worldTypeId: simWorlds.worldTypeId,
        seed: simWorlds.seed,
        rulesetVersion: simWorlds.rulesetVersion,
        status: simWorlds.status,
      })
      .from(simWorlds)
      .where(eq(simWorlds.id, seed.worldId))
      .limit(1);
    if (
      !world ||
      world.worldTypeId !== seed.worldTypeId ||
      world.seed !== seed.worldSeed ||
      world.rulesetVersion !== seed.rulesetVersion ||
      world.status !== seed.worldStatus
    ) {
      throw new Error("Existing simulation world metadata does not match the branch seed");
    }

    await tx.insert(simBranches).values({
      id: seed.branchId,
      worldId: seed.worldId,
      headSequence: 0,
      version: 0,
      storySecond: seed.originStorySecond,
      // The seed step is not an event (plan R3), so the origin clock must be
      // recorded here or a fork at sequence zero could never recover it.
      originStorySecond: seed.originStorySecond,
    });

    if (seed.actors.length > 0) {
      await tx.insert(simCharacters).values(
        seed.actors.map((actor) => ({
          branchId: seed.branchId,
          characterId: actor.id,
          name: actor.name,
        })),
      );
    }
    if (seed.items.length > 0) {
      await tx.insert(simItems).values(
        seed.items.map((item) => ({
          branchId: seed.branchId,
          itemId: item.id,
          name: item.name,
          materialKindKey: item.materialKindKey ?? null,
          consumptionEffects: item.consumptionEffects ?? null,
          ownerActorId: item.ownerActorId,
          containerCapacityCount: item.container?.capacityCount ?? null,
          containerAccess: item.container?.access ?? null,
          conditionTracked: item.conditionTracked,
        })),
      );
      await tx.insert(simItemHoldings).values(
        seed.items.map((item) => ({
          branchId: seed.branchId,
          itemId: item.id,
          updatedSequence: 0,
          ...holdingRowFieldsForLocus(item.locus),
        })),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Authority view — lock-consistent, loaded fresh inside every command
// ---------------------------------------------------------------------------

/**
 * Load the material authority view under the branch lock. Items and their
 * holdings are read whole (not just the command's named item) because the
 * pure resolver's root-locus walk and cycle check may hop through container
 * items never named on the command — and the view's `itemById` must resolve
 * synchronously, so there is no way to fetch a hop lazily mid-walk. Branch
 * scale (tests, soak) keeps this a single small join, not a growth risk;
 * `containerOccupantCount` is derived from the same holdings rows rather than
 * a second aggregate query — one lock-consistent snapshot, not two.
 *
 * `touchedItemIds` names the item(s) THIS command's pure resolver may check
 * `reservingActivityId` against (always exactly the one named item, for every
 * current command) — the reservation fact is preloaded for just those ids in
 * one query (§26.5), not resolved per-callback, because the accessor must
 * answer synchronously.
 */
async function loadMaterialResolutionView(
  tx: SimTx,
  branch: LockedBranchView,
  touchedItemIds: readonly string[],
): Promise<MaterialResolutionView> {
  const characterRows = await tx
    .select({ characterId: simCharacters.characterId, name: simCharacters.name })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branch.id));
  const actorsById = new Map(characterRows.map((row) => [row.characterId, { id: row.characterId, name: row.name }]));

  const locusRows = await tx
    .select({
      actorId: simPhysicalLoci.actorId,
      kind: simPhysicalLoci.kind,
      zoneId: simPhysicalLoci.zoneId,
      locationId: simPhysicalLoci.locationId,
    })
    .from(simPhysicalLoci)
    .where(eq(simPhysicalLoci.branchId, branch.id));
  const lociByActor = new Map(locusRows.map((row) => [row.actorId, row]));

  const itemRows = await tx
    .select({
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
    })
    .from(simItems)
    .innerJoin(
      simItemHoldings,
      and(eq(simItemHoldings.branchId, simItems.branchId), eq(simItemHoldings.itemId, simItems.itemId)),
    )
    .where(eq(simItems.branchId, branch.id));

  const itemsById = new Map<string, SimulationMaterialItem>();
  const containerOccupantCounts = new Map<string, number>();
  for (const row of itemRows) {
    const locus = itemLocusFromHoldingRow({
      locusKind: row.locusKind,
      actorId: row.holdingActorId,
      slotKey: row.slotKey,
      containerItemId: row.containerItemId,
      zoneId: row.zoneId,
      goneBasis: row.goneBasis,
    });
    const item = simulationMaterialItemSchema.parse({
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
    itemsById.set(item.id, item);
    if (locus.kind === "container") {
      containerOccupantCounts.set(locus.containerItemId, (containerOccupantCounts.get(locus.containerItemId) ?? 0) + 1);
    }
  }

  // §26.5: which live activity (if any) reserves each touched item. Live is
  // every claim-holding phase (queued/preparing/active/paused/interrupted) —
  // the same set claims themselves project from — so a reservation can never
  // outlive the activity that holds it and never orphan.
  const reservingActivityIdByItem = new Map<string, string>();
  if (touchedItemIds.length > 0) {
    const reservationRows = await tx
      .select({
        activityInstanceId: simActivities.activityInstanceId,
        reservedItemIds: simActivities.reservedItemIds,
      })
      .from(simActivities)
      .where(
        and(
          eq(simActivities.branchId, branch.id),
          inArray(simActivities.phase, [...claimHoldingActivityPhases]),
          or(
            ...touchedItemIds.map(
              (itemId) => sql`${simActivities.reservedItemIds} @> ${JSON.stringify([itemId])}::jsonb`,
            ),
          ),
        ),
      );
    for (const row of reservationRows) {
      for (const itemId of row.reservedItemIds) {
        if (touchedItemIds.includes(itemId) && !reservingActivityIdByItem.has(itemId)) {
          reservingActivityIdByItem.set(itemId, row.activityInstanceId);
        }
      }
    }
  }

  return {
    worldId: branch.worldId,
    branchId: branch.id,
    rulesetVersion: branch.rulesetVersion,
    version: branch.version,
    headSequence: branch.headSequence,
    storySecond: branch.storySecond,
    actorById: (actorId) => actorsById.get(actorId),
    actorZoneId: (actorId) => {
      const locus = lociByActor.get(actorId);
      return locus && locus.kind === "at" && locus.zoneId !== null ? locus.zoneId : null;
    },
    actorLocationId: (actorId) => {
      const locus = lociByActor.get(actorId);
      return locus && locus.kind === "at" && locus.locationId !== null ? locus.locationId : null;
    },
    itemById: (itemId) => itemsById.get(itemId),
    containerOccupantCount: (containerItemId) => containerOccupantCounts.get(containerItemId) ?? 0,
    reservingActivityId: (itemId) => reservingActivityIdByItem.get(itemId) ?? null,
  };
}

// ---------------------------------------------------------------------------
// E5.3 slice 3 — item condition authority (engine.spec §26.7), mirroring
// body-store.ts's threshold-alarm choreography over item-scoped tables.
// ---------------------------------------------------------------------------

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
 * The row-shaping INSERT direction (`itemConditionMeterRowInsert`/
 * `itemConditionModifierRowInsert`) is NOT duplicated here — it lives in
 * activity-store.ts and is imported below. activity-store.ts needs its own
 * copy regardless (it writes these tables directly for its §26.5 completion-
 * time use-delta path without routing through this module, to avoid a
 * material-store.ts → body-store.ts → activity-store.ts → material-store.ts
 * cycle), and branch-store.ts's fork materialization already imports THAT
 * copy — so reusing it here, rather than growing a second one, is the one
 * canonical implementation instead of two that could drift apart.
 */

/**
 * Item-condition modifier rows never persist `visibility` (see
 * `activity-store.ts`'s `itemConditionModifierFromRow`, the canonical
 * mirror of this same parse): every modifier this substrate ever creates
 * (the worn-window transition) is hard-coded "obvious" — see the registry
 * doc comment in `@/contracts/simulation/material-condition`.
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

/** One item's full condition state, or undefined when it has never been initialized. */
async function loadItemConditionView(
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

interface ItemConditionLazyInit {
  /** The condition view a causing resolver should see: loaded, or freshly initialized in memory. */
  condition: ItemConditionView;
  /** Present only on first touch — the caller must append it and insert its meter rows before resolving. */
  initEvent?: ItemConditionInitializedEvent;
  /** The headSequence a causing resolver's OWN view must carry (post-init when initEvent is present). */
  headSequence: number;
}

/**
 * Lazy item-condition initialization (engine.spec §26.7 — "there is no
 * dedicated command"): loaded if rows already exist, otherwise built purely
 * in memory (registry defaults at the branch's current story second) with an
 * `item_condition_initialized` event at `branch.headSequence + 1` for the
 * caller to persist BEFORE calling its own causing resolver at the returned
 * (post-init) headSequence — mirrors the composition
 * `material-condition.test.ts`'s projector-parity fixture demonstrates.
 */
async function loadOrInitializeItemConditionView(
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
async function commitItemConditionInit(tx: SimTx, branch: LockedBranchView, lazy: ItemConditionLazyInit): Promise<void> {
  const initEvent = lazy.initEvent;
  if (!initEvent) return;
  await appendSimulationEvent(tx, initEvent);
  await tx
    .insert(simItemConditionMeters)
    .values(lazy.condition.meters.map((meter) => itemConditionMeterRowInsert(branch.id, meter, initEvent.sequence)));
}

/** All actors physically at `zoneId` — the item-condition witness set (§26.7: co-location with the item's root locus). */
async function loadCoLocatedActorIdsForZone(tx: SimTx, branchId: string, zoneId: string): Promise<string[]> {
  const rows = await tx
    .select({ actorId: simPhysicalLoci.actorId })
    .from(simPhysicalLoci)
    .where(
      and(
        eq(simPhysicalLoci.branchId, branchId),
        eq(simPhysicalLoci.kind, "at"),
        eq(simPhysicalLoci.zoneId, zoneId),
      ),
    );
  return rows.map((row) => row.actorId);
}

/** Analogous to body-store.ts's `upsertMeterRow`, item-scoped. */
async function upsertItemConditionMeterRow(
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

/** Analogous to body-store.ts's `retirePendingThresholdTriggers`, item-scoped. */
async function retirePendingItemConditionThresholdTriggers(
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

type ItemConditionTrailingEvent =
  | ItemConditionModifierAppliedEvent
  | ItemConditionModifierEndedEvent
  | ItemConditionThresholdCrossedEvent
  | TriggerScheduledEvent;

/**
 * The shared item-condition per-event write, for every event past a command's
 * own primary/meter-carrying event (which each `submitDurableXxx` below
 * handles itself, matching body-store.ts's `[primary, ...trailing]` shape).
 */
async function applyDurableItemConditionTrailingEvent(
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

/**
 * Build the actor's §26.6 `ConsumptionBodyView` the same way body-store.ts
 * loads one actor's body for its own resolvers — `loadActorBody` /
 * `meterViewOf` / `collapseContextOf` there are private to that module, so
 * this is the material lane's own copy of the same shape (meters, modifiers,
 * rhythms, and the collapse context's last-real-sleep fact), reusing every
 * row mapper body-store.ts exports rather than re-deriving them.
 */
async function loadConsumptionBodyView(
  tx: SimTx,
  branchId: string,
  actorId: string,
  storySecond: number,
): Promise<ConsumptionBodyView> {
  const [meterRows, modifierRows, rhythmRows, conditionRows] = await Promise.all([
    tx
      .select()
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, branchId), eq(simBodyMeters.actorId, actorId))),
    tx
      .select()
      .from(simBodyModifiers)
      .where(and(eq(simBodyModifiers.branchId, branchId), eq(simBodyModifiers.actorId, actorId))),
    tx
      .select()
      .from(simBodyRhythms)
      .where(and(eq(simBodyRhythms.branchId, branchId), eq(simBodyRhythms.actorId, actorId))),
    tx
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, branchId), eq(simBodyConditions.actorId, actorId))),
  ]);
  const meters = meterRows.map(bodyMeterFromRow);
  const modifiers = modifierRows.map(bodyModifierFromRow);
  const rhythms = rhythmRows.map(bodyRhythmFromRow);
  const conditions = conditionRows.map(bodyConditionFromRow);
  const horizon = storySecond + BODY_THRESHOLD_HORIZON_SECONDS;

  const lastSleepEndedAtStorySecond = conditions
    .filter(
      (condition) =>
        condition.key === "asleep" && condition.status === "ended" && condition.endedAtStorySecond !== undefined,
    )
    .reduce<number | undefined>(
      (latest, condition) =>
        latest === undefined || (condition.endedAtStorySecond ?? 0) > latest
          ? condition.endedAtStorySecond
          : latest,
      undefined,
    );

  const meterView = (meterKey: string): MeterIntegrationView | undefined => {
    const state = meters.find((meter) => meter.meterKey === meterKey);
    if (!state) return undefined;
    const parsedVersion = bodyRegistryVersionSchema.safeParse(state.registryVersion);
    if (!parsedVersion.success) return undefined;
    const definition = bodyMeterRegistryByVersion[parsedVersion.data].find(
      (candidate) => candidate.key === meterKey,
    );
    if (!definition) return undefined;
    return {
      definition,
      state,
      modifiers: modifiers.filter((modifier) => modifier.meterKey === meterKey),
      scheduledAdjustments: selfCareAdjustmentsBetween(rhythms, meterKey, state.lastIntegratedAtStorySecond, horizon),
    };
  };

  return {
    bodyInitialized: meters.length > 0,
    meterView,
    collapseContext: {
      rhythmRows: rhythms,
      ...(lastSleepEndedAtStorySecond === undefined ? {} : { lastSleepEndedAtStorySecond }),
    },
  };
}

async function updateItemLocus(
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
 * Insert one material feed delivery obligation. Exported: the sibling §26.5
 * completion-time consume-disposition path (`activity-store.ts`) publishes
 * the same obligation for each `item_consumed` its own transaction emits, so
 * this is the one place that row shape is built.
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

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

// ---------------------------------------------------------------------------
// transfer_item (v2) — §26.4
// ---------------------------------------------------------------------------

/** Execute one TransferItem: event append, holdings update, and feed obligation, atomically. */
export async function submitDurableTransferItem(
  rawCommand: unknown,
  options: MaterialSubmitOptions = {},
): Promise<TransferItemCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: transferItemCommandSchema,
    resultSchema: transferItemCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That action request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That action request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      transferItemCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: TransferItemCommand) => {
      const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
      const item = view.itemById(command.payload.itemId);
      // §26.7: only a worn-ness-changing move on a tracked item ever touches
      // condition state — every other transfer skips loading/initializing it
      // entirely, keeping "lazy" honest (a held-to-held move of a tracked-but-
      // untouched item must not spuriously initialize its meters).
      const wornnessChanges =
        item?.conditionTracked === true &&
        (command.payload.fromLocus.kind === "worn") !== (command.payload.toLocus.kind === "worn");
      const lazy = wornnessChanges
        ? await loadOrInitializeItemConditionView(tx, branch, command, command.payload.itemId)
        : undefined;

      const resolution = resolveTransferItemFromView(
        { ...view, headSequence: lazy?.headSequence ?? branch.headSequence },
        command,
        lazy?.condition,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      if (lazy) await commitItemConditionInit(tx, branch, lazy);

      const [event, ...conditionEvents] = resolution.events;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateItemLocus(tx, branch.id, event.payload.itemId, event.payload.toLocus, event.sequence);
      injectCrash(options.crashAt, "after_projection_update");

      await publishMaterialFeedObligation(tx, event);
      injectCrash(options.crashAt, "after_outbox_insert");

      // Unconditional, like body-store's own choreography (e.g.
      // `submitDurableEndBodyCondition` retires every affected meter's alarm
      // BEFORE its trailing loop, never gated on a fresh rearm existing): a
      // worn-ness change always invalidates cleanliness's prior alarm, even
      // when the new trajectory (e.g. doffed, no longer decaying) has nothing
      // to re-arm — leaving it pending would let a stale alarm fire later and
      // rely solely on fire-time re-validation to reject it.
      if (wornnessChanges) {
        await retirePendingItemConditionThresholdTriggers(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          command.payload.itemId,
          "cleanliness",
        );
      }

      for (const conditionEvent of conditionEvents) {
        await appendSimulationEvent(tx, conditionEvent);
        await applyDurableItemConditionTrailingEvent(
          tx,
          branch,
          command.id,
          command.submittedAtWallClock,
          conditionEvent,
        );
      }

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? event.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy?.initEvent?.sequence ?? event.sequence,
        lastSequence,
        eventIds: [
          ...(lazy?.initEvent ? [lazy.initEvent.id] : []),
          event.id,
          ...conditionEvents.map((conditionEvent) => conditionEvent.id),
        ],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// destroy_item (v1) — §26.1 gone/terminal
// ---------------------------------------------------------------------------

/** Execute one DestroyItem: event append, terminal holdings update, and feed obligation, atomically. */
export async function submitDurableDestroyItem(
  rawCommand: unknown,
  options: MaterialSubmitOptions = {},
): Promise<DestroyItemCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: destroyItemCommandSchema,
    resultSchema: destroyItemCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That destruction request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That destruction has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      destroyItemCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: DestroyItemCommand) => {
      const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
      const resolution = resolveDestroyItemFromView(view, command);
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateItemLocus(
        tx,
        branch.id,
        event.payload.itemId,
        { kind: "gone", basis: event.payload.basis },
        event.sequence,
      );
      injectCrash(options.crashAt, "after_projection_update");

      await publishMaterialFeedObligation(tx, event);
      injectCrash(options.crashAt, "after_outbox_insert");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// consume_item (v1) — §26.6 a material event with a body effect
// ---------------------------------------------------------------------------

/**
 * Execute one ConsumeItem: the `item_consumed` event, holdings update, and
 * feed obligation exactly like destroy, PLUS — when the item carries authored
 * `consumptionEffects` — the trailing §25 body-kernel events in the same
 * transaction (retire-then-re-arm per meter, mirroring
 * `submitDurableApplyBodySource`), all under one branch advance. An
 * uninitialized (or bodiless) actor still eats: `resolveConsumeItemFromView`
 * returns zero trailing body events and this loop simply has nothing to do.
 */
export async function submitDurableConsumeItem(
  rawCommand: unknown,
  options: MaterialSubmitOptions = {},
): Promise<ConsumeItemCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: consumeItemCommandSchema,
    resultSchema: consumeItemCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That consumption request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That consumption has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      consumeItemCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: ConsumeItemCommand) => {
      const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
      const item = view.itemById(command.payload.itemId);
      const bodyView =
        item?.consumptionEffects && item.consumptionEffects.length > 0
          ? await loadConsumptionBodyView(tx, branch.id, command.payload.actorId, branch.storySecond)
          : undefined;
      const resolution = resolveConsumeItemFromView(view, command, bodyView);
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateItemLocus(tx, branch.id, event.payload.itemId, { kind: "gone", basis: "consumed" }, event.sequence);
      injectCrash(options.crashAt, "after_projection_update");

      await publishMaterialFeedObligation(tx, event);
      injectCrash(options.crashAt, "after_outbox_insert");

      // §26.6 trailing body effects, in the order the resolver built them:
      // each body_source_applied retires (and, for energy, collapse-retires)
      // its own meter's pending alarm BEFORE its own trailing re-arm — never
      // a single retirement for the whole batch, because a multi-effect item
      // (e.g. a meal that both feeds and hydrates) touches more than one meter.
      let meterUpdateIndex = 0;
      for (const trailing of resolution.bodyEvents) {
        await appendSimulationEvent(tx, trailing);
        switch (trailing.type) {
          case "body_source_applied": {
            await retirePendingThresholdTriggers(
              tx,
              branch,
              command.id,
              command.submittedAtWallClock,
              command.payload.actorId,
              trailing.payload.meterKey,
            );
            const meter = resolution.meterUpdates[meterUpdateIndex];
            meterUpdateIndex += 1;
            if (!meter) {
              throw new Error("Consumption produced a body_source_applied event without a matching meter update");
            }
            await upsertMeterRow(tx, branch.id, meter, trailing.sequence);
            break;
          }
          case "trigger_scheduled": {
            await applyTriggerScheduledEvent(tx, trailing, { branchId: branch.id, worldId: branch.worldId });
            break;
          }
        }
      }

      const lastSequence = resolution.bodyEvents.at(-1)?.sequence ?? event.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence,
        eventIds: [event.id, ...resolution.bodyEvents.map((trailing) => trailing.id)],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// set_item_ownership (v1) — §26.3 social, not physical
// ---------------------------------------------------------------------------

/**
 * Execute one SetItemOwnership: event append and `sim_items.owner_actor_id`
 * update, atomically. No holdings row change (ownership never moves an item)
 * and no feed obligation (§26.3 — nothing in the world moved for anyone to
 * see; the material feed carries movements, not the social ledger).
 */
export async function submitDurableSetItemOwnership(
  rawCommand: unknown,
  options: MaterialSubmitOptions = {},
): Promise<SetItemOwnershipCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: setItemOwnershipCommandSchema,
    resultSchema: setItemOwnershipCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That ownership request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That ownership request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      setItemOwnershipCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: SetItemOwnershipCommand) => {
      const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
      const resolution = resolveSetItemOwnershipFromView(view, command);
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      const updated = await tx
        .update(simItems)
        .set({ ownerActorId: event.payload.newOwnerActorId })
        .where(and(eq(simItems.branchId, branch.id), eq(simItems.itemId, event.payload.itemId)))
        .returning({ itemId: simItems.itemId });
      if (updated.length !== 1) throw new Error("Locked item changed before its ownership update");
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// apply_item_condition_source (v1) — §26.7 an actor cleans/adjusts a reachable item
// ---------------------------------------------------------------------------

/**
 * Execute one ApplyItemConditionSource: lazily initialize the item's condition
 * state on first touch, integrate → apply → re-arm through the pure resolver,
 * and persist every trailing event — mirrors `submitDurableApplyBodySource`'s
 * shape (body-store.ts), item-scoped.
 */
export async function submitDurableApplyItemConditionSource(
  rawCommand: unknown,
  options: ItemConditionSubmitOptions = {},
): Promise<ApplyItemConditionSourceCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: applyItemConditionSourceCommandSchema,
    resultSchema: applyItemConditionSourceCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That item condition request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That item condition change has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      applyItemConditionSourceCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: ApplyItemConditionSourceCommand) => {
      const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
      const item = view.itemById(command.payload.itemId);
      const lazy = item?.conditionTracked
        ? await loadOrInitializeItemConditionView(tx, branch, command, command.payload.itemId)
        : undefined;

      // Witness capture for a possible instant threshold crossing (§26.7 — the
      // `wear` meter has no drift, so its crossings can only ever be detected
      // synchronously here, unlike bodies' purely-scheduled thresholds). The
      // acting actor's own zone join is exactly "co-located with the item":
      // `root_not_colocated` below already requires them to be at its root zone.
      const coLocatedActorIds = await loadCoLocatedActorIds(tx, branch.id, command.payload.actorId);

      const resolution = resolveApplyItemConditionSource(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: lazy?.headSequence ?? branch.headSequence,
          storySecond: branch.storySecond,
          ...(lazy?.condition ? { condition: lazy.condition } : {}),
          coLocatedActorIds,
        },
        command,
        view,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      if (lazy) await commitItemConditionInit(tx, branch, lazy);

      const [sourceEvent, ...trailing] = resolution.events;
      await appendSimulationEvent(tx, sourceEvent);
      await retirePendingItemConditionThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.itemId,
        command.payload.meterKey,
      );
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        await applyDurableItemConditionTrailingEvent(tx, branch, command.id, command.submittedAtWallClock, event);
      }
      await upsertItemConditionMeterRow(tx, branch.id, resolution.meter, sourceEvent.sequence);

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? sourceEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy?.initEvent?.sequence ?? sourceEvent.sequence,
        lastSequence,
        eventIds: [
          ...(lazy?.initEvent ? [lazy.initEvent.id] : []),
          ...resolution.events.map((event) => event.id),
        ],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// resolve_item_condition_threshold (v1) — §26.7 trigger-dispatched, fire-time re-validated
// ---------------------------------------------------------------------------

/** Resolve one item meter's due threshold — mirrors `submitDurableResolveBodyThreshold`'s structure, item-scoped. */
export async function submitDurableResolveItemConditionThreshold(
  rawCommand: unknown,
  options: ItemConditionSubmitOptions = {},
): Promise<ResolveItemConditionThresholdCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resolveItemConditionThresholdCommandSchema,
    resultSchema: resolveItemConditionThresholdCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That item condition request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That item limit has already been resolved."),
    conflictResult: (commandId, currentVersion) =>
      resolveItemConditionThresholdCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: ResolveItemConditionThresholdCommand) => {
      const condition = await loadItemConditionView(tx, branch.id, command.payload.itemId);
      const meterView = condition ? meterViewOfItem(condition, command.payload.meterKey) : undefined;
      const threshold = meterView?.definition.thresholds.find(
        (candidate) => candidate.key === command.payload.thresholdKey,
      );

      // §26.7: "witnessed by co-location with the item's root locus". When the
      // root is an actor (held/worn), that actor is the item's own holder —
      // not an external witness of their own effects, so `loadCoLocatedActorIds`
      // (the SAME zone join `resolveApplyItemConditionSource`'s instant-crossing
      // witnessing uses, per body-store's own subject-exclusion precedent)
      // excludes them. A zone-resting item has no holder to exclude.
      let coLocatedActorIds: string[] = [];
      if (threshold?.noticeable === true) {
        const view = await loadMaterialResolutionView(tx, branch, [command.payload.itemId]);
        const item = view.itemById(command.payload.itemId);
        if (item) {
          const root = resolveRootLocus(item.locus, view.itemById);
          if (root.kind === "actor") {
            coLocatedActorIds = await loadCoLocatedActorIds(tx, branch.id, root.actorId);
          } else if (root.kind === "zone") {
            coLocatedActorIds = await loadCoLocatedActorIdsForZone(tx, branch.id, root.zoneId);
          }
        }
      }

      const resolution = resolveItemConditionThreshold(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(condition ? { condition } : {}),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [crossedEvent, ...trailing] = resolution.events;
      await appendSimulationEvent(tx, crossedEvent);
      await retirePendingItemConditionThresholdTriggers(
        tx,
        branch,
        command.id,
        command.submittedAtWallClock,
        command.payload.itemId,
        command.payload.meterKey,
      );
      for (const event of trailing) {
        await appendSimulationEvent(tx, event);
        await applyDurableItemConditionTrailingEvent(tx, branch, command.id, command.submittedAtWallClock, event);
      }
      await upsertItemConditionMeterRow(tx, branch.id, resolution.meter, crossedEvent.sequence);

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? crossedEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: crossedEvent.sequence,
        lastSequence,
        eventIds: resolution.events.map((event) => event.id),
      };
    },
  });
}
