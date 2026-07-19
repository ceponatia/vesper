import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { activityInterruptedEventSchema, type ActivityInstance } from "@/contracts/simulation/activities";
import type { Engagement } from "@/contracts/simulation/engagements";
import {
  METER_FIXED_POINT_ONE,
  bodiesProjectionSchema,
  bodyConditionSchema,
  bodyConditionAppliedEventSchema,
  bodyConditionEndedEventSchema,
  bodyDerivationVersion,
  bodyInitializedEventSchema,
  bodyMeterRegistryByVersion,
  bodyMeterStateSchema,
  bodyModifierAppliedEventSchema,
  bodyModifierSchema,
  bodySourceAppliedEventSchema,
  bodyThresholdCrossedEventSchema,
  type ApplyBodyConditionCommand,
  type ApplyBodyConditionRejectionCode,
  type ApplyBodyModifierCommand,
  type ApplyBodyModifierRejectionCode,
  type ApplyBodySourceCommand,
  type ApplyBodySourceRejectionCode,
  type BodiesProjection,
  type BodyCondition,
  type BodyConditionAppliedEvent,
  type BodyConditionEndedEvent,
  type BodyInitializedEvent,
  type BodyMeterDefinition,
  type BodyMeterState,
  type BodyModifier,
  type BodyModifierAppliedEvent,
  type BodyModifierSpec,
  type BodyRhythmRow,
  type BodySourceAppliedEvent,
  type BodyThresholdCrossedEvent,
  type BodyThresholdDefinition,
  type EndBodyConditionCommand,
  type EndBodyConditionRejectionCode,
  type InitializeActorBodyCommand,
  type InitializeActorBodyRejectionCode,
  type ResolveBodyThresholdCommand,
  type ResolveBodyThresholdRejectionCode,
  type ScheduledBodyAdjustment,
  type ResolveBodyCollapseCommand,
  type ResolveBodyCollapseRejectionCode,
  AFTERGLOW_DURATION_SECONDS,
  COLLAPSE_SLEEP_SECONDS,
  COLLAPSE_SOLVE_HORIZON_SECONDS,
  bodyCollapsedEventSchema,
  ENERGY_SLEEP_RESTORE_CAP_FIXED_POINT,
  ENERGY_SLEEP_RESTORE_PER_HOUR_FIXED_POINT,
  EXERTION_HYGIENE_FRACTION_FIXED_POINT,
  SECONDS_PER_DAY,
  bodyModifierSpecSchema,
  rhythmSelfCareEffects,
} from "@/contracts/simulation/bodies";
import { composeSimulationId } from "@/contracts/simulation/identity";
import { simulationHash } from "./hash";
import { deriveCircadianPressure } from "./body-reads";
import { buildDepartureInterruptEvent } from "./engagements";
import {
  bodyCollapseTriggerKind,
  bodyConditionExpiryTriggerKind,
  bodyThresholdTriggerKind,
  schedulerDerivationVersion,
  triggerScheduledEventSchema,
  type TriggerScheduledEvent,
} from "@/contracts/simulation/scheduler";

/**
 * E5.1 pure body kernel (engine.spec §25.1–25.3). The substrate law: a meter
 * moves only through analytic drift and material sources; QUERIES NEVER
 * PERSIST. Every derived value is computed from the last material write in
 * one closed-form step, so a large skip and equivalent partitions produce the
 * same material outcomes by construction — there is no intermediate rounding
 * to diverge. Threshold times are solved against this same integration
 * function (binary search within a monotone piece), so a scheduled alarm and
 * the value it evaluates can never disagree.
 */

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Deterministic fixed-point 2^(-x) (engine.spec §32 — no libm transcendentals)
// ---------------------------------------------------------------------------

const EXP2_SCALE = 1_000_000;
const EXP2_FRACTION_BITS = 20;
/** c[i] = round(2^(-1/2^(i+1)) · EXP2_SCALE), so multiplying the constants for
 * a fraction's set bits composes 2^(-fraction) in pure integer math. */
const EXP2_FRACTION_CONSTANTS = [
  707107, 840896, 917004, 957603, 978572, 989228, 994599, 997296, 998647, 999323,
  999662, 999831, 999915, 999958, 999979, 999989, 999995, 999997, 999999, 999999,
] as const;
/** Beyond 2^-40 the scaled result is zero; skip the bit walk entirely. */
const EXP2_UNDERFLOW_WHOLE = 40;

/**
 * floor-ish deterministic EXP2_SCALE · 2^(-numerator/denominator) for
 * nonnegative integer inputs. Every intermediate stays a safe integer for
 * denominators up to 10^9 (the contract bound on half-lives).
 */
export function exp2NegativeFixedPoint(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0) {
    throw new RangeError("exp2 numerator must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new RangeError("exp2 denominator must be a positive safe integer");
  }
  const whole = Math.floor(numerator / denominator);
  if (whole >= EXP2_UNDERFLOW_WHOLE) return 0;
  const remainder = numerator - whole * denominator;
  const fraction = Math.floor((remainder * (1 << EXP2_FRACTION_BITS)) / denominator);
  let scaled = EXP2_SCALE;
  for (const [bit, constant] of EXP2_FRACTION_CONSTANTS.entries()) {
    if (fraction & (1 << (EXP2_FRACTION_BITS - 1 - bit))) {
      scaled = Math.floor((scaled * constant) / EXP2_SCALE);
    }
  }
  for (let halvings = 0; halvings < whole; halvings++) scaled = Math.floor(scaled / 2);
  return scaled;
}

// ---------------------------------------------------------------------------
// Piecewise analytic integration (engine.spec §25.2)
// ---------------------------------------------------------------------------

