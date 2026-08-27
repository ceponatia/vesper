import type { SimulationBranchEvent } from "../contracts/branching";
import type {
  BodyMeterDefinition,
  BodyMeterState,
  BodyModifier,
  BodySourceOperation,
  BodyThresholdDefinition,
} from "../contracts/bodies";
import { composeSimulationId } from "../contracts/identity";
import type { ItemLocus } from "../contracts/materials";
import {
  itemConditionInitializedEventSchema,
  itemConditionMeterStateSchema,
  itemConditionModifierSchema,
  itemConditionModifierAppliedEventSchema,
  itemConditionModifierEndedEventSchema,
  itemConditionRegistryByVersion,
  itemConditionRegistryVersion,
  itemConditionSourceAppliedEventSchema,
  itemConditionThresholdCrossedEventSchema,
  itemConditionsProjectionSchema,
  type ApplyItemConditionSourceCommand,
  type ApplyItemConditionSourceRejectionCode,
  type ItemConditionInitializedEvent,
  type ItemConditionIntegrationDerivation,
  type ItemConditionModifier,
  type ItemConditionModifierAppliedEvent,
  type ItemConditionModifierEndedEvent,
  type ItemConditionMeterState,
  type ItemConditionRegistryVersion,
  type ItemConditionSourceAppliedEvent,
  type ItemConditionSourceKind,
  type ItemConditionThresholdCrossedEvent,
  type ItemConditionsProjection,
  type ResolveItemConditionThresholdCommand,
  type ResolveItemConditionThresholdRejectionCode,
} from "../contracts/material-condition";
import {
  itemConditionThresholdTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "../contracts/scheduler";
import {
  integrateMeterValue,
  modifiersLiveAt,
  solveNextThresholdCrossing,
  thresholdCrossed,
  type BodyBranchMeta,
  type BodyEventCommandContext,
  type MeterIntegrationView,
} from "./bodies";
import {
  containerAccessAllowed,
  resolveRootLocus,
  rootZoneId,
  type MaterialResolutionView,
} from "./material-locus";
import { compareStableText, simulationHash } from "./hash";

/**
 * E5.3 slice 3 — the pure item-condition kernel. Wear and
 * cleanliness ride the SAME fixed-point machinery bodies use — this file
 * reuses `integrateMeterValue`, `solveNextThresholdCrossing`,
 * `modifiersLiveAt`, and `thresholdCrossed` from `./bodies` AS-IS rather than
 * reimplementing analytic drift or threshold search. Those functions are
 * subject-agnostic: none of them ever reads an `actorId` off the state or
 * modifier rows they're given. `MeterIntegrationView.state`/`.modifiers` are
 * still typed against the body shapes (`BodyMeterState`/`BodyModifier`), so
 * `toMeterIntegrationView` below builds a structurally-identical shim (an
 * item's id standing in for the unused actor slot) purely to satisfy that
 * signature — the shim is discarded immediately after the call, never
 * persisted or returned.
 */

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * Mirrors `deriveBodyModifierId`: the upstream id may itself be derived
 * (a worn-window modifier's id is derived from a transfer command id), so the
 * variable-length part is hash-compacted rather than concatenated (the E3.5
 * compact-id lesson — see `deriveBodyConditionId`).
 */
export function deriveItemConditionModifierId(
  branchId: string,
  commandOrEventId: string,
  ordinal: number,
): string {
  return composeSimulationId("item-condition-modifier", [
    branchId,
    simulationHash({ commandOrEventId }),
    String(ordinal),
  ]);
}

/**
 * Versioned by `armedAtSequence` (mirrors `bodyThresholdUniquenessKey`): each
 * re-arm is a distinct alarm, which is what makes `resolve_item_condition_
 * threshold`'s fire-time staleness check exact — a re-arm produced by a later
 * material write retires the earlier alarm's uniqueness key implicitly by
 * never matching it again.
 */
export function itemConditionThresholdUniquenessKey(
  itemId: string,
  meterKey: string,
  thresholdKey: string,
  armedAtSequence: number,
): string {
  return composeSimulationId("item-condition-threshold", [
    itemId,
    meterKey,
    thresholdKey,
    String(armedAtSequence),
  ]);
}

/** Prefix matching every armed threshold alarm for one item + meter, any threshold key or arming sequence. */
export function itemConditionThresholdUniquenessKeyPrefix(itemId: string, meterKey: string): string {
  return `${composeSimulationId("item-condition-threshold", [itemId, meterKey])}:`;
}

// ---------------------------------------------------------------------------
// Views over the body-kernel shapes (reuse, never reimplement)
// ---------------------------------------------------------------------------

/** One item's condition state: its meters and every live-or-not modifier row. */
export interface ItemConditionView {
  itemId: string;
  registryVersion: ItemConditionRegistryVersion;
  meters: readonly ItemConditionMeterState[];
  modifiers: readonly ItemConditionModifier[];
}

/**
 * Build the body-shaped `MeterIntegrationView` `integrateMeterValue` and
 * `solveNextThresholdCrossing` require, from item-condition-shaped state.
 * `actorId`/`registryVersion` on the shim are never read by either function —
 * they exist solely so the object satisfies `BodyMeterState`'s/`BodyModifier`'s
 * required fields.
 */
function toMeterIntegrationView(
  definition: BodyMeterDefinition,
  state: ItemConditionMeterState,
  modifiers: readonly ItemConditionModifier[],
): MeterIntegrationView {
  return {
    definition,
    state: {
      actorId: state.itemId,
      meterKey: state.meterKey,
      valueFixedPoint: state.valueFixedPoint,
      baselineFixedPoint: state.baselineFixedPoint,
      lastIntegratedAtStorySecond: state.lastIntegratedAtStorySecond,
      registryVersion: state.registryVersion,
    } as unknown as BodyMeterState,
    modifiers: modifiers.map(
      (modifier) =>
        ({
          id: modifier.id,
          actorId: modifier.itemId,
          meterKey: modifier.meterKey,
          operation: modifier.operation,
          stackingGroup: modifier.stackingGroup,
          priority: modifier.priority,
          validFromStorySecond: modifier.validFromStorySecond,
          validUntilStorySecond: modifier.validUntilStorySecond,
          visibility: modifier.visibility,
          sourceEventId: modifier.sourceEventId,
        }) as unknown as BodyModifier,
    ),
  };
}

/** The definition + state + this-meter's-only modifiers for one item's meter, or undefined if unknown. */
export function meterViewOfItem(view: ItemConditionView, meterKey: string): MeterIntegrationView | undefined {
  const definition = itemConditionRegistryByVersion[view.registryVersion]?.find(
    (candidate) => candidate.key === meterKey,
  );
  const state = view.meters.find((candidate) => candidate.meterKey === meterKey);
  if (!definition || !state) return undefined;
  const modifiers = view.modifiers.filter((modifier) => modifier.meterKey === meterKey);
  return toMeterIntegrationView(definition, state, modifiers);
}

function itemConditionCapturedDerivation(
  meterView: MeterIntegrationView,
  atStorySecond: number,
): ItemConditionIntegrationDerivation {
  return {
    fromValueFixedPoint: meterView.state.valueFixedPoint,
    fromStorySecond: meterView.state.lastIntegratedAtStorySecond,
    activeModifierIds: modifiersLiveAt(meterView.modifiers, atStorySecond)
      .map((modifier) => modifier.id)
      .sort(compareStableText),
    registryVersion: itemConditionRegistryVersion,
  } as unknown as ItemConditionIntegrationDerivation;
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing (mirrors bodies.ts)
// ---------------------------------------------------------------------------

interface ItemConditionRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

function rejection<TCode extends string>(code: TCode, publicReason: string): ItemConditionRejection<TCode> {
  return { ok: false, code, publicReason };
}

function eventEnvelope(
  view: BodyBranchMeta,
  command: BodyEventCommandContext,
  sequence: number,
  suffix: string,
) {
  return {
    id: composeSimulationId("event", [view.branchId, command.id, suffix]),
    worldId: view.worldId,
    branchId: view.branchId,
    sequence,
    storySecond: view.storySecond,
    schemaVersion: 1,
    rulesetVersion: view.rulesetVersion,
    derivationVersion: itemConditionRegistryVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
  };
}

/** Re-solve one item meter's alarm after a material write at `view.storySecond`. */
function rearmItemConditionThresholdTrigger(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  meterView: MeterIntegrationView;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent | undefined {
  const crossing = solveNextThresholdCrossing(input.meterView, input.view.storySecond);
  if (!crossing) return undefined;
  const meterKey = input.meterView.definition.key;
  const uniquenessKey = itemConditionThresholdUniquenessKey(
    input.itemId,
    meterKey,
    crossing.threshold.key,
    input.armedAtSequence,
  );
  const templateId = composeSimulationId("template", [uniquenessKey]);
  return triggerScheduledEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, `arm-item-threshold-${meterKey}`),
    type: "trigger_scheduled",
    derivationVersion: schedulerDerivationVersion,
    causationId: input.causationId,
    actorIds: [],
    entityIds: [input.itemId],
    payload: {
      kind: itemConditionThresholdTriggerKind,
      triggerSchemaVersion: 1,
      dueStorySecond: crossing.crossesAtStorySecond,
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
        type: "resolve_item_condition_threshold",
        payload: {
          itemId: input.itemId,
          meterKey,
          thresholdKey: crossing.threshold.key,
          armedAtSequence: input.armedAtSequence,
        },
      },
    },
  });
}

