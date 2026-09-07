import { bodyConditionAppliedEventSchema, bodyConditionSchema, bodyMeterStateSchema, bodyThresholdCrossedEventSchema, type BodyCondition, type BodyConditionAppliedEvent, type BodyMeterDefinition, type BodyMeterState, type BodyModifier, type BodyThresholdCrossedEvent, type ResolveBodyThresholdCommand, type ResolveBodyThresholdRejectionCode, type ScheduledBodyAdjustment } from "../../contracts/bodies";
import { bodyConditionExpiryTriggerKind, type TriggerScheduledEvent } from "../../contracts/scheduler";
import { rearmCollapseTrigger, type CollapseContext } from "./collapse";
import { bodyConditionExpiryUniquenessKey, buildBodyTrigger, capturedDerivation, deriveBodyConditionId, eventEnvelope, rearmThresholdTrigger, rejection, type BodyBranchMeta, type BodyEventCommandContext, type BodyRejection } from "./events";
import { compareStableText, integrateMeterValue, thresholdCrossed, type MeterIntegrationView } from "./integration";

// ---------------------------------------------------------------------------
// ResolveBodyThreshold (trigger-dispatched; fire-time re-validated)
// ---------------------------------------------------------------------------

export interface ResolveBodyThresholdResolutionView extends BodyBranchMeta {
  meter?: BodyMeterState;
  definition?: BodyMeterDefinition;
  modifiers: readonly BodyModifier[];
  /** E5.2 rhythm self-care crossings through the solve horizon. */
  scheduledAdjustments?: readonly ScheduledBodyAdjustment[];
  /** Live same-key condition already held (suppresses a duplicate onset). */
  activeOutcomeConditionKey?: boolean;
  /** Co-located witnesses, captured by the store for noticeable thresholds. */
  coLocatedActorIds: readonly string[];
  /** E5.2 collapse: pressure context for the read-floor alarm re-solve. */
  collapseContext?: CollapseContext;
}

export interface ResolveBodyThresholdResolution {
  ok: true;
  meter: BodyMeterState;
  condition?: BodyCondition;
  events: [
    BodyThresholdCrossedEvent,
    ...(BodyConditionAppliedEvent | TriggerScheduledEvent)[],
  ];
}