/** Alarms are re-solved on every material event; past this horizon none is armed. */
export const BODY_THRESHOLD_HORIZON_SECONDS = 2_592_000;

interface EffectiveDrift {
  kind: "none" | "linear" | "proportional_decay";
  targetFixedPoint: number;
  ratePerHourFixedPoint: number;
  halfLifeSeconds: number;
}

function driftTarget(definition: BodyMeterDefinition, baselineFixedPoint: number): number {
  const law = definition.driftLaw;
  if (law.kind === "none") return 0;
  return law.target.kind === "baseline" ? baselineFixedPoint : law.target.valueFixedPoint;
}

/** Modifiers live in [validFrom, validUntil): stacked per group, then composed. */
function modifiersLiveAt(modifiers: readonly BodyModifier[], second: number): BodyModifier[] {
  const live = modifiers.filter(
    (modifier) =>
      modifier.validFromStorySecond <= second &&
      (modifier.validUntilStorySecond === undefined || second < modifier.validUntilStorySecond),
  );
  const byGroup = new Map<string, BodyModifier>();
  for (const modifier of live) {
    const current = byGroup.get(modifier.stackingGroup);
    if (
      !current ||
      modifier.priority > current.priority ||
      (modifier.priority === current.priority && compareStableText(modifier.id, current.id) < 0)
    ) {
      byGroup.set(modifier.stackingGroup, modifier);
    }
  }
  return [...byGroup.values()].sort((left, right) => compareStableText(left.stackingGroup, right.stackingGroup));
}

function effectiveDrift(
  definition: BodyMeterDefinition,
  baselineFixedPoint: number,
  stacked: readonly BodyModifier[],
): EffectiveDrift {
  const law = definition.driftLaw;
  const target = driftTarget(definition, baselineFixedPoint);
  if (law.kind === "none") return { kind: "none", targetFixedPoint: target, ratePerHourFixedPoint: 0, halfLifeSeconds: 0 };
  if (stacked.some((modifier) => modifier.operation.kind === "suspend")) {
    return { kind: "none", targetFixedPoint: target, ratePerHourFixedPoint: 0, halfLifeSeconds: 0 };
  }
  if (law.kind === "linear") {
    let rate = law.ratePerHourFixedPoint;
    for (const modifier of stacked) {
      if (modifier.operation.kind === "rate_multiplier") {
        rate = Math.floor((rate * modifier.operation.multiplierFixedPoint) / METER_FIXED_POINT_ONE);
      }
    }
    for (const modifier of stacked) {
      if (modifier.operation.kind === "rate_add") rate += modifier.operation.ratePerHourFixedPoint;
    }
    // The composed rate stays an approach speed; a negative sum flees the
    // target, which the drift step interprets as movement away, clamped to
    // the meter range.
    return { kind: "linear", targetFixedPoint: target, ratePerHourFixedPoint: rate, halfLifeSeconds: 0 };
  }
  let halfLife = law.halfLifeSeconds;
  for (const modifier of stacked) {
    if (modifier.operation.kind === "rate_multiplier") {
      if (modifier.operation.multiplierFixedPoint === 0) {
        return { kind: "none", targetFixedPoint: target, ratePerHourFixedPoint: 0, halfLifeSeconds: 0 };
      }
      halfLife = Math.max(
        1,
        Math.floor((halfLife * METER_FIXED_POINT_ONE) / modifier.operation.multiplierFixedPoint),
      );
    }
  }
  return { kind: "proportional_decay", targetFixedPoint: target, ratePerHourFixedPoint: 0, halfLifeSeconds: halfLife };
}

function clampMeter(value: number): number {
  return Math.max(0, Math.min(METER_FIXED_POINT_ONE, value));
}

/** One closed-form drift step under a constant modifier set. */
function driftStep(valueFixedPoint: number, drift: EffectiveDrift, elapsedSeconds: number): number {
  if (elapsedSeconds <= 0 || drift.kind === "none") return valueFixedPoint;
  if (drift.kind === "linear") {
    const magnitude = Math.floor((Math.abs(drift.ratePerHourFixedPoint) * elapsedSeconds) / 3_600);
    if (drift.ratePerHourFixedPoint >= 0) {
      // Approach: move toward the target and stop there.
      if (valueFixedPoint > drift.targetFixedPoint) {
        return Math.max(drift.targetFixedPoint, valueFixedPoint - magnitude);
      }
      return Math.min(drift.targetFixedPoint, valueFixedPoint + magnitude);
    }
    // Negative composed rate: flee the target, clamped to the meter range.
    if (valueFixedPoint >= drift.targetFixedPoint) return clampMeter(valueFixedPoint + magnitude);
    return clampMeter(valueFixedPoint - magnitude);
  }
  const scaled = exp2NegativeFixedPoint(elapsedSeconds, drift.halfLifeSeconds);
  const distance = Math.abs(valueFixedPoint - drift.targetFixedPoint);
  const remaining = Math.floor((distance * scaled) / EXP2_SCALE);
  return valueFixedPoint >= drift.targetFixedPoint
    ? drift.targetFixedPoint + remaining
    : drift.targetFixedPoint - remaining;
}

export interface MeterIntegrationView {
  definition: BodyMeterDefinition;
  state: BodyMeterState;
  /** Every modifier row for this actor + meter, any validity. */
  modifiers: readonly BodyModifier[];
  /**
   * E5.2 rhythm self-care as data: absolute-second set/add jumps the
   * integration folds as boundaries (§25.5 window crossing — deterministic
   * clock points, so no per-day tick or trigger is ever needed). Entries at
   * or before the last material write are already folded into the persisted
   * value and are ignored.
   */
  scheduledAdjustments?: readonly ScheduledBodyAdjustment[];
}