function sourceValueAfter(
  operation: BodySourceOperation,
  integrated: number,
  baselineFixedPoint: number,
): number {
  switch (operation.kind) {
    case "set":
      return operation.valueFixedPoint;
    case "add":
      return Math.max(0, Math.min(10_000, integrated + operation.deltaFixedPoint));
    case "reset_to_baseline":
      return baselineFixedPoint;
  }
}

function buildItemConditionSourceEvent(args: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  meterKey: string;
  sourceKind: ItemConditionSourceKind;
  operation: BodySourceOperation;
  meterView: MeterIntegrationView;
  sequence: number;
  suffix: string;
  causationId?: string;
}): { event: ItemConditionSourceAppliedEvent; nextState: ItemConditionMeterState; integratedBeforeFixedPoint: number } {
  const integrated = integrateMeterValue(args.meterView, args.view.storySecond);
  const valueAfter = sourceValueAfter(args.operation, integrated, args.meterView.state.baselineFixedPoint);

  const event = itemConditionSourceAppliedEventSchema.parse({
    ...eventEnvelope(args.view, args.command, args.sequence, args.suffix),
    type: "item_condition_source_applied",
    ...(args.causationId === undefined ? {} : { causationId: args.causationId }),
    actorIds: [],
    entityIds: [args.itemId],
    payload: {
      itemId: args.itemId,
      meterKey: args.meterKey,
      sourceKind: args.sourceKind,
      operation: args.operation,
      valueAfterFixedPoint: valueAfter,
      derived: itemConditionCapturedDerivation(args.meterView, args.view.storySecond),
    },
  });

  const nextState = itemConditionMeterStateSchema.parse({
    itemId: args.itemId,
    meterKey: args.meterKey,
    valueFixedPoint: valueAfter,
    baselineFixedPoint: args.meterView.state.baselineFixedPoint,
    lastIntegratedAtStorySecond: args.view.storySecond,
    registryVersion: itemConditionRegistryVersion,
  });

  return { event, nextState, integratedBeforeFixedPoint: integrated };
}

