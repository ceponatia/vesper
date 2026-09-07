import { bodyConditionAppliedEventSchema, bodyConditionSchema, bodyDerivationVersion, type ApplyBodyConditionCommand, type ApplyBodyModifierCommand, type ApplyBodySourceCommand, type BodyCondition, type BodyModifier, type EndBodyConditionCommand, type InitializeActorBodyCommand, type ResolveBodyCollapseCommand, type ResolveBodyThresholdCommand, type ScheduledBodyAdjustment } from "../../contracts/bodies";
import type { SimulationBranchEvent } from "../../contracts/branching";
import { composeSimulationId } from "../../contracts/identity";
import { bodyCollapseTriggerKind, bodyConditionExpiryTriggerKind, bodyThresholdTriggerKind, schedulerDerivationVersion, triggerScheduledEventSchema, type TriggerScheduledEvent, } from "../../contracts/scheduler";
import { simulationHash } from "../hash";
import { compareStableText, modifiersLiveAt, normalizeConditionModifierSpecs, solveNextThresholdCrossing, type MeterIntegrationView } from "./integration";

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * Command ids on the trigger-dispatch path are themselves derived and would
 * stack a condition-expiry chain past the 256-char compact-id cap (the E3.5
 * lesson) — hash the variable-length part instead of concatenating.
 */
export function deriveBodyConditionId(branchId: string, commandId: string): string {
  return composeSimulationId("body-condition", [branchId, simulationHash({ commandId })]);
}

export function deriveBodyModifierId(branchId: string, commandId: string, ordinal: number): string {
  return composeSimulationId("body-modifier", [branchId, simulationHash({ commandId }), String(ordinal)]);
}

export function bodyThresholdUniquenessKey(
  actorId: string,
  meterKey: string,
  thresholdKey: string,
  armedAtSequence: number,
): string {
  return composeSimulationId("body-threshold", [actorId, meterKey, thresholdKey, String(armedAtSequence)]);
}

/**
 * Prefix matching every armed threshold alarm for one actor + meter, whatever
 * its threshold key or arming sequence. Length-prefixed parts make the match
 * exact — no other meter's key can alias into it.
 */
export function bodyThresholdUniquenessKeyPrefix(actorId: string, meterKey: string): string {
  return `${composeSimulationId("body-threshold", [actorId, meterKey])}:`;
}

export function bodyConditionExpiryUniquenessKey(conditionId: string): string {
  return composeSimulationId("body-condition-expiry", [conditionId]);
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing
// ---------------------------------------------------------------------------
export interface BodyBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

/**
 * The minimal command shape body event construction needs — narrower than the
 * closed `BodyCommand` union below so a non-body resolver (E5.3 consumption,
 * completion-time consume costs) can drive the same event-building helpers
 * without becoming a body command. Every `BodyCommand` member already
 * structurally satisfies this.
 */
export interface BodyEventCommandContext {
  id: string;
  correlationId: string;
  submittedAtWallClock: string;
}

export interface BodyRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

export function rejection<TCode extends string>(code: TCode, publicReason: string): BodyRejection<TCode> {
  return { ok: false, code, publicReason };
}

export type BodyCommand =
  | InitializeActorBodyCommand
  | ApplyBodySourceCommand
  | ApplyBodyModifierCommand
  | ApplyBodyConditionCommand
  | EndBodyConditionCommand
  | ResolveBodyThresholdCommand
  | ResolveBodyCollapseCommand;

export function actorControlledBy(command: BodyCommand, actorId: string): boolean {
  const principal = command.principal;
  if (
    principal.kind === "player" ||
    principal.kind === "npc_policy" ||
    principal.kind === "npc_deliberator"
  ) {
    return principal.controlledActorIds.some((controlled) => controlled === actorId);
  }
  return true;
}

export function eventEnvelope(
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
    derivationVersion: bodyDerivationVersion,
    commandId: command.id,
    correlationId: command.correlationId,
    recordedAtWallClock: command.submittedAtWallClock,
  };
}

export function capturedDerivation(view: MeterIntegrationView, atStorySecond: number) {
  return {
    fromValueFixedPoint: view.state.valueFixedPoint,
    fromStorySecond: view.state.lastIntegratedAtStorySecond,
    activeModifierIds: modifiersLiveAt(view.modifiers, atStorySecond)
      .map((modifier) => modifier.id)
      .sort(compareStableText),
    registryVersion: bodyDerivationVersion,
  };
}

export function buildBodyTrigger(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  sequence: number;
  causationId: string;
  actorId: string;
  suffix: string;
  intent:
    | {
        kind: typeof bodyThresholdTriggerKind;
        dueStorySecond: number;
        uniquenessKey: string;
        payload: { actorId: string; meterKey: string; thresholdKey: string; armedAtSequence: number };
      }
    | {
        kind: typeof bodyConditionExpiryTriggerKind;
        dueStorySecond: number;
        uniquenessKey: string;
        payload: { actorId: string; conditionId: string; basis: "expired" };
      }
    | {
        kind: typeof bodyCollapseTriggerKind;
        dueStorySecond: number;
        uniquenessKey: string;
        payload: { actorId: string; armedAtSequence: number };
      };
}): TriggerScheduledEvent {
  const templateId = composeSimulationId("template", [input.intent.uniquenessKey]);
  const command =
    input.intent.kind === bodyThresholdTriggerKind
      ? { type: "resolve_body_threshold" as const, payload: input.intent.payload }
      : input.intent.kind === bodyConditionExpiryTriggerKind
        ? { type: "end_body_condition" as const, payload: input.intent.payload }
        : { type: "resolve_body_collapse" as const, payload: input.intent.payload };
  return triggerScheduledEventSchema.parse({
    ...eventEnvelope(input.view, input.command, input.sequence, input.suffix),
    type: "trigger_scheduled",
    derivationVersion: schedulerDerivationVersion,
    causationId: input.causationId,
    actorIds: [input.actorId],
    entityIds:
      input.intent.kind === bodyConditionExpiryTriggerKind
        ? [input.intent.payload.conditionId]
        : [input.intent.payload.actorId],
    payload: {
      kind: input.intent.kind,
      triggerSchemaVersion: 1,
      dueStorySecond: input.intent.dueStorySecond,
      priority: 0,
      uniquenessKey: input.intent.uniquenessKey,
      command: {
        id: templateId,
        branchId: input.view.branchId,
        expectedVersion: 0,
        idempotencyKey: templateId,
        principal: { kind: "system", principalId: "sim-scheduler", controlledActorIds: [] },
        submittedAtWallClock: input.command.submittedAtWallClock,
        correlationId: input.command.correlationId,
        schemaVersion: 1,
        ...command,
      },
    },
  });
}

