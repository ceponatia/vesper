import { AFTERGLOW_DURATION_SECONDS, EXERTION_HYGIENE_FRACTION_FIXED_POINT, METER_FIXED_POINT_ONE, bodyConditionAppliedEventSchema, bodyConditionSchema, bodyInitializedEventSchema, bodyMeterRegistryByVersion, bodyMeterStateSchema, bodySourceAppliedEventSchema, type ApplyBodySourceCommand, type ApplyBodySourceRejectionCode, type BodyCondition, type BodyConditionAppliedEvent, type BodyInitializedEvent, type BodyMeterDefinition, type BodyMeterState, type BodyModifier, type BodySourceAppliedEvent, type BodySourceKind, type BodySourceOperation, type InitializeActorBodyCommand, type InitializeActorBodyRejectionCode, type ScheduledBodyAdjustment } from "../../contracts/bodies";
import { bodyConditionExpiryTriggerKind, type TriggerScheduledEvent } from "../../contracts/scheduler";
import { rearmCollapseTrigger, type CollapseContext } from "./collapse";
import { actorControlledBy, bodyConditionExpiryUniquenessKey, buildBodyTrigger, capturedDerivation, deriveBodyConditionId, eventEnvelope, rearmThresholdTrigger, rejection, type BodyBranchMeta, type BodyRejection } from "./events";
import { integrateMeterValue, type MeterIntegrationView } from "./integration";

// ---------------------------------------------------------------------------
// InitializeActorBody (seeds the substrate for one actor)
// ---------------------------------------------------------------------------

export interface InitializeActorBodyResolutionView extends BodyBranchMeta {
  actorExists: boolean;
  /**
   * The actor's meter rows that already exist. Initialization is ADDITIVE
   * (R4 corpus finding, 2026-07-22): a registry that grew since this body was
   * first seeded initializes only the MISSING meters; a fully-covered body
   * still rejects `body_already_initialized`. Re-running a world seed after a
   * registry addition is therefore the lawful upgrade path.
   */
  existingMeterKeys: readonly string[];
  /** E5.2: rhythm crossings per meter so initial alarms see future self-care. */
  selfCareAdjustmentsByMeter?: ReadonlyMap<string, readonly ScheduledBodyAdjustment[]>;
  /**
   * E6.3: false when the actor's effective simulation LOD is already below
   * `event` — the substrate still initializes (meters exist, reads stay
   * lazy) but no alarm arms, keeping the dormant no-work law airtight on
   * every path. Absent means true (the pre-E6.3 behavior).
   */
  armAlarms?: boolean;
}

export interface InitializeActorBodyResolution {
  ok: true;
  meters: BodyMeterState[];
  events: [BodyInitializedEvent, ...TriggerScheduledEvent[]];
}

export function resolveInitializeActorBody(
  view: InitializeActorBodyResolutionView,
  command: InitializeActorBodyCommand,
): BodyRejection<InitializeActorBodyRejectionCode> | InitializeActorBodyResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  const principal = command.principal.kind;
  if (principal === "player" || principal === "npc_policy" || principal === "npc_deliberator") {
    return rejection("unauthorized_principal", "Bodies are seeded by the world, not played into being.");
  }
  if (!view.actorExists) return rejection("actor_not_found", "That actor is unavailable.");
  const registry = bodyMeterRegistryByVersion[command.payload.registryVersion];
  const missing = registry.filter((definition) => !view.existingMeterKeys.includes(definition.key));
  if (missing.length === 0) {
    return rejection("body_already_initialized", "That body already exists.");
  }
  const knownKeys = new Set(registry.map((definition) => definition.key));
  for (const overrideKey of Object.keys(command.payload.baselineOverrides)) {
    if (!knownKeys.has(overrideKey)) {
      return rejection("unknown_meter_key", "That body meter is unknown.");
    }
  }
  const meters = missing.map((definition) =>
    bodyMeterStateSchema.parse({
      actorId: command.payload.actorId,
      meterKey: definition.key,
      valueFixedPoint: definition.initialFixedPoint,
      baselineFixedPoint:
        command.payload.baselineOverrides[definition.key] ?? definition.baselineFixedPoint,
      lastIntegratedAtStorySecond: view.storySecond,
      registryVersion: command.payload.registryVersion,
    }),
  );
  const initialized = bodyInitializedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "body-initialized"),
    type: "body_initialized",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      registryVersion: command.payload.registryVersion,
      meters: meters.map((meter) => ({
        meterKey: meter.meterKey,
        valueFixedPoint: meter.valueFixedPoint,
        baselineFixedPoint: meter.baselineFixedPoint,
      })),
    },
  });
  const triggers: TriggerScheduledEvent[] = [];
  if (view.armAlarms !== false) {
    for (const definition of registry) {
      const meter = meters.find((candidate) => candidate.meterKey === definition.key);
      if (!meter) continue;
      const scheduledAdjustments = view.selfCareAdjustmentsByMeter?.get(definition.key) ?? [];
      const trigger = rearmThresholdTrigger({
        view,
        command,
        actorId: command.payload.actorId,
        meterView: { definition, state: meter, modifiers: [], scheduledAdjustments },
        sequence: view.headSequence + 2 + triggers.length,
        causationId: initialized.id,
        armedAtSequence: initialized.sequence,
      });
      if (trigger) triggers.push(trigger);
    }
  }
  return { ok: true, meters, events: [initialized, ...triggers] };
}