function compareAdjustments(left: ScheduledBodyAdjustment, right: ScheduledBodyAdjustment): number {
  return (
    left.atStorySecond - right.atStorySecond ||
    compareStableText(left.operation.kind, right.operation.kind) ||
    (left.operation.kind === "add" && right.operation.kind === "add"
      ? left.operation.deltaFixedPoint - right.operation.deltaFixedPoint
      : left.operation.kind === "set" && right.operation.kind === "set"
        ? left.operation.valueFixedPoint - right.operation.valueFixedPoint
        : 0)
  );
}

function applyAdjustment(
  valueFixedPoint: number,
  adjustment: ScheduledBodyAdjustment,
  baselineFixedPoint: number,
): number {
  switch (adjustment.operation.kind) {
    case "set":
      return adjustment.operation.valueFixedPoint;
    case "add":
      return clampMeter(valueFixedPoint + adjustment.operation.deltaFixedPoint);
    case "reset_to_baseline":
      return baselineFixedPoint;
  }
}

/** Adjustments falling in (from, to], in deterministic application order. */
function adjustmentsBetween(
  view: MeterIntegrationView,
  fromSecond: number,
  toSecond: number,
): ScheduledBodyAdjustment[] {
  return [...(view.scheduledAdjustments ?? [])]
    .filter((adjustment) => adjustment.atStorySecond > fromSecond && adjustment.atStorySecond <= toSecond)
    .sort(compareAdjustments);
}

/** Piece cut points in (from, to): modifier boundaries and adjustment seconds. */
function integrationBoundaries(
  view: MeterIntegrationView,
  fromSecond: number,
  toSecond: number,
): number[] {
  const boundaries = new Set<number>();
  for (const modifier of view.modifiers) {
    for (const boundary of [modifier.validFromStorySecond, modifier.validUntilStorySecond]) {
      if (boundary !== undefined && boundary > fromSecond && boundary < toSecond) boundaries.add(boundary);
    }
  }
  for (const adjustment of adjustmentsBetween(view, fromSecond, toSecond)) {
    if (adjustment.atStorySecond < toSecond) boundaries.add(adjustment.atStorySecond);
  }
  return [...boundaries].sort((left, right) => left - right);
}

/**
 * The pure, total query read: integrate piecewise across modifier and
 * self-care boundaries from the last material write. Never persists (§25.2 —
 * that is what makes partition invariance structural).
 */
export function integrateMeterValue(view: MeterIntegrationView, atStorySecond: number): number {
  const from = view.state.lastIntegratedAtStorySecond;
  if (atStorySecond <= from) return view.state.valueFixedPoint;
  const cuts = integrationBoundaries(view, from, atStorySecond);
  let value = view.state.valueFixedPoint;
  let cursor = from;
  for (const boundary of [...cuts, atStorySecond]) {
    const drift = effectiveDrift(
      view.definition,
      view.state.baselineFixedPoint,
      modifiersLiveAt(view.modifiers, cursor),
    );
    value = driftStep(value, drift, boundary - cursor);
    for (const adjustment of adjustmentsBetween(view, cursor, boundary)) {
      if (adjustment.atStorySecond === boundary) {
        value = applyAdjustment(value, adjustment, view.state.baselineFixedPoint);
      }
    }
    cursor = boundary;
  }
  return value;
}

export interface ThresholdCrossing {
  threshold: BodyThresholdDefinition;
  crossesAtStorySecond: number;
  valueAtCrossingFixedPoint: number;
}

function thresholdCrossed(threshold: BodyThresholdDefinition, valueFixedPoint: number): boolean {
  return threshold.direction === "falling"
    ? valueFixedPoint <= threshold.boundaryFixedPoint
    : valueFixedPoint >= threshold.boundaryFixedPoint;
}

/**
 * The earliest future material threshold, solved against the integration
 * function itself: per monotone piece, detect a sign change, then binary
 * search the first second on the crossed side. Exact by construction — the
 * scheduled second re-evaluates to a crossed value at fire time.
 */
export function solveNextThresholdCrossing(
  view: MeterIntegrationView,
  fromStorySecond: number,
  horizonSeconds: number = BODY_THRESHOLD_HORIZON_SECONDS,
): ThresholdCrossing | undefined {
  const valueNow = integrateMeterValue(view, fromStorySecond);
  const armable = view.definition.thresholds.filter((threshold) => !thresholdCrossed(threshold, valueNow));
  if (armable.length === 0) return undefined;
  const end = fromStorySecond + horizonSeconds;
  const pieceEnds = [...integrationBoundaries(view, fromStorySecond, end), end];

  let best: ThresholdCrossing | undefined;
  for (const threshold of armable) {
    let pieceStart = fromStorySecond;
    for (const pieceEnd of pieceEnds) {
      if (best && pieceStart >= best.crossesAtStorySecond) break;
      const valueAtStart = integrateMeterValue(view, pieceStart);
      const candidate = ((): ThresholdCrossing | undefined => {
        // A jump at the piece start (self-care landing on the crossed side)
        // is itself the crossing second.
        if (pieceStart > fromStorySecond && thresholdCrossed(threshold, valueAtStart)) {
          return { threshold, crossesAtStorySecond: pieceStart, valueAtCrossingFixedPoint: valueAtStart };
        }
        // Drift-only within the piece: monotone, so a sign change at the
        // pre-jump end pins the crossing inside; binary search it.
        const drift = effectiveDrift(
          view.definition,
          view.state.baselineFixedPoint,
          modifiersLiveAt(view.modifiers, pieceStart),
        );
        const preJumpEnd = driftStep(valueAtStart, drift, pieceEnd - pieceStart);
        if (!thresholdCrossed(threshold, preJumpEnd)) return undefined;
        let low = pieceStart;
        let high = pieceEnd;
        while (low + 1 < high) {
          const mid = low + Math.floor((high - low) / 2);
          if (thresholdCrossed(threshold, driftStep(valueAtStart, drift, mid - pieceStart))) high = mid;
          else low = mid;
        }
        // Verify against the full oracle: an adjustment landing exactly on
        // the crossing second may preempt it (washed at the very minute the
        // meter would have crossed) — then this piece produces no alarm.
        const oracleValue = integrateMeterValue(view, high);
        if (!thresholdCrossed(threshold, oracleValue)) return undefined;
        return { threshold, crossesAtStorySecond: high, valueAtCrossingFixedPoint: oracleValue };
      })();
      if (candidate) {
        if (
          !best ||
          candidate.crossesAtStorySecond < best.crossesAtStorySecond ||
          (candidate.crossesAtStorySecond === best.crossesAtStorySecond &&
            compareStableText(candidate.threshold.key, best.threshold.key) < 0)
        ) {
          best = candidate;
        }
        break;
      }
      pieceStart = pieceEnd;
    }
  }
  return best;
}

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
// E5.2 — rhythm self-care and the sleep coupling (engine.spec §25.4–25.5)
// ---------------------------------------------------------------------------

