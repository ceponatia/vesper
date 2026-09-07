import { bodyConditionAppliedEventSchema, bodyConditionEndedEventSchema, bodyConditionSchema, bodyMeterStateSchema, bodyModifierAppliedEventSchema, bodyModifierSchema, bodySourceAppliedEventSchema, type ApplyBodyConditionCommand, type ApplyBodyConditionRejectionCode, type ApplyBodyModifierCommand, type ApplyBodyModifierRejectionCode, type BodyCondition, type BodyConditionAppliedEvent, type BodyConditionEndedEvent, type BodyMeterDefinition, type BodyMeterState, type BodyModifier, type BodyModifierAppliedEvent, type BodyModifierSpec, type BodySourceAppliedEvent, type EndBodyConditionCommand, type EndBodyConditionRejectionCode } from "../../contracts/bodies";
import { composeSimulationId } from "../../contracts/identity";
import { bodyConditionExpiryTriggerKind, type TriggerScheduledEvent } from "../../contracts/scheduler";
import { rearmCollapseTrigger, type CollapseContext } from "./collapse";
import { actorControlledBy, bodyConditionExpiryUniquenessKey, buildBodyTrigger, capturedDerivation, deriveBodyConditionId, deriveBodyModifierId, eventEnvelope, rearmThresholdTrigger, rejection, type BodyBranchMeta, type BodyRejection } from "./events";
import { clampMeter, compareStableText, deriveSleepCredit, integrateMeterValue, normalizeConditionModifierSpecs, type MeterIntegrationView } from "./integration";

// ---------------------------------------------------------------------------
// ApplyBodyModifier (the one modifier contract)
// ---------------------------------------------------------------------------

export interface ApplyBodyModifierResolution {
  ok: true;
  meter: BodyMeterState;
  modifier: BodyModifier;
  events: [BodyModifierAppliedEvent, ...TriggerScheduledEvent[]];
}

function validateModifierSpec(
  spec: BodyModifierSpec,
  definition: BodyMeterDefinition,
): "rate_add_on_nonlinear_law" | undefined {
  if (spec.operation.kind === "rate_add" && definition.driftLaw.kind !== "linear") {
    // Mixing a constant rate into a decay law would break the closed form
    // (and its monotonicity) the threshold solver depends on.
    return "rate_add_on_nonlinear_law";
  }
  return undefined;
}

function buildModifierAppliedEvent(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  sequence: number;
  suffix: string;
  actorId: string;
  modifier: BodyModifier;
  meterView: MeterIntegrationView;
  valueAtApply: number;
  causationId?: string;
}): BodyModifierAppliedEvent {
  return bodyModifierAppliedEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, input.suffix),
    type: "body_modifier_applied",
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    actorIds: [input.actorId],
    entityIds: [input.actorId],
    payload: {
      actorId: input.actorId,
      modifierId: input.modifier.id,
      meterKey: input.modifier.meterKey,
      operation: input.modifier.operation,
      stackingGroup: input.modifier.stackingGroup,
      priority: input.modifier.priority,
      validFromStorySecond: input.modifier.validFromStorySecond,
      ...(input.modifier.validUntilStorySecond === undefined
        ? {}
        : { validUntilStorySecond: input.modifier.validUntilStorySecond }),
      visibility: input.modifier.visibility,
      ...(input.modifier.conditionId === undefined ? {} : { conditionId: input.modifier.conditionId }),
      valueAtApplyFixedPoint: input.valueAtApply,
      derived: capturedDerivation(input.meterView, input.view.storySecond),
    },
  });
}

