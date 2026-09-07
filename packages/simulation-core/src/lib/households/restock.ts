import { composeSimulationId } from "../../contracts/identity";
import { RESERVED_CURRENCY_MATERIAL_KIND, compareMeansBands, householdRestockDeferredEventSchema, householdRestockFulfilledEventSchema, householdRestockRoutineConfiguredEventSchema, materialKindRegistryVersion, materialLotAdjustedEventSchema, materialLotStateSchema, type ConfigureRestockRoutineCommand, type ConfigureRestockRoutineRejectionCode, type HouseholdRestockDeferredEvent, type HouseholdRestockDeferredReason, type HouseholdRestockFulfilledEvent, type HouseholdRestockRoutine, type HouseholdRestockRoutineConfiguredEvent, type LotLocus, type MaterialLotAdjustedEvent, type MaterialLotState, type MeansRead, type RunHouseholdRestockCommand, type RunHouseholdRestockRejectionCode } from "../../contracts/households";
import { householdRestockTriggerKind, schedulerDerivationVersion, triggerScheduledEventSchema, type TriggerScheduledEvent } from "../../contracts/scheduler";
import { sortedUnique } from "../hash";
import { resolveQuantityKind } from "./lots";
import { eventEnvelope, rejection, isPrivilegedPrincipal, lotLocusEntityIds, type HouseholdEventCommandContext, type HouseholdRejection, type HouseholdsBranchMeta } from "./shared";

// ---------------------------------------------------------------------------
// Household restock alarm identity — mirrors
// `itemConditionThresholdUniquenessKey`/`Prefix`: versioned by `armedAtSequence`
// so a re-arm is a distinct alarm and the prefix retires every arming attempt
// for one (householdId, materialKindKey) regardless of its version.
// ---------------------------------------------------------------------------

export function householdRestockUniquenessKey(
  householdId: string,
  materialKindKey: string,
  armedAtSequence: number,
): string {
  return composeSimulationId("household-restock", [householdId, materialKindKey, String(armedAtSequence)]);
}

export function householdRestockUniquenessKeyPrefix(householdId: string, materialKindKey: string): string {
  return `${composeSimulationId("household-restock", [householdId, materialKindKey])}:`;
}

/**
 * Arm (or re-arm) one household+kind's restock alarm, due at `view.storySecond
 * + cadenceSeconds` — a fixed cadence, not a solved crossing (restock is
 * discrete-scheduled, not continuous-integrated, so there is no trajectory to
 * solve against, unlike `rearmThresholdTrigger`/
 * `rearmItemConditionThresholdTrigger`).
 */
export function buildHouseholdRestockTrigger(input: {
  view: HouseholdsBranchMeta;
  command: HouseholdEventCommandContext;
  householdId: string;
  materialKindKey: string;
  cadenceSeconds: number;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent {
  const uniquenessKey = householdRestockUniquenessKey(
    input.householdId,
    input.materialKindKey,
    input.armedAtSequence,
  );
  const templateId = composeSimulationId("template", [uniquenessKey]);
  return triggerScheduledEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, "arm-household-restock"),
    type: "trigger_scheduled",
    derivationVersion: schedulerDerivationVersion,
    causationId: input.causationId,
    actorIds: [],
    entityIds: [input.householdId],
    payload: {
      kind: householdRestockTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: input.view.storySecond + input.cadenceSeconds,
      priority: 0,
      uniquenessKey,
      command: {
        id: templateId,
        branchId: input.view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: input.command.submittedAtWallClock,
        correlationId: input.command.correlationId,
        schemaVersion: 1,
        type: "run_household_restock",
        payload: {
          householdId: input.householdId,
          materialKindKey: input.materialKindKey,
          armedAtSequence: input.armedAtSequence,
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// configure_restock_routine
// ---------------------------------------------------------------------------

export interface ConfigureRestockRoutineResolutionView extends HouseholdsBranchMeta {
  householdExists: boolean;
}

export type ConfigureRestockRoutineResolution =
  | HouseholdRejection<ConfigureRestockRoutineRejectionCode>
  | { ok: true; events: [HouseholdRestockRoutineConfiguredEvent, ...TriggerScheduledEvent[]] };

/**
 * The command payload IS the routine — configuring always upserts the row
 * wholesale. Arming is unconditional-retire-then-arm-if-active at the STORE
 * layer (the pure resolver only ever builds a fresh arm; it never retires —
 * retirement touches durable trigger rows, which this file never sees).
 */
export function resolveConfigureRestockRoutineFromView(
  view: ConfigureRestockRoutineResolutionView,
  command: ConfigureRestockRoutineCommand,
): ConfigureRestockRoutineResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!isPrivilegedPrincipal(command.principal.kind)) {
    return rejection("unauthorized_principal", "Only the storyteller can configure a restock routine.");
  }
  if (!view.householdExists) return rejection("household_not_found", "That household is unavailable.");

  const configuredEvent = householdRestockRoutineConfiguredEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "household-restock-routine-configured"),
    type: "household_restock_routine_configured",
    actorIds: [],
    entityIds: sortedUnique([command.payload.householdId]),
    payload: {
      householdId: command.payload.householdId,
      materialKindKey: command.payload.materialKindKey,
      targetQuantityRaw: command.payload.targetQuantityRaw,
      lowWaterThresholdRaw: command.payload.lowWaterThresholdRaw,
      cadenceSeconds: command.payload.cadenceSeconds,
      funding: command.payload.funding,
      active: command.payload.active,
    },
  });

  const events: [HouseholdRestockRoutineConfiguredEvent, ...TriggerScheduledEvent[]] = [configuredEvent];
  if (command.payload.active) {
    events.push(
      buildHouseholdRestockTrigger({
        view,
        command,
        householdId: command.payload.householdId,
        materialKindKey: command.payload.materialKindKey,
        cadenceSeconds: command.payload.cadenceSeconds,
        sequence: configuredEvent.sequence + 1,
        causationId: configuredEvent.id,
        armedAtSequence: configuredEvent.sequence,
      }),
    );
  }
  return { ok: true, events };
}