/**
 * Window-crossing self-care (§25.5): each rhythm row whose kind carries a
 * self-care effect lands that effect at its window-END minute, every story
 * day. A skip credits only the crossings it actually contains — landing at
 * 6am (before a 7am wash) and landing at 8am (past it) genuinely differ, and
 * nothing ever blanket-restores. Crossings are deterministic clock points,
 * so they enter integration as {@link ScheduledBodyAdjustment}s — no per-day
 * tick, no trigger, no persistence.
 */
export function selfCareAdjustmentsBetween(
  rhythmRows: readonly BodyRhythmRow[],
  meterKey: string,
  fromSecondExclusive: number,
  toSecondInclusive: number,
): ScheduledBodyAdjustment[] {
  const adjustments: ScheduledBodyAdjustment[] = [];
  for (const row of rhythmRows) {
    const effect = rhythmSelfCareEffects[row.kind];
    if (!effect || effect.meterKey !== meterKey) continue;
    const firstDay = Math.max(0, Math.floor(fromSecondExclusive / SECONDS_PER_DAY) - 1);
    const lastDay = Math.floor(toSecondInclusive / SECONDS_PER_DAY) + 1;
    for (let day = firstDay; day <= lastDay; day += 1) {
      const atStorySecond = day * SECONDS_PER_DAY + row.endMinuteOfDay * 60;
      if (atStorySecond > fromSecondExclusive && atStorySecond <= toSecondInclusive) {
        adjustments.push({ atStorySecond, operation: effect.operation });
      }
    }
  }
  return adjustments.sort((left, right) => left.atStorySecond - right.atStorySecond);
}

/**
 * The §25.4 sleep coupling, half one: falling asleep suspends the energy
 * reserve's decay. Callers may pass their own energy modifier; otherwise the
 * suspend is attached deterministically so no caller can model sleep without
 * its body consequence.
 */
export function normalizeConditionModifierSpecs(
  conditionKey: string,
  specs: readonly BodyModifierSpec[],
): BodyModifierSpec[] {
  if (conditionKey !== "asleep" || specs.some((spec) => spec.meterKey === "energy")) {
    return [...specs];
  }
  return [
    ...specs,
    bodyModifierSpecSchema.parse({
      meterKey: "energy",
      operation: { kind: "suspend" },
      stackingGroup: "sleep",
      priority: 0,
      visibility: "obvious",
    }),
  ];
}

/**
 * The §25.4 sleep coupling, half two: waking credits the reserve linearly by
 * time actually slept (+0.09/h), capped at 0.95 — a full night from a normal
 * bedtime refills; a full night after a bender reaches only ~0.80, so debt
 * emerges with no debt mechanic. Linear credit composes exactly, so split
 * sleep partitions to the same material result.
 */
export function deriveSleepCredit(input: {
  sleptSeconds: number;
  reserveAtWakeFixedPoint: number;
}): number {
  if (input.sleptSeconds <= 0) return 0;
  const rawCredit = Math.floor(
    (ENERGY_SLEEP_RESTORE_PER_HOUR_FIXED_POINT * input.sleptSeconds) / 3_600,
  );
  const headroom = Math.max(0, ENERGY_SLEEP_RESTORE_CAP_FIXED_POINT - input.reserveAtWakeFixedPoint);
  return Math.min(rawCredit, headroom);
}

// ---------------------------------------------------------------------------
// Shared resolver plumbing
// ---------------------------------------------------------------------------

interface BodyBranchMeta {
  worldId: string;
  branchId: string;
  rulesetVersion: string;
  headSequence: number;
  storySecond: number;
}

interface BodyRejection<TCode extends string> {
  ok: false;
  code: TCode;
  publicReason: string;
}

function rejection<TCode extends string>(code: TCode, publicReason: string): BodyRejection<TCode> {
  return { ok: false, code, publicReason };
}

type BodyCommand =
  | InitializeActorBodyCommand
  | ApplyBodySourceCommand
  | ApplyBodyModifierCommand
  | ApplyBodyConditionCommand
  | EndBodyConditionCommand
  | ResolveBodyThresholdCommand
  | ResolveBodyCollapseCommand;