// ---------------------------------------------------------------------------
// ApplyBodySource (layer 2 — material sources)
// ---------------------------------------------------------------------------
export interface BodyMeterResolutionView extends BodyBranchMeta {
  /** Whether the actor holds any meter rows at all. */
  bodyInitialized: boolean;
  /** Absent when this meter key resolves to no row or registry definition. */
  meter?: BodyMeterState;
  definition?: BodyMeterDefinition;
  /** Every modifier row for this actor + meter. */
  modifiers: readonly BodyModifier[];
  /** E5.2 rhythm self-care crossings through the solve horizon. */
  scheduledAdjustments?: readonly ScheduledBodyAdjustment[];
  /** E5.2 climax coupling: a live afterglow suppresses a duplicate onset. */
  activeAfterglow?: boolean;
  /** E5.2 exertion coupling: the actor's hygiene view, when it exists. */
  coupledHygiene?: MeterIntegrationView;
  /** E5.2 collapse: pressure context for the read-floor alarm re-solve. */
  collapseContext?: CollapseContext;
}

export interface ApplyBodySourceResolution {
  ok: true;
  meter: BodyMeterState;
  /** The exertion coupling's hygiene write, when it fired. */
  coupledMeter?: BodyMeterState;
  /** The climax coupling's afterglow condition, when it fired. */
  condition?: BodyCondition;
  events: [
    BodySourceAppliedEvent,
    ...(BodySourceAppliedEvent | BodyConditionAppliedEvent | TriggerScheduledEvent)[],
  ];
}

function sourceValueAfter(
  operation: ApplyBodySourceCommand["payload"]["operation"],
  integrated: number,
  baselineFixedPoint: number,
): number {
  switch (operation.kind) {
    case "set":
      return operation.valueFixedPoint;
    case "add":
      return clampMeter(integrated + operation.deltaFixedPoint);
    case "reset_to_baseline":
      return baselineFixedPoint;
  }
}

/**
 * The single-meter source-application core (layer 2): integrate to now,
 * apply the operation, build the `body_source_applied` event with its
 * captured derivation, and the meter's next state. `resolveApplyBodySource`
 * and the exported `applySourceToMeter` below both build on this — kept
 * private and rearm-free because `resolveApplyBodySource`'s exertion/climax
 * couplings must land BETWEEN this event and its own rearm calls, an
 * interleaving `applySourceToMeter`'s bundled rearm has no reason to support.
 */
function buildSourceAppliedEvent(args: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  meterKey: string;
  sourceKind: BodySourceKind;
  operation: BodySourceOperation;
  meterView: MeterIntegrationView;
  sequence: number;
  suffix: string;
  causationId?: string;
}): { event: BodySourceAppliedEvent; nextState: BodyMeterState } {
  const integrated = integrateMeterValue(args.meterView, args.view.storySecond);
  const valueAfter = sourceValueAfter(
    args.operation,
    integrated,
    args.meterView.state.baselineFixedPoint,
  );
  const event = bodySourceAppliedEventSchema.parse({
    ...eventEnvelope(args.view, args.command, args.sequence, args.suffix),
    type: "body_source_applied",
    ...(args.causationId === undefined ? {} : { causationId: args.causationId }),
    actorIds: [args.actorId],
    entityIds: [args.actorId],
    payload: {
      actorId: args.actorId,
      meterKey: args.meterKey,
      sourceKind: args.sourceKind,
      operation: args.operation,
      valueAfterFixedPoint: valueAfter,
      derived: capturedDerivation(args.meterView, args.view.storySecond),
    },
  });
  const nextState = bodyMeterStateSchema.parse({
    ...args.meterView.state,
    valueFixedPoint: valueAfter,
    lastIntegratedAtStorySecond: args.view.storySecond,
  });
  return { event, nextState };
}