/**
 * Thresholds THIS write itself carried the value across (before/after,
 * excluding a boundary already crossed prior to this write). Necessary
 * because `solveNextThresholdCrossing` only ever solves a FUTURE crossing
 * via analytic drift — for a `driftLaw: "none"` meter (wear) there is no
 * drift to solve, so its `worn_out` threshold can NEVER be armed through the
 * scheduled-alarm path the meter kernel gives `cleanliness`; a discrete delta
 * is the only thing that ever moves it, so the crossing must be detected
 * synchronously, right here, or it can never fire at all.
 */
function instantlyCrossedThresholds(
  definition: BodyMeterDefinition,
  beforeValueFixedPoint: number,
  afterValueFixedPoint: number,
): BodyThresholdDefinition[] {
  return definition.thresholds.filter(
    (threshold) =>
      !thresholdCrossed(threshold, beforeValueFixedPoint) && thresholdCrossed(threshold, afterValueFixedPoint),
  );
}

function buildInstantThresholdCrossedEvent(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  meterView: MeterIntegrationView;
  threshold: BodyThresholdDefinition;
  valueFixedPoint: number;
  coLocatedActorIds: readonly string[];
  sequence: number;
  causationId: string;
}): ItemConditionThresholdCrossedEvent {
  const observerActorIds = input.threshold.noticeable
    ? [...new Set(input.coLocatedActorIds)].sort(compareStableText)
    : [];
  return itemConditionThresholdCrossedEventSchema.parse({
    ...eventEnvelope(
      input.view,
      input.command,
      input.sequence,
      `item-condition-threshold-instant-${input.meterView.definition.key}`,
    ),
    type: "item_condition_threshold_crossed",
    causationId: input.causationId,
    actorIds: [],
    entityIds: [input.itemId],
    payload: {
      itemId: input.itemId,
      meterKey: input.meterView.definition.key,
      thresholdKey: input.threshold.key,
      direction: input.threshold.direction,
      boundaryFixedPoint: input.threshold.boundaryFixedPoint,
      valueFixedPoint: input.valueFixedPoint,
      observerActorIds,
      derived: itemConditionCapturedDerivation(input.meterView, input.view.storySecond),
    },
  });
}

/**
 * Build every instantly-crossed threshold event for one source write, in
 * registry-declared order, with a running sequence counter — shared by
 * `resolveApplyItemConditionSource` and `buildUseConditionDeltas` so both
 * source-application entry points detect instant crossings identically.
 */
function buildInstantCrossingEvents(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  meterView: MeterIntegrationView;
  beforeValueFixedPoint: number;
  afterValueFixedPoint: number;
  coLocatedActorIds: readonly string[];
  causationId: string;
  startSequence: number;
}): { events: ItemConditionThresholdCrossedEvent[]; nextSequence: number } {
  const crossed = instantlyCrossedThresholds(
    input.meterView.definition,
    input.beforeValueFixedPoint,
    input.afterValueFixedPoint,
  );
  const events: ItemConditionThresholdCrossedEvent[] = [];
  let sequence = input.startSequence;
  for (const threshold of crossed) {
    events.push(
      buildInstantThresholdCrossedEvent({
        view: input.view,
        command: input.command,
        itemId: input.itemId,
        meterView: input.meterView,
        threshold,
        valueFixedPoint: input.afterValueFixedPoint,
        coLocatedActorIds: input.coLocatedActorIds,
        sequence,
        causationId: input.causationId,
      }),
    );
    sequence += 1;
  }
  return { events, nextSequence: sequence };
}

