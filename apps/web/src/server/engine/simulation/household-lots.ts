import { and, eq } from "drizzle-orm";
import {
  RESERVED_CURRENCY_MATERIAL_KIND,
  adjustMaterialLotCommandResultSchema,
  adjustMaterialLotCommandSchema,
  promoteItemFromStockCommandResultSchema,
  promoteItemFromStockCommandSchema,
  runHouseholdRestockCommandResultSchema,
  runHouseholdRestockCommandSchema,
  transferLotQuantityCommandResultSchema,
  transferLotQuantityCommandSchema,
  type AdjustMaterialLotCommand,
  type AdjustMaterialLotCommandResult,
  type LotLocus,
  type MeansRead,
  type MeansSubject,
  type PromoteItemFromStockCommand,
  type PromoteItemFromStockCommandResult,
  type RunHouseholdRestockCommand,
  type RunHouseholdRestockCommandResult,
  type TransferLotQuantityCommand,
  type TransferLotQuantityCommandResult,
} from "@vesper/simulation-core/contracts/households";
import {
  deriveMeansSubjectRowKey,
  deriveMeansRead,
  resolveAdjustMaterialLotFromView,
  resolvePromoteItemFromStockFromView,
  resolveRunHouseholdRestockFromView,
  resolveTransferLotQuantityFromView,
} from "@vesper/simulation-core/households";
import {
  simHouseholdRestockRoutines,
  simItemHoldings,
  simItems,
  simWorlds,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import {
  PROMOTION_STOCK_KIND_PLACEHOLDER,
  buildHouseholdsResolutionView,
  commitLotInit,
  householdRestockRoutineFromRow,
  injectCrash,
  isRestockArmingLive,
  loadHouseholdsAuthorityContext,
  loadMaterialLotRow,
  loadMeansBandRow,
  loadOrInitializeLot,
  lotLocusReferenceExists,
  rejectedResult,
  updateLotQuantity,
  type HouseholdSubmitOptions,
} from "./household-rows";
import { holdingRowFieldsForLocus } from "./material-rows";
import { InjectedSimulationCrash } from "./material-store";
import { applyTriggerScheduledEvent } from "./trigger-projector";

/**
 * The E5.4 LOT-side household commands (engine.spec §26.9–26.11): the four
 * that move material quantity — adjust, transfer, promotion, and the
 * trigger-dispatched restock cycle. Their identity/policy siblings
 * (create_household, set_household_membership, set_means_band,
 * configure_restock_routine) live in household-store.ts; everything both
 * modules stand on is household-rows.ts.
 */

// ---------------------------------------------------------------------------
// adjust_material_lot (§26.9) — privileged authoring, exempt from co-location
// ---------------------------------------------------------------------------

export async function submitDurableAdjustMaterialLot(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<AdjustMaterialLotCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: adjustMaterialLotCommandSchema,
    resultSchema: adjustMaterialLotCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That stock adjustment is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That stock adjustment has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      adjustMaterialLotCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: AdjustMaterialLotCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const localeExists = lotLocusReferenceExists(context, command.payload.locus);
      const lazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.locus,
        command.payload.materialKindKey,
        branch.headSequence,
      );

      const resolution = resolveAdjustMaterialLotFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: lazy.headSequence,
          storySecond: branch.storySecond,
          localeExists,
          lot: lazy.lot,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, lazy.initEvent);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.locus,
        command.payload.materialKindKey,
        resolution.nextLot.quantityRaw,
        event.sequence,
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy.initEvent?.sequence ?? event.sequence,
        lastSequence: event.sequence,
        eventIds: [...(lazy.initEvent ? [lazy.initEvent.id] : []), event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// transfer_lot_quantity (§26.9) — same-kind conserved movement between lots
// ---------------------------------------------------------------------------

export async function submitDurableTransferLotQuantity(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<TransferLotQuantityCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: transferLotQuantityCommandSchema,
    resultSchema: transferLotQuantityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That stock transfer is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That stock transfer has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      transferLotQuantityCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: TransferLotQuantityCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      // Deterministic order (§5.4): source, then destination.
      const fromLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.fromLocus,
        command.payload.materialKindKey,
        branch.headSequence,
      );
      const toLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        command.payload.toLocus,
        command.payload.materialKindKey,
        fromLazy.headSequence,
      );

      const resolution = resolveTransferLotQuantityFromView(
        {
          ...buildHouseholdsResolutionView(context),
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: toLazy.headSequence,
          storySecond: branch.storySecond,
          actorById: (actorId) => context.actorsById.get(actorId),
          fromLot: fromLazy.lot,
          toLot: toLazy.lot,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, fromLazy.initEvent);
      await commitLotInit(tx, branch, toLazy.initEvent);

      const event = resolution.event;
      await appendSimulationEvent(tx, event);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.fromLocus,
        command.payload.materialKindKey,
        resolution.nextFromLot.quantityRaw,
        event.sequence,
      );
      await updateLotQuantity(
        tx,
        branch.id,
        command.payload.toLocus,
        command.payload.materialKindKey,
        resolution.nextToLot.quantityRaw,
        event.sequence,
      );
      injectCrash(options.crashAt, "after_projection_update");

      await advanceLockedBranch(tx, branch, event.sequence);
      injectCrash(options.crashAt, "after_branch_advance");

      const initEventIds = [
        ...(fromLazy.initEvent ? [fromLazy.initEvent.id] : []),
        ...(toLazy.initEvent ? [toLazy.initEvent.id] : []),
      ];
      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: fromLazy.initEvent?.sequence ?? toLazy.initEvent?.sequence ?? event.sequence,
        lastSequence: event.sequence,
        eventIds: [...initEventIds, event.id],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// promote_item_from_stock (§26.10 / §27.2) — the only path an aggregate fact