function actorControlledBy(command: BodyCommand, actorId: string): boolean {
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

function eventEnvelope(view: BodyBranchMeta, command: BodyCommand, sequence: number, suffix: string) {
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

function capturedDerivation(view: MeterIntegrationView, atStorySecond: number) {
  return {
    fromValueFixedPoint: view.state.valueFixedPoint,
    fromStorySecond: view.state.lastIntegratedAtStorySecond,
    activeModifierIds: modifiersLiveAt(view.modifiers, atStorySecond)
      .map((modifier) => modifier.id)
      .sort(compareStableText),
    registryVersion: bodyDerivationVersion,
  };
}

function buildBodyTrigger(input: {
  view: BodyBranchMeta;
  command: BodyCommand;
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
function rearmThresholdTrigger(input: {
  view: BodyBranchMeta;
  command: BodyCommand;
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
// InitializeActorBody (engine.spec §25.1; seeds the substrate for one actor)
// ---------------------------------------------------------------------------

export interface InitializeActorBodyResolutionView extends BodyBranchMeta {
  actorExists: boolean;
  alreadyInitialized: boolean;
  /** E5.2: rhythm crossings per meter so initial alarms see future self-care. */
  selfCareAdjustmentsByMeter?: ReadonlyMap<string, readonly ScheduledBodyAdjustment[]>;
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
  if (view.alreadyInitialized) {
    return rejection("body_already_initialized", "That body already exists.");
  }
  const registry = bodyMeterRegistryByVersion[command.payload.registryVersion];
  const knownKeys = new Set(registry.map((definition) => definition.key));
  for (const overrideKey of Object.keys(command.payload.baselineOverrides)) {
    if (!knownKeys.has(overrideKey)) {
      return rejection("unknown_meter_key", "That body meter is unknown.");
    }
  }

  const meters = registry.map((definition) =>
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
  return { ok: true, meters, events: [initialized, ...triggers] };
}

// ---------------------------------------------------------------------------
// ApplyBodySource (engine.spec §25.1 layer 2 — material sources)
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
  /** The exertion coupling's hygiene write, when it fired (§25.4). */
  coupledMeter?: BodyMeterState;
  /** The climax coupling's afterglow condition, when it fired (§25.4). */
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

  const meterView: MeterIntegrationView = {
    definition: view.definition,
    state: view.meter,
    modifiers: view.modifiers,
    scheduledAdjustments: view.scheduledAdjustments ?? [],
  };
  const integrated = integrateMeterValue(meterView, view.storySecond);
  const operation = command.payload.operation;
  const valueAfter = sourceValueAfter(operation, integrated, view.meter.baselineFixedPoint);

  const event = bodySourceAppliedEventSchema.parse({
    ...eventEnvelope(view, command, view.headSequence + 1, "body-source"),
    type: "body_source_applied",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      meterKey: command.payload.meterKey,
      sourceKind: command.payload.sourceKind,
      operation,
      valueAfterFixedPoint: valueAfter,
      derived: capturedDerivation(meterView, view.storySecond),
    },
  });

  const nextState = bodyMeterStateSchema.parse({
    ...view.meter,
    valueFixedPoint: valueAfter,
    lastIntegratedAtStorySecond: view.storySecond,
  });

  const trailing: (BodySourceAppliedEvent | BodyConditionAppliedEvent | TriggerScheduledEvent)[] = [];
  let nextSequence = event.sequence + 1;
  let coupledMeter: BodyMeterState | undefined;
  let condition: BodyCondition | undefined;

  // §25.4 exertion coupling: working the body also costs freshness — a
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

  // §25.4 climax coupling: the reset installs afterglow as a self-expiring
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

// ---------------------------------------------------------------------------
// ApplyBodyModifier (engine.spec §25.3 — the one modifier contract)
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
  command: BodyCommand;
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
// ApplyBodyCondition (engine.spec §25.1 — categorical, sourced, self-expiring)
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
  // The §25.4 sleep coupling: an asleep condition always suspends energy.
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
  // additionally credits the energy reserve by time actually slept (§25.4 —
  // the coupling's second half), emitted as a real sleep_credit source so the
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

// ---------------------------------------------------------------------------
// E5.2 slice 2b — collapse at the saturated read floor (OQ1's −1 pole)
// ---------------------------------------------------------------------------

export interface CollapseContext {
  rhythmRows: readonly BodyRhythmRow[];
  /**
   * When the actor last actually finished sleeping. Absent means no real
   * sleep history exists — the pressure curve then assumes the rhythm was
   * followed, escalation never accrues, and collapse is unreachable, so
   * alarms arm only for actors whose wakefulness the engine has witnessed.
   */
  lastSleepEndedAtStorySecond?: number;
}

export interface CollapseCrossing {
  crossesAtStorySecond: number;
  reserveFixedPoint: number;
  pressureFixedPoint: number;
}

function collapseReadAt(
  energyView: MeterIntegrationView,
  context: CollapseContext,
  atStorySecond: number,
): { reserveFixedPoint: number; pressureFixedPoint: number; collapsed: boolean } {
  const reserveFixedPoint = integrateMeterValue(energyView, atStorySecond);
  const pressureFixedPoint = deriveCircadianPressure({
    atStorySecond,
    rhythmRows: context.rhythmRows,
    ...(context.lastSleepEndedAtStorySecond === undefined
      ? {}
      : { lastSleepEndedAtStorySecond: context.lastSleepEndedAtStorySecond }),
  });
  return {
    reserveFixedPoint,
    pressureFixedPoint,
    collapsed: reserveFixedPoint - pressureFixedPoint <= -METER_FIXED_POINT_ONE,
  };
}

/**
 * The first second the energy read saturates its floor: reserve(t) −
 * pressure(t) ≤ −1. Pressure is time-varying (anchors + escalation), so this
 * scans at minute resolution and refines the found minute to its first
 * crossed second — conservative by under a minute at worst, exact at the
 * armed second, and always re-validated at fire time. Emergent: with the
 * reference rhythm this lands near 40 hours awake, from no hardcoded hour.
 */
export function solveCollapseCrossing(input: {
  energyView: MeterIntegrationView;
  context: CollapseContext;
  fromStorySecond: number;
  horizonSeconds?: number;
}): CollapseCrossing | undefined {
  if (input.context.lastSleepEndedAtStorySecond === undefined) return undefined;
  const horizon = input.horizonSeconds ?? COLLAPSE_SOLVE_HORIZON_SECONDS;
  const end = input.fromStorySecond + horizon;
  let previous = input.fromStorySecond;
  for (let at = input.fromStorySecond; at <= end; at += 60) {
    const sample = collapseReadAt(input.energyView, input.context, at);
    if (sample.collapsed) {
      for (let second = at === input.fromStorySecond ? at : previous + 1; second <= at; second += 1) {
        const exact = collapseReadAt(input.energyView, input.context, second);
        if (exact.collapsed) {
          return {
            crossesAtStorySecond: second,
            reserveFixedPoint: exact.reserveFixedPoint,
            pressureFixedPoint: exact.pressureFixedPoint,
          };
        }
      }
    }
    previous = at;
  }
  return undefined;
}

export function bodyCollapseUniquenessKey(actorId: string, armedAtSequence: number): string {
  return composeSimulationId("body-collapse", [actorId, String(armedAtSequence)]);
}

/** Prefix matching every armed collapse alarm for one actor. */
export function bodyCollapseUniquenessKeyPrefix(actorId: string): string {
  return `${composeSimulationId("body-collapse", [actorId])}:`;
}

/** Re-solve one actor's collapse alarm after an energy or sleep material event. */
function rearmCollapseTrigger(input: {
  view: BodyBranchMeta;
  command: BodyCommand;
  actorId: string;
  energyView: MeterIntegrationView;
  context: CollapseContext | undefined;
  sequence: number;
  causationId: string;
  armedAtSequence: number;
}): TriggerScheduledEvent | undefined {
  if (!input.context) return undefined;
  const crossing = solveCollapseCrossing({
    energyView: input.energyView,
    context: input.context,
    fromStorySecond: input.view.storySecond,
  });
  if (!crossing) return undefined;
  return buildBodyTrigger({
    view: input.view,
    command: input.command,
    sequence: input.sequence,
    causationId: input.causationId,
    actorId: input.actorId,
    suffix: "arm-collapse",
    intent: {
      kind: bodyCollapseTriggerKind,
      dueStorySecond: crossing.crossesAtStorySecond,
      uniquenessKey: bodyCollapseUniquenessKey(input.actorId, input.armedAtSequence),
      payload: { actorId: input.actorId, armedAtSequence: input.armedAtSequence },
    },
  });
}

export interface ResolveBodyCollapseResolutionView extends BodyBranchMeta {
  meter?: BodyMeterState;
  definition?: BodyMeterDefinition;
  modifiers: readonly BodyModifier[];
  scheduledAdjustments?: readonly ScheduledBodyAdjustment[];
  collapseContext?: CollapseContext;
  /** A live asleep condition means the body already got what it demanded. */
  activeAsleep: boolean;
  /** The actor's claim-holding activities, to interrupt (sorted by store). */
  interruptibleActivities: readonly ActivityInstance[];
  /** The actor's open co-present engagements, to interrupt. */
  openEngagements: readonly Engagement[];
  coLocatedActorIds: readonly string[];
}

export interface ResolveBodyCollapseResolution {
  ok: true;
  meter: BodyMeterState;
  condition: BodyCondition;
  modifiers: BodyModifier[];
  interruptedActivityIds: string[];
  interruptedEngagementIds: string[];
  events: SimulationBranchEvent[];
}

export function resolveBodyCollapse(
  view: ResolveBodyCollapseResolutionView,
  command: ResolveBodyCollapseCommand,
): BodyRejection<ResolveBodyCollapseRejectionCode> | ResolveBodyCollapseResolution {
  if (command.branchId !== view.branchId) {
    return rejection("branch_mismatch", "That world branch is unavailable.");
  }
  if (command.principal.kind !== "system") {
    return rejection("unauthorized_principal", "Bodies give out on the world's clock only.");
  }
  if (!view.meter || !view.definition) {
    return rejection("body_not_initialized", "That body is not tracked.");
  }
  if (view.activeAsleep || !view.collapseContext) {
    return rejection("collapse_stale", "That body already found sleep.");
  }
  const energyView: MeterIntegrationView = {
    definition: view.definition,
    state: view.meter,
    modifiers: view.modifiers,
    scheduledAdjustments: view.scheduledAdjustments ?? [],
  };
  const now = collapseReadAt(energyView, view.collapseContext, view.storySecond);
  if (!now.collapsed) {
    // A material event moved the trajectory after arming; its own commit
    // retired this alarm's replay entry and re-armed the live one.
    return rejection("collapse_stale", "That body is no longer at its limit.");
  }

  const observerActorIds = [...new Set(view.coLocatedActorIds)].sort(compareStableText);
  const events: SimulationBranchEvent[] = [];
  let nextSequence = view.headSequence + 1;

  const collapsedEvent = bodyCollapsedEventSchema.parse({
    ...eventEnvelope(view, command, nextSequence, "body-collapsed"),
    type: "body_collapsed",
    actorIds: [command.payload.actorId],
    entityIds: [command.payload.actorId],
    payload: {
      actorId: command.payload.actorId,
      reserveFixedPoint: now.reserveFixedPoint,
      pressureFixedPoint: now.pressureFixedPoint,
      readSignedFixedPoint: Math.max(
        -METER_FIXED_POINT_ONE,
        Math.min(METER_FIXED_POINT_ONE, now.reserveFixedPoint - now.pressureFixedPoint),
      ),
      observerActorIds,
      derived: capturedDerivation(energyView, view.storySecond),
    },
  });
  events.push(collapsedEvent);
  nextSequence += 1;

  // The world does not pause for a body: every held activity and open scene
  // breaks in the same transaction (§18.2 — one body, one physical scene).
  const interruptedActivityIds: string[] = [];
  for (const activity of [...view.interruptibleActivities].sort((a, b) => compareStableText(a.id, b.id))) {
    const total =
      activity.startedAt !== undefined && activity.expectedCompleteAt !== undefined
        ? activity.expectedCompleteAt - activity.startedAt
        : 0;
    const elapsed = activity.startedAt !== undefined ? view.storySecond - activity.startedAt : 0;
    const progressFixedPoint =
      total > 0 ? Math.max(0, Math.min(1_000_000, Math.floor((elapsed * 1_000_000) / total))) : activity.progressFixedPoint;
    events.push(
      activityInterruptedEventSchema.parse({
        ...eventEnvelope(view, command, nextSequence, `interrupt-activity-${activity.id}`),
        type: "activity_interrupted",
        causationId: collapsedEvent.id,
        actorIds: activity.actorIds,
        entityIds: [...new Set<string>([activity.id, ...activity.actorIds])].sort(compareStableText),
        payload: {
          activityInstanceId: activity.id,
          interruptedAt: view.storySecond,
          reason: "collapse",
          progressFixedPoint,
        },
      }),
    );
    interruptedActivityIds.push(activity.id);
    nextSequence += 1;
  }

  const interruptedEngagementIds: string[] = [];
  for (const engagement of [...view.openEngagements].sort((a, b) => compareStableText(a.id, b.id))) {
    events.push(
      buildDepartureInterruptEvent({
        meta: {
          worldId: view.worldId,
          branchId: view.branchId,
          rulesetVersion: view.rulesetVersion,
          headSequence: nextSequence - 1,
          storySecond: view.storySecond,
        },
        command,
        engagement,
        sequence: nextSequence,
        causationId: collapsedEvent.id,
        reason: "participant_collapsed",
      }),
    );
    interruptedEngagementIds.push(engagement.id);
    nextSequence += 1;
  }

  // Collapse IS forced sleep: the asleep condition with its energy suspend,
  // self-expiring after the sleep the body was denied.
  const conditionId = deriveBodyConditionId(view.branchId, command.id);
  const expiresAt = view.storySecond + COLLAPSE_SLEEP_SECONDS;
  const conditionEvent = bodyConditionAppliedEventSchema.parse({
    ...eventEnvelope(view, command, nextSequence, "body-condition"),
    type: "body_condition_applied",
    causationId: collapsedEvent.id,
    actorIds: [command.payload.actorId],
    entityIds: [conditionId],
    payload: {
      actorId: command.payload.actorId,
      conditionId,
      conditionKey: "asleep",
      onsetAtStorySecond: view.storySecond,
      expiresAtStorySecond: expiresAt,
      observerActorIds,
    },
  });
  events.push(conditionEvent);
  nextSequence += 1;
  const condition = bodyConditionSchema.parse({
    id: conditionId,
    actorId: command.payload.actorId,
    key: "asleep",
    onsetAtStorySecond: view.storySecond,
    expiresAtStorySecond: expiresAt,
    status: "active",
    sourceEventId: conditionEvent.id,
  });

  const [suspendSpec] = normalizeConditionModifierSpecs("asleep", []);
  if (!suspendSpec) throw new Error("Collapse normalization produced no suspend spec");
  const suspendModifier = modifierFromSpec({
    spec: suspendSpec,
    modifierId: deriveBodyModifierId(view.branchId, command.id, 0),
    actorId: command.payload.actorId,
    fromStorySecond: view.storySecond,
    sourceEventId: conditionEvent.id,
    conditionId,
    conditionExpiresAt: expiresAt,
  });
  events.push(
    buildModifierAppliedEvent({
      view,
      command,
      sequence: nextSequence,
      suffix: "body-modifier-0",
      actorId: command.payload.actorId,
      modifier: suspendModifier,
      meterView: energyView,
      valueAtApply: now.reserveFixedPoint,
      causationId: conditionEvent.id,
    }),
  );
  nextSequence += 1;

  events.push(
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

  const meter = bodyMeterStateSchema.parse({
    ...view.meter,
    valueFixedPoint: now.reserveFixedPoint,
    lastIntegratedAtStorySecond: view.storySecond,
  });
  return {
    ok: true,
    meter,
    condition,
    modifiers: [suspendModifier],
    interruptedActivityIds,
    interruptedEngagementIds,
    events,
  };
}

// ---------------------------------------------------------------------------
// Bodies projection: projectors and replay
// ---------------------------------------------------------------------------

export function sortBodiesProjection(projection: BodiesProjection): BodiesProjection {
  return bodiesProjectionSchema.parse({
    ...projection,
    meters: [...projection.meters].sort(
      (left, right) =>
        compareStableText(left.actorId, right.actorId) || compareStableText(left.meterKey, right.meterKey),
    ),
    conditions: [...projection.conditions].sort((left, right) => compareStableText(left.id, right.id)),
    modifiers: [...projection.modifiers].sort((left, right) => compareStableText(left.id, right.id)),
  });
}

function replaceMeter(
  meters: readonly BodyMeterState[],
  actorId: string,
  meterKey: string,
  eventType: string,
  valueFixedPoint: number,
  storySecond: number,
): BodyMeterState[] {
  const existing = meters.find(
    (candidate) => candidate.actorId === actorId && candidate.meterKey === meterKey,
  );
  if (!existing) throw new Error(`${eventType} replay references a missing body meter`);
  const next = bodyMeterStateSchema.parse({
    ...existing,
    valueFixedPoint,
    lastIntegratedAtStorySecond: storySecond,
  });
  return meters.map((candidate) =>
    candidate.actorId === actorId && candidate.meterKey === meterKey ? next : candidate,
  );
}

/** Pure synchronous projector for the body event family. */
export function applyBodyEvent(
  projection: BodiesProjection,
  event: SimulationBranchEvent,
): BodiesProjection {
  const bumped = { ...projection, headSequence: event.sequence, storySecond: event.storySecond };
  switch (event.type) {
    case "body_initialized": {
      const meters = event.payload.meters.map((meter) =>
        bodyMeterStateSchema.parse({
          actorId: event.payload.actorId,
          meterKey: meter.meterKey,
          valueFixedPoint: meter.valueFixedPoint,
          baselineFixedPoint: meter.baselineFixedPoint,
          lastIntegratedAtStorySecond: event.storySecond,
          registryVersion: event.payload.registryVersion,
        }),
      );
      return sortBodiesProjection({ ...bumped, meters: [...projection.meters, ...meters] });
    }
    case "body_source_applied":
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAfterFixedPoint,
          event.storySecond,
        ),
      });
    case "body_modifier_applied": {
      const modifier = bodyModifierSchema.parse({
        id: event.payload.modifierId,
        actorId: event.payload.actorId,
        meterKey: event.payload.meterKey,
        operation: event.payload.operation,
        stackingGroup: event.payload.stackingGroup,
        priority: event.payload.priority,
        validFromStorySecond: event.payload.validFromStorySecond,
        ...(event.payload.validUntilStorySecond === undefined
          ? {}
          : { validUntilStorySecond: event.payload.validUntilStorySecond }),
        visibility: event.payload.visibility,
        ...(event.payload.conditionId === undefined ? {} : { conditionId: event.payload.conditionId }),
        sourceEventId: event.payload.conditionId === undefined ? event.id : event.causationId ?? event.id,
      });
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAtApplyFixedPoint,
          event.storySecond,
        ),
        modifiers: [...projection.modifiers, modifier],
      });
    }
    case "body_condition_applied": {
      const condition = bodyConditionSchema.parse({
        id: event.payload.conditionId,
        actorId: event.payload.actorId,
        key: event.payload.conditionKey,
        onsetAtStorySecond: event.payload.onsetAtStorySecond,
        ...(event.payload.expiresAtStorySecond === undefined
          ? {}
          : { expiresAtStorySecond: event.payload.expiresAtStorySecond }),
        status: "active",
        sourceEventId: event.id,
      });
      return sortBodiesProjection({ ...bumped, conditions: [...projection.conditions, condition] });
    }
    case "body_condition_ended": {
      const existing = projection.conditions.find((candidate) => candidate.id === event.payload.conditionId);
      if (!existing) throw new Error("body_condition_ended replay references a missing condition");
      const ended = bodyConditionSchema.parse({
        ...existing,
        status: "ended",
        endBasis: event.payload.basis,
        endedAtStorySecond: event.payload.endedAtStorySecond,
      });
      const retiredIds = new Set(event.payload.retiredModifiers.map((retired) => retired.modifierId));
      return sortBodiesProjection({
        ...bumped,
        conditions: projection.conditions.map((candidate) =>
          candidate.id === ended.id ? ended : candidate,
        ),
        modifiers: projection.modifiers.map((modifier) =>
          retiredIds.has(modifier.id)
            ? bodyModifierSchema.parse({
                ...modifier,
                validUntilStorySecond: Math.max(
                  event.payload.endedAtStorySecond,
                  modifier.validFromStorySecond + 1,
                ),
              })
            : modifier,
        ),
      });
    }
    case "body_threshold_crossed":
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          event.payload.meterKey,
          event.type,
          event.payload.valueAtCrossingFixedPoint,
          event.storySecond,
        ),
      });
    case "body_collapsed":
      // The read gave out; the reserve persists at its integrated value and
      // the forced sleep rides the condition/modifier events that follow.
      return sortBodiesProjection({
        ...bumped,
        meters: replaceMeter(
          projection.meters,
          event.payload.actorId,
          "energy",
          event.type,
          event.payload.reserveFixedPoint,
          event.storySecond,
        ),
      });
    case "item_transferred":
    case "item_destroyed":
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
      // Non-body families advance the boundary without touching this projection.
      return bodiesProjectionSchema.parse(bumped);
  }
}