// ---------------------------------------------------------------------------
// Initialization (lazy: a store calls this the first time a tracked item's
// condition state is needed — there is no dedicated command)
// ---------------------------------------------------------------------------

export function initialConditionMetersFor(input: {
  itemId: string;
  atStorySecond: number;
  registryVersion?: ItemConditionRegistryVersion;
}): ItemConditionMeterState[] {
  const registryVersion = input.registryVersion ?? itemConditionRegistryVersion;
  const registry = itemConditionRegistryByVersion[registryVersion];
  return registry.map((definition) =>
    itemConditionMeterStateSchema.parse({
      itemId: input.itemId,
      meterKey: definition.key,
      valueFixedPoint: definition.initialFixedPoint,
      baselineFixedPoint: definition.baselineFixedPoint,
      lastIntegratedAtStorySecond: input.atStorySecond,
      registryVersion,
    }),
  );
}

export function buildItemConditionInitializedEvent(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  meters: readonly ItemConditionMeterState[];
  sequence: number;
  registryVersion?: ItemConditionRegistryVersion;
  causationId?: string;
}): ItemConditionInitializedEvent {
  const registryVersion = input.registryVersion ?? itemConditionRegistryVersion;
  return itemConditionInitializedEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, `item-condition-initialized-${input.itemId}`),
    type: "item_condition_initialized",
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    actorIds: [],
    entityIds: [input.itemId],
    payload: {
      itemId: input.itemId,
      registryVersion,
      meters: input.meters.map((meter) => ({
        meterKey: meter.meterKey,
        valueFixedPoint: meter.valueFixedPoint,
        baselineFixedPoint: meter.baselineFixedPoint,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// ApplyItemConditionSource (an actor cleans/adjusts a tracked item they can reach)
// ---------------------------------------------------------------------------

export interface ItemConditionResolutionView extends BodyBranchMeta {
  /** Absent means the item is not condition-tracked (or its state doesn't exist yet). */
  condition?: ItemConditionView;
  /**
   * Co-located witnesses, captured by the store, for an instantly-crossed
   * noticeable threshold (the capture idiom). Defaults to none — a store
   * that doesn't supply it simply witnesses nothing, never wrongly.
   */
  coLocatedActorIds?: readonly string[];
}

export interface ApplyItemConditionSourceResolution {
  ok: true;
  meter: ItemConditionMeterState;
  events: [ItemConditionSourceAppliedEvent, ...(ItemConditionThresholdCrossedEvent | TriggerScheduledEvent)[]];
}

/**
 * Pure resolver for `apply_item_condition_source`. Validation reuses the
 * source-side subset of transfer law exactly as `consume_item` does
 * (`resolveConsumeItemFromView` in `./materials.ts`): reach without an
 * asserted source locus, so no staleness check, plus the item-condition-
 * specific `condition_not_tracked`/`unknown_meter_key` pair.
 */
export function resolveApplyItemConditionSource(
  view: ItemConditionResolutionView,
  command: ApplyItemConditionSourceCommand,
  materialView: MaterialResolutionView,
): ItemConditionRejection<ApplyItemConditionSourceRejectionCode> | ApplyItemConditionSourceResolution {
  const { actorId, itemId, sourceKind, meterKey, operation } = command.payload;

  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!materialView.actorById(actorId)) return rejection("actor_not_found", "That actor is unavailable.");
  if (!command.principal.controlledActorIds.includes(actorId)) {
    return rejection("unauthorized_actor", "You cannot direct that actor.");
  }
  const actorZoneId = materialView.actorZoneId(actorId);
  if (actorZoneId === null) {
    return rejection("actor_not_embodied", "They are not anywhere they can do that.");
  }
  const item = materialView.itemById(itemId);
  if (!item) return rejection("item_not_found", "That item is unavailable.");
  if (item.locus.kind === "gone") return rejection("item_gone", "That item is gone.");
  if (!view.condition) return rejection("condition_not_tracked", "That item's condition is not tracked.");
  const meterView = meterViewOfItem(view.condition, meterKey);
  if (!meterView) return rejection("unknown_meter_key", "That item condition meter is unknown.");

  const root = resolveRootLocus(item.locus, materialView.itemById);
  if (rootZoneId(root, materialView) !== actorZoneId) {
    return rejection("root_not_colocated", "That item is not within reach.");
  }
  if (root.kind === "actor" && root.actorId !== actorId) {
    return item.locus.kind === "worn"
      ? rejection("worn_by_other", "That is worn by someone else.")
      : rejection("held_by_other", "That is in someone else's keeping.");
  }
  if (item.locus.kind === "container" && !containerAccessAllowed(materialView, item.locus.containerItemId, actorId)) {
    return rejection("container_access_denied", "That container is closed to them.");
  }
  if (materialView.reservingActivityId(itemId) !== null) {
    return rejection("item_reserved", "That is reserved for something else right now.");
  }

  const { event, nextState, integratedBeforeFixedPoint } = buildItemConditionSourceEvent({
    view,
    command,
    itemId,
    meterKey,
    sourceKind,
    operation,
    meterView,
    sequence: view.headSequence + 1,
    suffix: "item-condition-source",
  });

  const instant = buildInstantCrossingEvents({
    view,
    command,
    itemId,
    meterView,
    beforeValueFixedPoint: integratedBeforeFixedPoint,
    afterValueFixedPoint: nextState.valueFixedPoint,
    coLocatedActorIds: view.coLocatedActorIds ?? [],
    causationId: event.id,
    startSequence: event.sequence + 1,
  });

  const modifiersForMeter = view.condition.modifiers.filter((modifier) => modifier.meterKey === meterKey);
  const rearm = rearmItemConditionThresholdTrigger({
    view,
    command,
    itemId,
    meterView: toMeterIntegrationView(meterView.definition, nextState, modifiersForMeter),
    sequence: instant.nextSequence,
    causationId: event.id,
    armedAtSequence: event.sequence,
  });

  return {
    ok: true,
    meter: nextState,
    events: [event, ...instant.events, ...(rearm ? [rearm] : [])],
  };
}

// ---------------------------------------------------------------------------
// Worn-window transition (a transfer that dons/doffs a tracked item)
// ---------------------------------------------------------------------------

export const WORN_WINDOW_STACKING_GROUP = "worn-window" as const;

/**
 * The worn-window cleanliness modifier's rate — wearing applies a standard
 * negative rate_add modifier for the worn window, so a garment fouls only
 * while worn. It is signed POSITIVE here, not negative:
 * cleanliness's registry law targets 0 (fully soiled) at a zero base rate, so
 * composing a POSITIVE rate_add turns the drift into genuine approach-mode
 * decay toward that target. A target equal to the meter's own fresh value
 * (10 000) — the naive reading of "negative rate toward a fixed-10 000
 * target" — is inert under `integrateMeterValue`'s approach/flee mechanics:
 * "approach" stops the instant it reaches the target (nowhere left to go from
 * a standing start already there), and "flee" ties toward the ceiling when
 * value === target, so neither reading can ever move a fresh item at all. See
 * the registry doc comment in `@/contracts/simulation/material-condition`.
 * Net effect: (10 000 − 3 000) ÷ 250 = 28 — grimy from fresh in ~28
 * worn-hours.
 */
export const WORN_WINDOW_CLEANLINESS_RATE_ADD_FIXED_POINT = 250 as const;

function isWornLocus(locus: ItemLocus): boolean {
  return locus.kind === "worn";
}

export interface WornWindowTransitionResult {
  events: (ItemConditionModifierAppliedEvent | ItemConditionModifierEndedEvent | TriggerScheduledEvent)[];
  nextSequence: number;
}

/**
 * Given an `item_transferred` move whose from/to loci differ in worn-ness for
 * a condition-tracked item: donning applies the worn-window modifier, doffing
 * ends the live one — either way followed by cleanliness's threshold re-arm.
 * Untracked items (`condition` absent) and non-worn-ness-changing moves both
 * emit nothing. The caller (`resolveTransferItemFromView`) supplies the
 * event's own id as `causationId` and a running sequence counter.
 */
export function buildWornWindowTransition(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  itemId: string;
  fromLocus: ItemLocus;
  toLocus: ItemLocus;
  condition?: ItemConditionView;
  causationId: string;
  startSequence: number;
}): WornWindowTransitionResult {
  const noop = { events: [], nextSequence: input.startSequence };
  if (!input.condition) return noop;
  const wasWorn = isWornLocus(input.fromLocus);
  const isWorn = isWornLocus(input.toLocus);
  if (wasWorn === isWorn) return noop;

  const definition = itemConditionRegistryByVersion[input.condition.registryVersion]?.find(
    (candidate) => candidate.key === "cleanliness",
  );
  const rawState = input.condition.meters.find((candidate) => candidate.meterKey === "cleanliness");
  if (!definition || !rawState) return noop;
  const cleanlinessModifiers = input.condition.modifiers.filter(
    (modifier) => modifier.meterKey === "cleanliness",
  );

  const events: (ItemConditionModifierAppliedEvent | ItemConditionModifierEndedEvent | TriggerScheduledEvent)[] =
    [];
  let sequence = input.startSequence;
  let modifiersAfter = cleanlinessModifiers;

  if (isWorn) {
    const modifierId = deriveItemConditionModifierId(input.view.branchId, input.command.id, 0);
    const sourceEventId = composeSimulationId("event", [
      input.view.branchId,
      input.command.id,
      "worn-window-modifier",
    ]);
    const modifier = itemConditionModifierSchema.parse({
      id: modifierId,
      itemId: input.itemId,
      meterKey: "cleanliness",
      operation: {
        kind: "rate_add",
        ratePerHourFixedPoint: WORN_WINDOW_CLEANLINESS_RATE_ADD_FIXED_POINT,
      },
      stackingGroup: WORN_WINDOW_STACKING_GROUP,
      priority: 0,
      validFromStorySecond: input.view.storySecond,
      visibility: "obvious",
      sourceEventId,
    });
    events.push(
      itemConditionModifierAppliedEventSchema.parse({
        ...eventEnvelope(input.view, input.command, sequence, "worn-window-modifier-applied"),
        type: "item_condition_modifier_applied",
        causationId: input.causationId,
        actorIds: [],
        entityIds: [input.itemId],
        payload: { itemId: input.itemId, modifier },
      }),
    );
    sequence += 1;
    modifiersAfter = [...cleanlinessModifiers, modifier];
  } else {
    const live = cleanlinessModifiers.find(
      (modifier) =>
        modifier.stackingGroup === WORN_WINDOW_STACKING_GROUP &&
        modifier.validFromStorySecond <= input.view.storySecond &&
        (modifier.validUntilStorySecond === undefined ||
          input.view.storySecond < modifier.validUntilStorySecond),
    );
    if (live) {
      events.push(
        itemConditionModifierEndedEventSchema.parse({
          ...eventEnvelope(input.view, input.command, sequence, "worn-window-modifier-ended"),
          type: "item_condition_modifier_ended",
          causationId: input.causationId,
          actorIds: [],
          entityIds: [input.itemId],
          payload: { itemId: input.itemId, modifierId: live.id, basis: "doffed" },
        }),
      );
      sequence += 1;
      const validUntilStorySecond = Math.max(input.view.storySecond, live.validFromStorySecond + 1);
      modifiersAfter = cleanlinessModifiers.map((modifier) =>
        modifier.id === live.id
          ? itemConditionModifierSchema.parse({ ...modifier, validUntilStorySecond })
          : modifier,
      );
    }
  }

  if (events.length === 0) return noop;
  const causingEvent = events[0];
  if (!causingEvent) return noop;

  const rearm = rearmItemConditionThresholdTrigger({
    view: input.view,
    command: input.command,
    itemId: input.itemId,
    meterView: toMeterIntegrationView(definition, rawState, modifiersAfter),
    sequence,
    causationId: causingEvent.id,
    armedAtSequence: causingEvent.sequence,
  });
  if (rearm) {
    events.push(rearm);
    sequence += 1;
  }
  return { events, nextSequence: sequence };
}

// ---------------------------------------------------------------------------
// Use-disposition condition deltas (completion path)
// ---------------------------------------------------------------------------

export interface UseConditionDeltaInput {
  meterKey: string;
  deltaFixedPoint: number;
}

export interface UseConditionDeltaItem {
  itemId: string;
  condition: ItemConditionView;
  deltas: readonly UseConditionDeltaInput[];
}

export interface UseConditionDeltasResult {
  events: (ItemConditionSourceAppliedEvent | ItemConditionThresholdCrossedEvent | TriggerScheduledEvent)[];
  meterUpdates: ItemConditionMeterState[];
  nextSequence: number;
}

/**
 * Build the trailing `item_condition_source_applied` (sourceKind "use")
 * events for every use-disposition reserved TRACKED item's authored
 * `useConditionDeltas`, causation-chained to the completion's own event with
 * one running sequence counter (the `buildConsumptionBodyEffects` precedent
 * in `./materials.ts`). Untracked items simply never appear in `input.items`
 * — the caller (`resolveCompleteActivity`) filters for `conditionTracked`.
 * `wear`'s `driftLaw: "none"` means it can never be armed through
 * `solveNextThresholdCrossing` (no drift, no future crossing to solve) — a
 * delta that carries it across `worn_out` is detected synchronously here via
 * `buildInstantCrossingEvents`, the only way that threshold can ever fire.
 */
export function buildUseConditionDeltas(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  items: readonly UseConditionDeltaItem[];
  causationEventId: string;
  startSequence: number;
  /** Co-located witnesses, captured by the store, for an instantly-crossed noticeable threshold. */
  coLocatedActorIds?: readonly string[];
}): UseConditionDeltasResult {
  const events: (ItemConditionSourceAppliedEvent | ItemConditionThresholdCrossedEvent | TriggerScheduledEvent)[] =
    [];
  const meterUpdates: ItemConditionMeterState[] = [];
  let sequence = input.startSequence;

  for (const item of input.items) {
    for (const [index, delta] of item.deltas.entries()) {
      const meterView = meterViewOfItem(item.condition, delta.meterKey);
      // Defensive only: authored data always names a registered meter key.
      if (!meterView) continue;
      const { event, nextState, integratedBeforeFixedPoint } = buildItemConditionSourceEvent({
        view: input.view,
        command: input.command,
        itemId: item.itemId,
        meterKey: delta.meterKey,
        sourceKind: "use",
        operation: { kind: "add", deltaFixedPoint: delta.deltaFixedPoint },
        meterView,
        sequence,
        suffix: `item-condition-use-${item.itemId}-${index}`,
        causationId: input.causationEventId,
      });
      events.push(event);
      meterUpdates.push(nextState);
      sequence = event.sequence + 1;

      const instant = buildInstantCrossingEvents({
        view: input.view,
        command: input.command,
        itemId: item.itemId,
        meterView,
        beforeValueFixedPoint: integratedBeforeFixedPoint,
        afterValueFixedPoint: nextState.valueFixedPoint,
        coLocatedActorIds: input.coLocatedActorIds ?? [],
        causationId: event.id,
        startSequence: sequence,
      });
      events.push(...instant.events);
      sequence = instant.nextSequence;

      const modifiersForMeter = item.condition.modifiers.filter(
        (modifier) => modifier.meterKey === delta.meterKey,
      );
      const rearm = rearmItemConditionThresholdTrigger({
        view: input.view,
        command: input.command,
        itemId: item.itemId,
        meterView: toMeterIntegrationView(meterView.definition, nextState, modifiersForMeter),
        sequence,
        causationId: event.id,
        armedAtSequence: event.sequence,
      });
      if (rearm) {
        events.push(rearm);
        sequence += 1;
      }
    }
  }
  return { events, meterUpdates, nextSequence: sequence };
}

// ---------------------------------------------------------------------------
// ResolveItemConditionThreshold (trigger-dispatched; fire-time re-validated)
// ---------------------------------------------------------------------------

export interface ItemConditionThresholdResolutionView extends BodyBranchMeta {
  condition?: ItemConditionView;
  /** Co-located witnesses, captured by the store for noticeable thresholds. */
  coLocatedActorIds: readonly string[];
}

export interface ItemConditionThresholdResolution {
  ok: true;
  meter: ItemConditionMeterState;
  events: [ItemConditionThresholdCrossedEvent, ...TriggerScheduledEvent[]];
}

/** Mirrors `resolveBodyThreshold`: re-validate against the kernel's own integration, staleness fails closed. */
export function resolveItemConditionThreshold(
  view: ItemConditionThresholdResolutionView,
  command: ResolveItemConditionThresholdCommand,
): ItemConditionRejection<ResolveItemConditionThresholdRejectionCode> | ItemConditionThresholdResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Item limits resolve on the world's clock only.");
  }
  if (!view.condition) return rejection("condition_not_tracked", "That item's condition is not tracked.");
  const meterView = meterViewOfItem(view.condition, command.payload.meterKey);
  if (!meterView) return rejection("unknown_meter_key", "That item condition meter is unknown.");
  const threshold = meterView.definition.thresholds.find(
    (candidate) => candidate.key === command.payload.thresholdKey,
  );
  if (!threshold) return rejection("unknown_threshold_key", "That item limit is unknown.");

  const valueNow = integrateMeterValue(meterView, view.storySecond);
  if (!thresholdCrossed(threshold, valueNow)) {
    return rejection("threshold_stale", "That limit is no longer being crossed.");
  }

  const observerActorIds = threshold.noticeable
    ? [...new Set(view.coLocatedActorIds)].sort(compareStableText)
    : [];
  const crossedEvent = itemConditionThresholdCrossedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "item-condition-threshold"),
    type: "item_condition_threshold_crossed",
    actorIds: [],
    entityIds: [command.payload.itemId],
    payload: {
      itemId: command.payload.itemId,
      meterKey: command.payload.meterKey,
      thresholdKey: threshold.key,
      direction: threshold.direction,
      boundaryFixedPoint: threshold.boundaryFixedPoint,
      valueFixedPoint: valueNow,
      observerActorIds,
      derived: itemConditionCapturedDerivation(meterView, view.storySecond),
    },
  });

  const nextState = itemConditionMeterStateSchema.parse({
    itemId: command.payload.itemId,
    meterKey: command.payload.meterKey,
    valueFixedPoint: valueNow,
    baselineFixedPoint: meterView.state.baselineFixedPoint,
    lastIntegratedAtStorySecond: view.storySecond,
    registryVersion: view.condition.registryVersion,
  });

  const modifiersForMeter = view.condition.modifiers.filter(
    (modifier) => modifier.meterKey === command.payload.meterKey,
  );
  const rearm = rearmItemConditionThresholdTrigger({
    view,
    command,
    itemId: command.payload.itemId,
    meterView: toMeterIntegrationView(meterView.definition, nextState, modifiersForMeter),
    sequence: crossedEvent.sequence + 1,
    causationId: crossedEvent.id,
    armedAtSequence: crossedEvent.sequence,
  });

  return { ok: true, meter: nextState, events: rearm ? [crossedEvent, rearm] : [crossedEvent] };
}