// becomes an explicit `sim_items` row
// ---------------------------------------------------------------------------

export async function submitDurablePromoteItemFromStock(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<PromoteItemFromStockCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: promoteItemFromStockCommandSchema,
    resultSchema: promoteItemFromStockCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That promotion request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That promotion request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      promoteItemFromStockCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: PromoteItemFromStockCommand) => {
      const context = await loadHouseholdsAuthorityContext(tx, branch.id);
      const [worldRow] = await tx
        .select({ seed: simWorlds.seed })
        .from(simWorlds)
        .where(eq(simWorlds.id, branch.worldId))
        .limit(1);
      if (!worldRow) throw new Error("Locked simulation branch references a missing world");

      const { funding, item } = command.payload;
      const fundingLocus = funding.kind === "stock" ? funding.sourceLocus : funding.currencyLocus;
      const fundingMaterialKindKey =
        funding.kind === "stock"
          ? (item.materialKindKey ?? PROMOTION_STOCK_KIND_PLACEHOLDER)
          : RESERVED_CURRENCY_MATERIAL_KIND;
      const lazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        fundingLocus,
        fundingMaterialKindKey,
        branch.headSequence,
      );

      const resolution = resolvePromoteItemFromStockFromView(
        {
          ...buildHouseholdsResolutionView(context),
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: lazy.headSequence,
          storySecond: branch.storySecond,
          actorById: (actorId) => context.actorsById.get(actorId),
          fundingLot: lazy.lot,
          // No name pool is authored anywhere yet (E5.4 slice 2) — a caller
          // that omits `item.name` must supply it explicitly until one is.
          namePool: () => [],
          worldSeed: worldRow.seed,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, lazy.initEvent);

      await appendSimulationEvent(tx, resolution.lotAdjustedEvent);
      await appendSimulationEvent(tx, resolution.itemEvent);
      injectCrash(options.crashAt, "after_event_append");

      await updateLotQuantity(
        tx,
        branch.id,
        fundingLocus,
        resolution.lotAdjustedEvent.payload.materialKindKey,
        resolution.nextFundingLot.quantityRaw,
        resolution.lotAdjustedEvent.sequence,
      );

      const newItem = resolution.itemEvent.payload.item;
      await tx.insert(simItems).values({
        branchId: branch.id,
        itemId: newItem.id,
        name: newItem.name,
        materialKindKey: newItem.materialKindKey ?? null,
        consumptionEffects: newItem.consumptionEffects ?? null,
        ownerActorId: newItem.ownerActorId,
        containerCapacityCount: newItem.container?.capacityCount ?? null,
        containerAccess: newItem.container?.access ?? null,
        conditionTracked: newItem.conditionTracked,
      });
      await tx.insert(simItemHoldings).values({
        branchId: branch.id,
        itemId: newItem.id,
        updatedSequence: resolution.itemEvent.sequence,
        ...holdingRowFieldsForLocus(newItem.locus),
      });
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.itemEvent.sequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: lazy.initEvent?.sequence ?? resolution.lotAdjustedEvent.sequence,
        lastSequence,
        eventIds: [
          ...(lazy.initEvent ? [lazy.initEvent.id] : []),
          resolution.lotAdjustedEvent.id,
          resolution.itemEvent.id,
        ],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}

// ---------------------------------------------------------------------------
// run_household_restock (§26.11) — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