export interface ApplySourceToMeterArgs {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  meterKey: string;
  sourceKind: BodySourceKind;
  operation: BodySourceOperation;
  meterView: MeterIntegrationView;
  /** Consulted only when `meterKey` is `"energy"` — omit where no collapse alarm applies. */
  collapseContext?: CollapseContext;
  sequence: number;
  suffix: string;
  causationId?: string;
}

export interface ApplySourceToMeterResult {
  event: BodySourceAppliedEvent;
  nextState: BodyMeterState;
  /** Threshold re-arm, then (when `meterKey` is `"energy"`) the collapse re-arm. */
  rearmEvents: TriggerScheduledEvent[];
  /** The first unused sequence number after `event` and every `rearmEvents` entry. */
  nextSequence: number;
}

/**
 * The exported single-meter source-application helper (layer 2): the core
 * above, bundled with its threshold/collapse re-arm in one call — exactly what
 * a non-body resolver needs to write a meter and retire+re-arm its alarms
 * atomically (consumption, completion-time consume costs). Consumption sources
 * never carry the exertion/climax couplings (their sourceKind is
 * meal/drink/adjustment), so bundling here is safe.
 */
export function applySourceToMeter(args: ApplySourceToMeterArgs): ApplySourceToMeterResult {
  const { event, nextState } = buildSourceAppliedEvent(args);
  const rearmEvents: TriggerScheduledEvent[] = [];
  let nextSequence = event.sequence + 1;
  const nextMeterView: MeterIntegrationView = {
    definition: args.meterView.definition,
    state: nextState,
    modifiers: args.meterView.modifiers,
    scheduledAdjustments: args.meterView.scheduledAdjustments ?? [],
  };
  const rearm = rearmThresholdTrigger({
    view: args.view,
    command: args.command,
    actorId: args.actorId,
    meterView: nextMeterView,
    sequence: nextSequence,
    causationId: event.id,
    armedAtSequence: event.sequence,
  });
  if (rearm) {
    rearmEvents.push(rearm);
    nextSequence += 1;
  }
  if (args.meterKey === "energy") {
    const collapseRearm = rearmCollapseTrigger({
      view: args.view,
      command: args.command,
      actorId: args.actorId,
      energyView: nextMeterView,
      context: args.collapseContext,
      sequence: nextSequence,
      causationId: event.id,
      armedAtSequence: event.sequence,
    });
    if (collapseRearm) {
      rearmEvents.push(collapseRearm);
      nextSequence += 1;
    }
  }
  return { event, nextState, rearmEvents, nextSequence };
}