// ---------------------------------------------------------------------------
// Projection: projector, replay, seed
// ---------------------------------------------------------------------------

export function sortItemConditionsProjection(projection: ItemConditionsProjection): ItemConditionsProjection {
  return itemConditionsProjectionSchema.parse({
    ...projection,
    meters: [...projection.meters].sort(
      (left, right) =>
        compareStableText(left.itemId, right.itemId) || compareStableText(left.meterKey, right.meterKey),
    ),
    modifiers: [...projection.modifiers].sort((left, right) => compareStableText(left.id, right.id)),
  });
}

function replaceItemMeter(
  meters: readonly ItemConditionMeterState[],
  itemId: string,
  meterKey: string,
  eventType: string,
  valueFixedPoint: number,
  storySecond: number,
): ItemConditionMeterState[] {
  const existing = meters.find((candidate) => candidate.itemId === itemId && candidate.meterKey === meterKey);
  if (!existing) throw new Error(`${eventType} replay references a missing item condition meter`);
  const next = itemConditionMeterStateSchema.parse({
    ...existing,
    valueFixedPoint,
    lastIntegratedAtStorySecond: storySecond,
  });
  return meters.map((candidate) =>
    candidate.itemId === itemId && candidate.meterKey === meterKey ? next : candidate,
  );
}