/** Re-solve one meter's alarm after a material write at `view.storySecond`. */
export function rearmThresholdTrigger(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  actorId: string;
  meterView: MeterIntegrationView;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent | undefined {
  const crossing = solveNextThresholdCrossing(input.meterView, input.view.storySecond);
  if (!crossing) return undefined;
  const meterKey = input.meterView.definition.key;
  return buildBodyTrigger({
    view: input.view,
    command: input.command,
    sequence: input.sequence,
    causationId: input.causationId,
    actorId: input.actorId,
    suffix: `arm-threshold-${meterKey}`,
    intent: {
      kind: bodyThresholdTriggerKind,
      dueStorySecond: crossing.crossesAtStorySecond,
      uniquenessKey: bodyThresholdUniquenessKey(
        input.actorId,
        meterKey,
        crossing.threshold.key,
        input.armedAtSequence,
      ),
      payload: {
        actorId: input.actorId,
        meterKey,
        thresholdKey: crossing.threshold.key,
        armedAtSequence: input.armedAtSequence,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Shared sleep condition event train
// ---------------------------------------------------------------------------
export interface SleepConditionTrain {
  condition: BodyCondition;
  suspendModifier: BodyModifier;
  /** condition-applied + modifier-applied + expiry trigger, causation-chained. */
  events: SimulationBranchEvent[];
  nextSequence: number;
}

/**
 * The asleep condition with its energy suspend and self-expiry alarm, as one
 * causation-chained event train. Extracted from `resolveBodyCollapse`
 * so forced sleep (collapse) and chosen sleep (the E6.2 routine controller)
 * commit the identical machinery — the applySourceToMeter precedent.
 */
export function buildSleepConditionTrain(input: {
  view: BodyBranchMeta;
  command: BodyEventCommandContext;
  sequence: number;
  causationId: string;
  actorId: string;
  expiresAtStorySecond: number;
  observerActorIds: readonly string[];
  energyView: MeterIntegrationView;
  valueAtApply: number;
}): SleepConditionTrain {
  const events: SimulationBranchEvent[] = [];
  let nextSequence = input.sequence;
  const conditionId = deriveBodyConditionId(input.view.branchId, input.command.id);
  const conditionEvent = bodyConditionAppliedEventSchema.parse({
    ...eventEnvelope(input.view, input.command, nextSequence, "body-condition"),
    type: "body_condition_applied",
    causationId: input.causationId,
    actorIds: [input.actorId],
    entityIds: [conditionId],
    payload: {
      actorId: input.actorId,
      conditionId,
      conditionKey: "asleep",
      onsetAtStorySecond: input.view.storySecond,
      expiresAtStorySecond: input.expiresAtStorySecond,
      observerActorIds: [...input.observerActorIds],
    },
  });
  events.push(conditionEvent);
  nextSequence += 1;
  const condition = bodyConditionSchema.parse({
    id: conditionId,
    actorId: input.actorId,
    key: "asleep",
    onsetAtStorySecond: input.view.storySecond,
    expiresAtStorySecond: input.expiresAtStorySecond,
    status: "active",
    sourceEventId: conditionEvent.id,
  });
  const [suspendSpec] = normalizeConditionModifierSpecs("asleep", []);
  if (!suspendSpec) throw new Error("Sleep normalization produced no suspend spec");
  const suspendModifier = modifierFromSpec({
    spec: suspendSpec,
    modifierId: deriveBodyModifierId(input.view.branchId, input.command.id, 0),
    actorId: input.actorId,
    fromStorySecond: input.view.storySecond,
    sourceEventId: conditionEvent.id,
    conditionId,
    conditionExpiresAt: input.expiresAtStorySecond,
  });
  events.push(
    buildModifierAppliedEvent({
      view: input.view,
      command: input.command,
      sequence: nextSequence,
      suffix: "body-modifier-0",
      actorId: input.actorId,
      modifier: suspendModifier,
      meterView: input.energyView,
      valueAtApply: input.valueAtApply,
      causationId: conditionEvent.id,
    }),
  );
  nextSequence += 1;
  events.push(
    buildBodyTrigger({
      view: input.view,
      command: input.command,
      sequence: nextSequence,
      causationId: conditionEvent.id,
      actorId: input.actorId,
      suffix: "arm-condition-expiry",
      intent: {
        kind: bodyConditionExpiryTriggerKind,
        dueStorySecond: input.expiresAtStorySecond,
        uniquenessKey: bodyConditionExpiryUniquenessKey(conditionId),
        payload: { actorId: input.actorId, conditionId, basis: "expired" },
      },
    }),
  );
  nextSequence += 1;
  return { condition, suspendModifier, events, nextSequence };
}