export function resolveApplyBodySource(
  view: BodyMeterResolutionView,
  command: ApplyBodySourceCommand,
): BodyRejection<ApplyBodySourceRejectionCode> | ApplyBodySourceResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.bodyInitialized) return rejection("body_not_initialized", "That body is not tracked.");
  if (!view.meter || !view.definition) {
    return rejection("unknown_meter_key", "That body meter is unknown.");
  }
  if (!actorControlledBy(command, command.payload.actorId)) {
    return rejection("unauthorized_actor", "You cannot act on that body.");
  }
  const operation = command.payload.operation;
  const { event, nextState } = buildSourceAppliedEvent({
    view,
    command,
    actorId: command.payload.actorId,
    meterKey: command.payload.meterKey,
    sourceKind: command.payload.sourceKind,
    operation,
    meterView: {
      definition: view.definition,
      state: view.meter,
      modifiers: view.modifiers,
      scheduledAdjustments: view.scheduledAdjustments ?? [],
    },
    sequence: view.headSequence + 1,
    suffix: "body-source",
  });
  const trailing: (BodySourceAppliedEvent | BodyConditionAppliedEvent | TriggerScheduledEvent)[] = [];
  let nextSequence = event.sequence + 1;
  let coupledMeter: BodyMeterState | undefined;
  let condition: BodyCondition | undefined;
  // Exertion coupling: working the body also costs freshness — a
  // deterministic hygiene drain at half the energy cost, one causal record.
  if (
    command.payload.sourceKind === "exertion" &&
    command.payload.meterKey === "energy" &&
    operation.kind === "add" &&
    operation.deltaFixedPoint < 0 &&
    view.coupledHygiene
  ) {
    const hygieneView = view.coupledHygiene;
    const hygieneDrain = Math.floor(
      (Math.abs(operation.deltaFixedPoint) * EXERTION_HYGIENE_FRACTION_FIXED_POINT) /
        METER_FIXED_POINT_ONE,
    );
    if (hygieneDrain > 0) {
      const hygieneIntegrated = integrateMeterValue(hygieneView, view.storySecond);
      const hygieneAfter = clampMeter(hygieneIntegrated - hygieneDrain);
      trailing.push(
        bodySourceAppliedEventSchema.parse({
          ...eventEnvelope(view, command, nextSequence, "body-source-hygiene"),
          type: "body_source_applied",
          causationId: event.id,
          actorIds: [command.payload.actorId],
          entityIds: [command.payload.actorId],
          payload: {
            actorId: command.payload.actorId,
            meterKey: hygieneView.definition.key,
            sourceKind: "exertion",
            operation: { kind: "add", deltaFixedPoint: hygieneAfter - hygieneIntegrated },
            valueAfterFixedPoint: hygieneAfter,
            derived: capturedDerivation(hygieneView, view.storySecond),
          },
        }),
      );
      nextSequence += 1;
      coupledMeter = bodyMeterStateSchema.parse({
        ...hygieneView.state,
        valueFixedPoint: hygieneAfter,
        lastIntegratedAtStorySecond: view.storySecond,
      });
    }
  }
  // Climax coupling: the reset installs afterglow as a self-expiring
  // condition — the settled body is a state the world tracks, not prose.
  if (
    command.payload.sourceKind === "climax" &&
    command.payload.meterKey === "arousal" &&
    view.activeAfterglow !== true
  ) {
    const conditionId = deriveBodyConditionId(view.branchId, command.id);
    const expiresAt = view.storySecond + AFTERGLOW_DURATION_SECONDS;
    const conditionEvent = bodyConditionAppliedEventSchema.parse({
      ...eventEnvelope(view, command, nextSequence, "body-condition"),
      type: "body_condition_applied",
      causationId: event.id,
      actorIds: [command.payload.actorId],
      entityIds: [conditionId],
      payload: {
        actorId: command.payload.actorId,
        conditionId,
        conditionKey: "afterglow",
        onsetAtStorySecond: view.storySecond,
        expiresAtStorySecond: expiresAt,
        observerActorIds: [],
      },
    });
    trailing.push(conditionEvent);
    nextSequence += 1;
    condition = bodyConditionSchema.parse({
      id: conditionId,
      actorId: command.payload.actorId,
      key: "afterglow",
      onsetAtStorySecond: view.storySecond,
      expiresAtStorySecond: expiresAt,
      status: "active",
      sourceEventId: conditionEvent.id,
    });
    trailing.push(
      buildBodyTrigger({
        view,
        command,
        sequence: nextSequence,
        causationId: conditionEvent.id,
        actorId: command.payload.actorId,
        suffix: "arm-condition-expiry",
        intent: {
          kind: bodyConditionExpiryTriggerKind,
          dueStorySecond: expiresAt,
          uniquenessKey: bodyConditionExpiryUniquenessKey(conditionId),
          payload: { actorId: command.payload.actorId, conditionId, basis: "expired" },
        },
      }),
    );
    nextSequence += 1;
  }
  const rearm = rearmThresholdTrigger({
    view,
    command,
    actorId: command.payload.actorId,
    meterView: {
      definition: view.definition,
      state: nextState,
      modifiers: view.modifiers,
      scheduledAdjustments: view.scheduledAdjustments ?? [],
    },
    sequence: nextSequence,
    causationId: event.id,
    armedAtSequence: event.sequence,
  });
  if (rearm) {
    trailing.push(rearm);
    nextSequence += 1;
  }
  if (command.payload.meterKey === "energy") {
    const collapseRearm = rearmCollapseTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      energyView: {
        definition: view.definition,
        state: nextState,
        modifiers: view.modifiers,
        scheduledAdjustments: view.scheduledAdjustments ?? [],
      },
      context: view.collapseContext,
      sequence: nextSequence,
      causationId: event.id,
      armedAtSequence: event.sequence,
    });
    if (collapseRearm) {
      trailing.push(collapseRearm);
      nextSequence += 1;
    }
  }
  if (coupledMeter && view.coupledHygiene) {
    const hygieneRearm = rearmThresholdTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      meterView: {
        definition: view.coupledHygiene.definition,
        state: coupledMeter,
        modifiers: view.coupledHygiene.modifiers,
        scheduledAdjustments: view.coupledHygiene.scheduledAdjustments ?? [],
      },
      sequence: nextSequence,
      causationId: event.id,
      armedAtSequence: event.sequence,
    });
    if (hygieneRearm) trailing.push(hygieneRearm);
  }
  return {
    ok: true,
    meter: nextState,
    ...(coupledMeter === undefined ? {} : { coupledMeter }),
    ...(condition === undefined ? {} : { condition }),
    events: [event, ...trailing],
  };
}