export async function submitDurableRunHouseholdRestock(
  rawCommand: unknown,
  options: HouseholdSubmitOptions = {},
): Promise<RunHouseholdRestockCommandResult> {
  const result = await runSimulationCommand({
    rawCommand,
    commandSchema: runHouseholdRestockCommandSchema,
    resultSchema: runHouseholdRestockCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That restock cycle is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That restock cycle has already run."),
    conflictResult: (commandId, currentVersion) =>
      runHouseholdRestockCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command: RunHouseholdRestockCommand) => {
      const { householdId, materialKindKey } = command.payload;
      const householdLocus: LotLocus = { kind: "household", householdId };

      const [routineRow] = await tx
        .select()
        .from(simHouseholdRestockRoutines)
        .where(
          and(
            eq(simHouseholdRestockRoutines.branchId, branch.id),
            eq(simHouseholdRestockRoutines.householdId, householdId),
            eq(simHouseholdRestockRoutines.materialKindKey, materialKindKey),
          ),
        )
        .limit(1);
      const routine = routineRow ? householdRestockRoutineFromRow(routineRow) : undefined;

      const armingIsLive = await isRestockArmingLive(
        tx,
        branch.id,
        householdId,
        materialKindKey,
        command.payload.armedAtSequence,
      );

      // The stock lot may be untouched on this household+kind's first cycle —
      // lazy-init it up front, mirroring adjust_material_lot/
      // transfer_lot_quantity, so a fulfilled outcome always has a real row
      // to update.
      const stockLazy = await loadOrInitializeLot(
        tx,
        branch,
        command,
        householdLocus,
        materialKindKey,
        branch.headSequence,
      );

      // The currency lot (`lot` funding only) is read-only here: whenever
      // this command has anything to fund, the cost is strictly positive, so
      // a missing row (balance treated as zero) always resolves
      // insufficient_funds — no lazy init, and no write ever targets it when
      // absent.
      const currencyLot =
        routine?.funding.kind === "lot"
          ? await loadMaterialLotRow(tx, branch.id, routine.funding.currencyLocus, RESERVED_CURRENCY_MATERIAL_KIND)
          : undefined;

      const householdMeansSubject: MeansSubject = { kind: "household", householdId };
      let householdMeansRead: MeansRead | undefined;
      if (routine?.funding.kind === "means_band_envelope") {
        const householdCurrencyLot = await loadMaterialLotRow(
          tx,
          branch.id,
          householdLocus,
          RESERVED_CURRENCY_MATERIAL_KIND,
        );
        const householdBand = await loadMeansBandRow(tx, branch.id, deriveMeansSubjectRowKey(householdMeansSubject));
        householdMeansRead = deriveMeansRead(householdMeansSubject, {
          currencyLot: () => householdCurrencyLot,
          band: () => householdBand,
        });
      }

      const resolution = resolveRunHouseholdRestockFromView(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: stockLazy.headSequence,
          storySecond: branch.storySecond,
          routine,
          armingIsLive,
          stockLot: stockLazy.lot,
          currencyLot,
          householdMeansRead,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await commitLotInit(tx, branch, stockLazy.initEvent);

      for (const event of resolution.events) {
        await appendSimulationEvent(tx, event);
        if (event.type === "trigger_scheduled") {
          await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
        }
      }
      injectCrash(options.crashAt, "after_event_append");

      if (resolution.nextStockLot && resolution.stockLotUpdatedAtSequence !== undefined) {
        await updateLotQuantity(
          tx,
          branch.id,
          resolution.nextStockLot.locus,
          resolution.nextStockLot.materialKindKey,
          resolution.nextStockLot.quantityRaw,
          resolution.stockLotUpdatedAtSequence,
        );
      }
      if (resolution.nextCurrencyLot && resolution.currencyLotUpdatedAtSequence !== undefined) {
        await updateLotQuantity(
          tx,
          branch.id,
          resolution.nextCurrencyLot.locus,
          resolution.nextCurrencyLot.materialKindKey,
          resolution.nextCurrencyLot.quantityRaw,
          resolution.currencyLotUpdatedAtSequence,
        );
      }
      injectCrash(options.crashAt, "after_projection_update");

      const lastSequence = resolution.events[resolution.events.length - 1]?.sequence ?? stockLazy.headSequence;
      await advanceLockedBranch(tx, branch, lastSequence);
      injectCrash(options.crashAt, "after_branch_advance");

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: stockLazy.initEvent?.sequence ?? resolution.events[0]?.sequence ?? lastSequence,
        lastSequence,
        eventIds: [
          ...(stockLazy.initEvent ? [stockLazy.initEvent.id] : []),
          ...resolution.events.map((event) => event.id),
        ],
      };
    },
  });

  if (options.crashAt === "after_commit") throw new InjectedSimulationCrash("after_commit");
  return result;
}