// ---------------------------------------------------------------------------
// run_household_restock — trigger-dispatched, system principal only
// ---------------------------------------------------------------------------

export interface RunHouseholdRestockResolutionView extends HouseholdsBranchMeta {
  /** Undefined if no routine is configured for (householdId, materialKindKey). */
  routine?: HouseholdRestockRoutine;
  /**
   * Whether the alarm THIS command's own `command.payload.armedAtSequence`
   * names has not been retired by a later reconfigure (the staleness defense) —
   * the durable stand-in for "the routine's current arming", since routines
   * carry no arming column of their own. `false` fails closed as stale rather
   * than acting on a superseded arming.
   */
  armingIsLive: boolean;
  /** The stock lot's current state — undefined means uninitialized (zero). */
  stockLot?: MaterialLotState;
  /** `lot` funding only: the currency lot's current state — undefined means uninitialized (zero). */
  currencyLot?: MaterialLotState;
  /** `means_band_envelope` funding only: the household's own means read. */
  householdMeansRead?: MeansRead;
}

export type RunHouseholdRestockResolution =
  | HouseholdRejection<RunHouseholdRestockRejectionCode>
  | {
      ok: true;
      events: (
        | MaterialLotAdjustedEvent
        | HouseholdRestockFulfilledEvent
        | HouseholdRestockDeferredEvent
        | TriggerScheduledEvent
      )[];
      nextStockLot?: MaterialLotState;
      /** The sequence of the specific event that produced `nextStockLot` — set iff it is. */
      stockLotUpdatedAtSequence?: number;
      nextCurrencyLot?: MaterialLotState;
      /** The sequence of the specific event that produced `nextCurrencyLot` — set iff it is. */
      currencyLotUpdatedAtSequence?: number;
    };

/**
 * Fire-time re-validation (mirrors `resolveBodyThreshold`/
 * `resolveItemConditionThreshold`'s re-validate-then-act shape) — always
 * re-arms the next cycle regardless of outcome.
 */