export interface BodiesReplayInput {
  /** Bodies are fully evented: a branch-origin seed holds none (plan R3). */
  seed: BodiesProjection;
  events: readonly SimulationBranchEvent[];
}

/** Fold one branch's full logical stream into its bodies projection. */
export function replayBodiesHistory(input: BodiesReplayInput): BodiesProjection {
  const seed = sortBodiesProjection(bodiesProjectionSchema.parse(input.seed));
  const events = [...input.events].sort((left, right) => left.sequence - right.sequence);
  let projection = seed;
  const commandIds = new Set<string>();
  let lastSequence = seed.headSequence;
  for (const event of events) {
    if (event.sequence !== lastSequence + 1) {
      throw new Error(`Bodies replay sequence gap: expected ${lastSequence + 1}, received ${event.sequence}`);
    }
    if (event.commandId) commandIds.add(event.commandId);
    projection = applyBodyEvent(projection, event);
    lastSequence = event.sequence;
  }
  return bodiesProjectionSchema.parse({
    ...projection,
    version: seed.version + commandIds.size,
  });
}

/** The empty branch-origin bodies seed. */
export function emptyBodiesSeed(branchId: string, originStorySecond: number): BodiesProjection {
  return bodiesProjectionSchema.parse({
    branchId,
    headSequence: 0,
    version: 0,
    storySecond: originStorySecond,
    meters: [],
    conditions: [],
    modifiers: [],
  });
}