/** Pure synchronous projector for the item-condition event family. */
export function applyItemConditionEvent(
  projection: ItemConditionsProjection,
  event: SimulationBranchEvent,
): ItemConditionsProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "item_condition_initialized": {
      const meters = event.payload.meters.map((meter) =>
        itemConditionMeterStateSchema.parse({
          itemId: event.payload.itemId,
          meterKey: meter.meterKey,
          valueFixedPoint: meter.valueFixedPoint,
          baselineFixedPoint: meter.baselineFixedPoint,
          lastIntegratedAtStorySecond: event.storySecond,
          registryVersion: event.payload.registryVersion,
        }),
      );
      return sortItemConditionsProjection({ ...bumped, meters: [...projection.meters, ...meters] });
    }
    case "item_condition_source_applied":
      return sortItemConditionsProjection({
        ...bumped,
        meters: replaceItemMeter(
          projection.meters,
          event.payload.itemId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAfterFixedPoint,
          event.storySecond,
        ),
      });
    case "item_condition_modifier_applied":
      // No meter-value boundary write here (the payload carries none, unlike
      // bodies' flattened body_modifier_applied): integrateMeterValue folds
      // this modifier's validFrom purely at the next query regardless, so
      // omitting the write is exact, not an approximation.
      return sortItemConditionsProjection({
        ...bumped,
        modifiers: [...projection.modifiers, event.payload.modifier],
      });
    case "item_condition_modifier_ended": {
      const existing = projection.modifiers.find((candidate) => candidate.id === event.payload.modifierId);
      if (!existing) throw new Error("item_condition_modifier_ended replay references a missing modifier");
      const ended = itemConditionModifierSchema.parse({
        ...existing,
        validUntilStorySecond: Math.max(event.storySecond, existing.validFromStorySecond + 1),
      });
      return sortItemConditionsProjection({
        ...bumped,
        modifiers: projection.modifiers.map((modifier) => (modifier.id === ended.id ? ended : modifier)),
      });
    }
    case "item_condition_threshold_crossed":
      return sortItemConditionsProjection({
        ...bumped,
        meters: replaceItemMeter(
          projection.meters,
          event.payload.itemId,
          event.payload.meterKey,
          event.type,
          event.payload.valueFixedPoint,
          event.storySecond,
        ),
      });
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
    case "household_created":
    case "household_membership_set":
    case "material_lot_initialized":
    case "material_lot_adjusted":
    case "material_lot_transferred":
    case "means_band_set":
    case "household_restock_routine_configured":
    case "item_instantiated_from_promotion":
    case "household_restock_fulfilled":
    case "household_restock_deferred":
    case "relationship_entry_authored":
    case "relationship_change_recorded":
    case "consent_escalation_resolved":
    case "pressure_acknowledged":
    case "actor_lod_assigned":
    case "routine_policy_resolved":
    case "cohort_created":
    case "cohort_adjusted":
    case "actor_materialized_from_aggregate":
      // Non-item-condition families advance the boundary without touching this projection.
      return itemConditionsProjectionSchema.parse(bumped);
  }
}

export interface ItemConditionReplayInput {
  /** Item conditions are fully evented: a branch-origin seed holds none (R3). */
  seed: ItemConditionsProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its item-conditions projection. */
export function replayItemConditionHistory(input: ItemConditionReplayInput): ItemConditionsProjection {
  const seed = sortItemConditionsProjection(itemConditionsProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(
        `Item condition replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`,
      );
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyItemConditionEvent(projection, event);
    lastSequence = event.sequence;
  }
  return itemConditionsProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin item-conditions seed. */
export function emptyItemConditionSeed(branchId: string, originStorySecond: number): ItemConditionsProjection {
  return itemConditionsProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    meters: [],
    modifiers: [],
  });
}