export function resolveRunHouseholdRestockFromView(
  view: RunHouseholdRestockResolutionView,
  command: RunHouseholdRestockCommand,
): RunHouseholdRestockResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Restock resolves on the world's clock only.");
  }
  const routine = view.routine;
  if (!routine || !routine.active) return rejection("routine_not_found", "That restock routine is unavailable.");
  if (!view.armingIsLive) {
    return rejection("threshold_stale", "That restock cycle is no longer current.");
  }

  const { householdId, materialKindKey } = command.payload;
  const householdLocus: LotLocus = { kind: "household", householdId };
  const currentQuantityRaw = view.stockLot?.quantityRaw ?? 0;
  const quantityKind = view.stockLot?.quantityKind ?? resolveQuantityKind(materialKindKey);
  const stockRegistryVersion = view.stockLot?.registryVersion ?? materialKindRegistryVersion;

  const events: (
    | MaterialLotAdjustedEvent
    | HouseholdRestockFulfilledEvent
    | HouseholdRestockDeferredEvent
    | TriggerScheduledEvent
  )[] = [];
  let nextStockLot: MaterialLotState | undefined;
  let stockLotUpdatedAtSequence: number | undefined;
  let nextCurrencyLot: MaterialLotState | undefined;
  let currencyLotUpdatedAtSequence: number | undefined;
  let sequence = view.headSequence + 1;

  const pushDeferred = (reason: HouseholdRestockDeferredReason): HouseholdRestockDeferredEvent => {
    const event = householdRestockDeferredEventSchema.parse({
      ...eventEnvelope(view, command, sequence, "household-restock-deferred"),
      type: "household_restock_deferred",
      actorIds: [],
      entityIds: sortedUnique([householdId]),
      payload: { householdId, materialKindKey, reason },
    });
    events.push(event);
    sequence += 1;
    return event;
  };

  const pushFulfilled = (resultingQuantityRaw: number): HouseholdRestockFulfilledEvent => {
    const event = householdRestockFulfilledEventSchema.parse({
      ...eventEnvelope(view, command, sequence, "household-restock-fulfilled"),
      type: "household_restock_fulfilled",
      actorIds: [],
      entityIds: sortedUnique([householdId]),
      payload: { householdId, materialKindKey, resultingQuantityRaw },
    });
    events.push(event);
    sequence += 1;
    return event;
  };

  let terminalEvent: HouseholdRestockFulfilledEvent | HouseholdRestockDeferredEvent;

  if (currentQuantityRaw >= routine.targetQuantityRaw) {
    terminalEvent = pushDeferred("already_stocked");
  } else if (routine.funding.kind === "lot") {
    const neededRaw = routine.targetQuantityRaw - currentQuantityRaw;
    const cost = routine.funding.unitPriceRaw * neededRaw;
    const currencyBalance = view.currencyLot?.quantityRaw ?? 0;
    if (currencyBalance < cost) {
      terminalEvent = pushDeferred("insufficient_funds");
    } else {
      const currencyQuantityKind =
        view.currencyLot?.quantityKind ?? resolveQuantityKind(RESERVED_CURRENCY_MATERIAL_KIND);
      const currencyLocus = routine.funding.currencyLocus;
      const debitEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-debit"),
        type: "material_lot_adjusted",
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(currencyLocus)),
        payload: {
          locus: currencyLocus,
          materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
          deltaRaw: -cost,
          resultingQuantityRaw: currencyBalance - cost,
          quantityKind: currencyQuantityKind,
          reason: "restock_purchase",
        },
      });
      events.push(debitEvent);
      sequence += 1;
      nextCurrencyLot = materialLotStateSchema.parse({
        locus: currencyLocus,
        materialKindKey: RESERVED_CURRENCY_MATERIAL_KIND,
        quantityKind: currencyQuantityKind,
        quantityRaw: currencyBalance - cost,
        registryVersion: view.currencyLot?.registryVersion ?? materialKindRegistryVersion,
      });
      currencyLotUpdatedAtSequence = debitEvent.sequence;

      const creditEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-credit"),
        type: "material_lot_adjusted",
        causationId: debitEvent.id,
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(householdLocus)),
        payload: {
          locus: householdLocus,
          materialKindKey,
          deltaRaw: neededRaw,
          resultingQuantityRaw: routine.targetQuantityRaw,
          quantityKind,
          reason: "restock_purchase",
        },
      });
      events.push(creditEvent);
      sequence += 1;
      nextStockLot = materialLotStateSchema.parse({
        locus: householdLocus,
        materialKindKey,
        quantityKind,
        quantityRaw: routine.targetQuantityRaw,
        registryVersion: stockRegistryVersion,
      });
      stockLotUpdatedAtSequence = creditEvent.sequence;

      terminalEvent = pushFulfilled(routine.targetQuantityRaw);
    }
  } else {
    // means_band_envelope: fail closed unless the household's OWN means read
    // is band-tracked and at least at the routine's minimum band — a
    // lot-tracked or unknown read has no band to compare, so it cannot be
    // verified sufficient (structural precedence: this branch never consults a
    // lot even if one happens to exist for this subject).
    const read = view.householdMeansRead ?? { kind: "unknown" };
    const sufficient =
      read.kind === "band_tracked" && compareMeansBands(read.bandKey, routine.funding.minimumBandKey) >= 0;
    if (!sufficient) {
      terminalEvent = pushDeferred("insufficient_funds");
    } else {
      const creditEvent = materialLotAdjustedEventSchema.parse({
        ...eventEnvelope(view, command, sequence, "household-restock-credit"),
        type: "material_lot_adjusted",
        actorIds: [],
        entityIds: sortedUnique(lotLocusEntityIds(householdLocus)),
        payload: {
          locus: householdLocus,
          materialKindKey,
          deltaRaw: routine.targetQuantityRaw - currentQuantityRaw,
          resultingQuantityRaw: routine.targetQuantityRaw,
          quantityKind,
          reason: "restock_topup_unconserved",
        },
      });
      events.push(creditEvent);
      sequence += 1;
      nextStockLot = materialLotStateSchema.parse({
        locus: householdLocus,
        materialKindKey,
        quantityKind,
        quantityRaw: routine.targetQuantityRaw,
        registryVersion: stockRegistryVersion,
      });
      stockLotUpdatedAtSequence = creditEvent.sequence;

      terminalEvent = pushFulfilled(routine.targetQuantityRaw);
    }
  }

  // Re-arm the next cycle regardless of outcome — a deferred cycle keeps
  // trying.
  events.push(
    buildHouseholdRestockTrigger({
      view,
      command,
      householdId,
      materialKindKey,
      cadenceSeconds: routine.cadenceSeconds,
      sequence,
      causationId: terminalEvent.id,
      armedAtSequence: terminalEvent.sequence,
    }),
  );

  return {
    ok: true,
    events,
    ...(nextStockLot ? { nextStockLot, stockLotUpdatedAtSequence } : {}),
    ...(nextCurrencyLot ? { nextCurrencyLot, currencyLotUpdatedAtSequence } : {}),
  };
}