function modifierFromSpec(input: {
  spec: BodyModifierSpec;
  modifierId: string;
  actorId: string;
  fromStorySecond: number;
  sourceEventId: string;
  conditionId?: string;
  conditionExpiresAt?: number;
}): BodyModifier {
  const untilCandidates = [
    input.spec.durationSeconds === undefined
      ? undefined
      : input.fromStorySecond + input.spec.durationSeconds,
    input.conditionExpiresAt,
  ].filter((value): value is number => value !== undefined);
  return bodyModifierSchema.parse({
    id: input.modifierId,
    actorId: input.actorId,
    meterKey: input.spec.meterKey,
    operation: input.spec.operation,
    stackingGroup: input.spec.stackingGroup,
    priority: input.spec.priority,
    validFromStorySecond: input.fromStorySecond,
    ...(untilCandidates.length === 0 ? {} : { validUntilStorySecond: Math.min(...untilCandidates) }),
    visibility: input.spec.visibility,
    ...(input.conditionId === undefined ? {} : { conditionId: input.conditionId }),
    sourceEventId: input.sourceEventId,
  });
}

export function resolveApplyBodyModifier(
  view: BodyMeterResolutionView,
  command: ApplyBodyModifierCommand,
): BodyRejection<ApplyBodyModifierRejectionCode> | ApplyBodyModifierResolution {
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
  const specProblem = validateModifierSpec(command.payload.modifier, view.definition);
  if (specProblem) {
    return rejection(specProblem, "That effect cannot attach to that body process.");
  }
  const meterView: MeterIntegrationView = {
    definition: view.definition,
    state: view.meter,
    modifiers: view.modifiers,
    scheduledAdjustments: view.scheduledAdjustments ?? [],
  };
  const valueAtApply = integrateMeterValue(meterView, view.storySecond);
  const modifier = modifierFromSpec({
    spec: command.payload.modifier,
    modifierId: deriveBodyModifierId(view.branchId, command.id, 0),
    actorId: command.payload.actorId,
    fromStorySecond: view.storySecond,
    sourceEventId: composeSimulationId("event", [view.branchId, command.id, "body-modifier-0"]),
  });
  const event = buildModifierAppliedEvent({
    view,
    command,
    sequence: view.headSequence + 1,
    suffix: "body-modifier-0",
    actorId: command.payload.actorId,
    modifier,
    meterView,
    valueAtApply,
  });
  const nextState = bodyMeterStateSchema.parse({
    ...view.meter,
    valueFixedPoint: valueAtApply,
    lastIntegratedAtStorySecond: view.storySecond,
  });
  const trailing: TriggerScheduledEvent[] = [];
  let nextSequence = view.headSequence + 2;
  const rearm = rearmThresholdTrigger({
    view,
    command,
    actorId: command.payload.actorId,
    meterView: {
      definition: view.definition,
      state: nextState,
      modifiers: [...view.modifiers, modifier],
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
  if (command.payload.modifier.meterKey === "energy") {
    const collapseRearm = rearmCollapseTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      energyView: {
        definition: view.definition,
        state: nextState,
        modifiers: [...view.modifiers, modifier],
        scheduledAdjustments: view.scheduledAdjustments ?? [],
      },
      context: view.collapseContext,
      sequence: nextSequence,
      causationId: event.id,
      armedAtSequence: event.sequence,
    });
    if (collapseRearm) trailing.push(collapseRearm);
  }
  return { ok: true, meter: nextState, modifier, events: [event, ...trailing] };
}

// ---------------------------------------------------------------------------
// ApplyBodyCondition (categorical, sourced, self-expiring)
// ---------------------------------------------------------------------------
export interface ApplyBodyConditionResolutionView extends BodyBranchMeta {
  bodyInitialized: boolean;
  /** A live condition with the requested key already held by the actor. */
  activeSameKey: boolean;
  /** Meter views for every meter named by the owned modifier specs. */
  meterViews: ReadonlyMap<string, MeterIntegrationView>;
  /** E5.2 collapse: pressure context for the read-floor alarm re-solve. */
  collapseContext?: CollapseContext;
}

export interface ApplyBodyConditionResolution {
  ok: true;
  condition: BodyCondition;
  modifiers: BodyModifier[];
  /** Meter states persisted at the modifier boundary, keyed by meter key. */
  meters: Map<string, BodyMeterState>;
  events: [BodyConditionAppliedEvent, ...(BodyModifierAppliedEvent | TriggerScheduledEvent)[]];
}

export function resolveApplyBodyCondition(
  view: ApplyBodyConditionResolutionView,
  command: ApplyBodyConditionCommand,
): BodyRejection<ApplyBodyConditionRejectionCode> | ApplyBodyConditionResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (!view.bodyInitialized) return rejection("body_not_initialized", "That body is not tracked.");
  if (!actorControlledBy(command, command.payload.actorId)) {
    return rejection("unauthorized_actor", "You cannot act on that body.");
  }
  if (view.activeSameKey) {
    return rejection("condition_already_active", "That state already holds.");
  }
  // The sleep coupling: an asleep condition always suspends energy.
  const modifierSpecs = normalizeConditionModifierSpecs(
    command.payload.conditionKey,
    command.payload.modifiers,
  );
  for (const spec of modifierSpecs) {
    const meterView = view.meterViews.get(spec.meterKey);
    if (!meterView) return rejection("unknown_meter_key", "That body meter is unknown.");
    const specProblem = validateModifierSpec(spec, meterView.definition);
    if (specProblem) {
      return rejection(specProblem, "That effect cannot attach to that body process.");
    }
  }
  const conditionId = deriveBodyConditionId(view.branchId, command.id);
  const expiresAt =
    command.payload.durationSeconds === undefined
      ? undefined
      : view.storySecond + command.payload.durationSeconds;
  const appliedEvent = bodyConditionAppliedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "body-condition"),
    type: "body_condition_applied",
    actorIds: [command.payload.actorId],
    entityIds: [conditionId],
    payload: {
      actorId: command.payload.actorId,
      conditionId,
      conditionKey: command.payload.conditionKey,
      onsetAtStorySecond: view.storySecond,
      ...(expiresAt === undefined ? {} : { expiresAtStorySecond: expiresAt }),
      observerActorIds: command.payload.observerActorIds,
    },
  });
  const condition = bodyConditionSchema.parse({
    id: conditionId,
    actorId: command.payload.actorId,
    key: command.payload.conditionKey,
    onsetAtStorySecond: view.storySecond,
    ...(expiresAt === undefined ? {} : { expiresAtStorySecond: expiresAt }),
    status: "active",
    sourceEventId: appliedEvent.id,
  });
  const trailing: (BodyModifierAppliedEvent | TriggerScheduledEvent)[] = [];
  const modifiers: BodyModifier[] = [];
  const meters = new Map<string, BodyMeterState>();
  let nextSequence = appliedEvent.sequence + 1;
  for (const [ordinal, spec] of modifierSpecs.entries()) {
    const meterView = view.meterViews.get(spec.meterKey);
    if (!meterView) continue;
    const modifier = modifierFromSpec({
      spec,
      modifierId: deriveBodyModifierId(view.branchId, command.id, ordinal),
      actorId: command.payload.actorId,
      fromStorySecond: view.storySecond,
      sourceEventId: appliedEvent.id,
      conditionId,
      ...(expiresAt === undefined ? {} : { conditionExpiresAt: expiresAt }),
    });
    modifiers.push(modifier);
    const valueAtApply = integrateMeterValue(meterView, view.storySecond);
    trailing.push(
      buildModifierAppliedEvent({
        view,
        command,
        sequence: nextSequence,
        suffix: `body-modifier-${ordinal}`,
        actorId: command.payload.actorId,
        modifier,
        meterView,
        valueAtApply,
        causationId: appliedEvent.id,
      }),
    );
    nextSequence += 1;
    meters.set(
      spec.meterKey,
      bodyMeterStateSchema.parse({
        ...meterView.state,
        actorId: command.payload.actorId,
        meterKey: spec.meterKey,
        valueFixedPoint: valueAtApply,
        lastIntegratedAtStorySecond: view.storySecond,
      }),
    );
  }
  // Re-arm each touched meter's alarm against the post-condition modifier set.
  for (const [meterKey, meterState] of meters) {
    const meterView = view.meterViews.get(meterKey);
    if (!meterView) continue;
    const rearm = rearmThresholdTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      meterView: {
        definition: meterView.definition,
        state: meterState,
        modifiers: [...meterView.modifiers, ...modifiers.filter((m) => m.meterKey === meterKey)],
        scheduledAdjustments: meterView.scheduledAdjustments ?? [],
      },
      sequence: nextSequence,
      causationId: appliedEvent.id,
      armedAtSequence: appliedEvent.sequence,
    });
    if (rearm) {
      trailing.push(rearm);
      nextSequence += 1;
    }
  }
  if (expiresAt !== undefined) {
    trailing.push(
      buildBodyTrigger({
        view,
        command,
        sequence: nextSequence,
        causationId: appliedEvent.id,
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
  // Sleep onset only RETIRES the collapse alarm (she made it to bed; the
  // wake re-arms with fresh history). Other energy-touching conditions
  // re-solve it against their modified trajectory.
  const energyState = meters.get("energy");
  const energyView = view.meterViews.get("energy");
  if (command.payload.conditionKey !== "asleep" && energyState && energyView) {
    const collapseRearm = rearmCollapseTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      energyView: {
        definition: energyView.definition,
        state: energyState,
        modifiers: [...energyView.modifiers, ...modifiers.filter((m) => m.meterKey === "energy")],
        scheduledAdjustments: energyView.scheduledAdjustments ?? [],
      },
      context: view.collapseContext,
      sequence: nextSequence,
      causationId: appliedEvent.id,
      armedAtSequence: appliedEvent.sequence,
    });
    if (collapseRearm) trailing.push(collapseRearm);
  }
  return { ok: true, condition, modifiers, meters, events: [appliedEvent, ...trailing] };
}

// ---------------------------------------------------------------------------
// EndBodyCondition (explicit clear, or the expiry trigger's dispatch)
// ---------------------------------------------------------------------------
export interface EndBodyConditionResolutionView extends BodyBranchMeta {
  condition?: BodyCondition;
  /** Live modifiers owned by the condition, with their meter views. */
  ownedModifiers: readonly BodyModifier[];
  meterViews: ReadonlyMap<string, MeterIntegrationView>;
  /** E5.2 collapse: pressure context for the read-floor alarm re-solve. */
  collapseContext?: CollapseContext;
}

export interface EndBodyConditionResolution {
  ok: true;
  condition: BodyCondition;
  /** Meter states persisted at the retirement boundary, keyed by meter key. */
  meters: Map<string, BodyMeterState>;
  events: [BodyConditionEndedEvent, ...(BodySourceAppliedEvent | TriggerScheduledEvent)[]];
}

export function resolveEndBodyCondition(
  view: EndBodyConditionResolutionView,
  command: EndBodyConditionCommand,
): BodyRejection<EndBodyConditionRejectionCode> | EndBodyConditionResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  const condition = view.condition;
  if (!condition) return rejection("condition_not_found", "That state is unknown.");
  if (condition.status !== "active") return rejection("condition_not_active", "That state has passed.");
  if (command.payload.basis === "expired") {
    if (command.principal.kind !== "system") {
      return rejection("unauthorized_actor", "Only time ends a state this way.");
    }
    if (condition.expiresAtStorySecond === undefined || view.storySecond < condition.expiresAtStorySecond) {
      return rejection("expiry_not_due", "That state has not run its course.");
    }
  } else if (!actorControlledBy(command, command.payload.actorId)) {
    return rejection("unauthorized_actor", "You cannot act on that body.");
  }
  const endedEvent = bodyConditionEndedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "body-condition-ended"),
    type: "body_condition_ended",
    actorIds: [command.payload.actorId],
    entityIds: [condition.id],
    payload: {
      actorId: command.payload.actorId,
      conditionId: condition.id,
      conditionKey: condition.key,
      basis: command.payload.basis,
      endedAtStorySecond: view.storySecond,
      retiredModifiers: view.ownedModifiers.map((modifier) => ({
        modifierId: modifier.id,
        meterKey: modifier.meterKey,
      })),
    },
  });
  const ended = bodyConditionSchema.parse({
    ...condition,
    status: "ended",
    endBasis: command.payload.basis,
    endedAtStorySecond: view.storySecond,
  });
  // Persist each affected meter at the retirement boundary and re-solve its
  // alarm against the post-retirement modifier set. Waking from `asleep`
  // additionally credits the energy reserve by time actually slept (the
  // coupling's second half), emitted as a real sleep_credit source so the
  // causal record explains the refill.
  const events: [BodyConditionEndedEvent, ...(BodySourceAppliedEvent | TriggerScheduledEvent)[]] = [
    endedEvent,
  ];
  const meters = new Map<string, BodyMeterState>();
  const retiredIds = new Set(view.ownedModifiers.map((modifier) => modifier.id));
  const rearms: TriggerScheduledEvent[] = [];
  let nextSequence = endedEvent.sequence + 1;
  for (const meterKey of [...new Set(view.ownedModifiers.map((m) => m.meterKey))].sort(compareStableText)) {
    const meterView = view.meterViews.get(meterKey);
    if (!meterView) continue;
    const valueAtEnd = integrateMeterValue(meterView, view.storySecond);
    const sleepCredit =
      condition.key === "asleep" && meterKey === "energy"
        ? deriveSleepCredit({
            sleptSeconds: view.storySecond - condition.onsetAtStorySecond,
            reserveAtWakeFixedPoint: valueAtEnd,
          })
        : 0;
    const valueFinal = clampMeter(valueAtEnd + sleepCredit);
    if (sleepCredit > 0) {
      events.push(
        bodySourceAppliedEventSchema.parse({
          ...eventEnvelope(view, command, nextSequence, "sleep-credit"),
          type: "body_source_applied",
          causationId: endedEvent.id,
          actorIds: [command.payload.actorId],
          entityIds: [command.payload.actorId],
          payload: {
            actorId: command.payload.actorId,
            meterKey,
            sourceKind: "sleep_credit",
            operation: { kind: "add", deltaFixedPoint: sleepCredit },
            valueAfterFixedPoint: valueFinal,
            derived: capturedDerivation(meterView, view.storySecond),
          },
        }),
      );
      nextSequence += 1;
    }
    const meterState = bodyMeterStateSchema.parse({
      ...meterView.state,
      actorId: command.payload.actorId,
      meterKey,
      valueFixedPoint: valueFinal,
      lastIntegratedAtStorySecond: view.storySecond,
    });
    meters.set(meterKey, meterState);
    const survivingModifiers = meterView.modifiers.filter((modifier) => !retiredIds.has(modifier.id));
    const rearm = rearmThresholdTrigger({
      view,
      command,
      actorId: command.payload.actorId,
      meterView: {
        definition: meterView.definition,
        state: meterState,
        modifiers: survivingModifiers,
        scheduledAdjustments: meterView.scheduledAdjustments ?? [],
      },
      sequence: nextSequence,
      causationId: endedEvent.id,
      armedAtSequence: endedEvent.sequence,
    });
    if (rearm) {
      rearms.push(rearm);
      nextSequence += 1;
    }
    if (meterKey === "energy") {
      // Waking resets the sleep-history anchor: escalation restarts from
      // this very second, and the next collapse solves ~a full span out.
      const effectiveContext: CollapseContext | undefined =
        view.collapseContext === undefined
          ? undefined
          : condition.key === "asleep"
            ? { ...view.collapseContext, lastSleepEndedAtStorySecond: view.storySecond }
            : view.collapseContext;
      const collapseRearm = rearmCollapseTrigger({
        view,
        command,
        actorId: command.payload.actorId,
        energyView: {
          definition: meterView.definition,
          state: meterState,
          modifiers: survivingModifiers,
          scheduledAdjustments: meterView.scheduledAdjustments ?? [],
        },
        context: effectiveContext,
        sequence: nextSequence,
        causationId: endedEvent.id,
        armedAtSequence: endedEvent.sequence,
      });
      if (collapseRearm) {
        rearms.push(collapseRearm);
        nextSequence += 1;
      }
    }
  }
  events.push(...rearms);
  return { ok: true, condition: ended, meters, events };
}