export function resolveBodyThreshold(
  view: ResolveBodyThresholdResolutionView,
  command: ResolveBodyThresholdCommand,
): BodyRejection<ResolveBodyThresholdRejectionCode> | ResolveBodyThresholdResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Body limits resolve on the world's clock only.");
  }
  if (!view.meter) return rejection("body_not_initialized", "That body is not tracked.");
  if (!view.definition) return rejection("unknown_meter_key", "That body meter is unknown.");
  const threshold = view.definition.thresholds.find(
    (candidate) => candidate.key === command.payload.thresholdKey,
  );
  if (!threshold) return rejection("unknown_threshold_key", "That body limit is unknown.");
  const meterView: MeterIntegrationView = {
    definition: view.definition,
    state: view.meter,
    modifiers: view.modifiers,
    scheduledAdjustments: view.scheduledAdjustments ?? [],
  };
  const valueNow = integrateMeterValue(meterView, view.storySecond);
  if (!thresholdCrossed(threshold, valueNow)) {
    // A material event moved the trajectory after arming; its own commit
    // retired this alarm's replay entry and re-armed the live one.
    return rejection("threshold_stale", "That limit is no longer being crossed.");
  }
  const observerActorIds = threshold.noticeable
    ? [...new Set(view.coLocatedActorIds)].sort(compareStableText)
    : [];
  const crossedEvent = bodyThresholdCrossedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "body-threshold"),
    type: "body_threshold_crossed",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      meterKey: command.payload.meterKey,
      thresholdKey: threshold.key,
      boundaryFixedPoint: threshold.boundaryFixedPoint,
      direction: threshold.direction,
      valueAtCrossingFixedPoint: valueNow,
      observerActorIds,
      derived: capturedDerivation(meterView, view.storySecond),
    },
  });
  const nextState = bodyMeterStateSchema.parse({
    ...view.meter,
    valueFixedPoint: valueNow,
    lastIntegratedAtStorySecond: view.storySecond,
  });
  const trailing: (BodyConditionAppliedEvent | TriggerScheduledEvent)[] = [];
  let condition: BodyCondition | undefined;
  let nextSequence = crossedEvent.sequence + 1;
  if (threshold.outcome.kind === "condition_onset" && view.activeOutcomeConditionKey !== true) {
    const conditionId = deriveBodyConditionId(view.branchId, command.id);
    const expiresAt =
      threshold.outcome.durationSeconds === undefined
        ? undefined
        : view.storySecond + threshold.outcome.durationSeconds;
    const conditionEvent = bodyConditionAppliedEventSchema.parse({
      ...eventEnvelope(view, command, nextSequence, "body-condition"),
      type: "body_condition_applied",
      causationId: crossedEvent.id,
      actorIds: [command.payload.actorId],
      entityIds: [conditionId],
      payload: {
        actorId: command.payload.actorId,
        conditionId,
        conditionKey: threshold.outcome.conditionKey,
        onsetAtStorySecond: view.storySecond,
        ...(expiresAt === undefined ? {} : { expiresAtStorySecond: expiresAt }),
        observerActorIds,
      },
    });
    trailing.push(conditionEvent);
    nextSequence += 1;
    condition = bodyConditionSchema.parse({
      id: conditionId,
      actorId: command.payload.actorId,
      key: threshold.outcome.conditionKey,
      onsetAtStorySecond: view.storySecond,
      ...(expiresAt === undefined ? {} : { expiresAtStorySecond: expiresAt }),
      status: "active",
      sourceEventId: conditionEvent.id,
    });
    if (expiresAt !== undefined) {
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
    causationId: crossedEvent.id,
    armedAtSequence: crossedEvent.sequence,
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
      causationId: crossedEvent.id,
      armedAtSequence: crossedEvent.sequence,
    });
    if (collapseRearm) trailing.push(collapseRearm);
  }
  return {
    ok: true,
    meter: nextState,
    ...(condition === undefined ? {} : { condition }),
    events: [crossedEvent, ...trailing],
  };
}

/**
 * E6.3 — re-solve and re-arm one actor's full body-alarm set (each meter's
 * next threshold crossing, plus the collapse alarm when an energy view and
 * context exist) from current law at `view.storySecond`. Used by the LOD
 * assignment when the simulation axis moves and lands at `event` or `exact`:
 * the store retires every prior body alarm unconditionally first (the
 * restock-reconfigure idiom), and this builds the fresh set as the same
 * command's trigger_scheduled events. A meter whose law never crosses a
 * threshold inside the horizon arms nothing, exactly as initialization does.
 */
export function buildActorBodyAlarmRearms(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  meterViews: readonly MeterIntegrationView[];
  collapseContext?: CollapseContext;
  startSequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent[] {
  const events: TriggerScheduledEvent[] = [];
  let sequence = input.startSequence;
  for (const meterView of input.meterViews) {
    const trigger = rearmThresholdTrigger({
      view: input.view,
      command: input.command,
      actorId: input.actorId,
      meterView,
      sequence,
      causationId: input.causationId,
      armedAtSequence: input.armedAtSequence,
    });
    if (trigger) {
      events.push(trigger);
      sequence += 1;
    }
  }
  const energyView = input.meterViews.find((candidate) => candidate.definition.key === "energy");
  if (energyView) {
    const collapse = rearmCollapseTrigger({
      view: input.view,
      command: input.command,
      actorId: input.actorId,
      energyView,
      context: input.collapseContext,
      sequence,
      causationId: input.causationId,
      armedAtSequence: input.armedAtSequence,
    });
    if (collapse) events.push(collapse);
  }
  return events;
}
