import { EXP2_SCALE, clampFixedPoint, exp2NegativeFixedPoint, linearDriftStep, proportionalDecayStep, } from "@vesper/contracts";
import { ENERGY_SLEEP_RESTORE_CAP_FIXED_POINT, ENERGY_SLEEP_RESTORE_PER_HOUR_FIXED_POINT, METER_FIXED_POINT_ONE, SECONDS_PER_DAY, bodyMeterRegistryByVersion, bodyModifierSpecSchema, bodyRegistryVersionSchema, rhythmSelfCareEffects, type BodyMeterDefinition, type BodyMeterState, type BodyModifier, type BodyModifierSpec, type BodyRhythmRow, type BodyThresholdDefinition, type ScheduledBodyAdjustment } from "../../contracts/bodies";

/**
 * E5.1 pure body kernel. The substrate law: a meter
 * moves only through analytic drift and material sources; QUERIES NEVER
 * PERSIST. Every derived value is computed from the last material write in
 * one closed-form step, so a large skip and equivalent partitions produce the
 * same material outcomes by construction — there is no intermediate rounding
 * to diverge. Threshold times are solved against this same integration
 * function (binary search within a monotone piece), so a scheduled alarm and
 * the value it evaluates can never disagree.
 */
export function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The deterministic 2^(-x) primitive and its scale now live in the shared
 * `lib/fixed-point.ts` kernel (both lanes run one implementation — see that
 * file's header). Re-exported here unchanged so `social.ts`, this module's
 * tests and any other body-kernel consumer keep importing them from `./bodies`.
 */
export { EXP2_SCALE,exp2NegativeFixedPoint };

// ---------------------------------------------------------------------------
// Piecewise analytic integration
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

/**
 * Modifiers live in [validFrom, validUntil): stacked per group, then composed.
 * Exported: purely structural (validity/stacking/priority/id), no actorId
 * touched — E5.3 slice 3's item-condition kernel reuses it as-is.
 */
export function modifiersLiveAt(modifiers: readonly BodyModifier[], second: number): BodyModifier[] {
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

export function clampMeter(value: number): number {
  return clampFixedPoint(value, METER_FIXED_POINT_ONE);
}

/**
 * One closed-form drift step under a constant modifier set. The numerics are the
 * shared `lib/fixed-point.ts` kernel's; this function only decides WHICH law the
 * effective drift selects.
 */
function driftStep(valueFixedPoint: number, drift: EffectiveDrift, elapsedSeconds: number): number {
  if (elapsedSeconds <= 0 || drift.kind === "none") return valueFixedPoint;
  if (drift.kind === "linear") {
    return linearDriftStep({
      value: valueFixedPoint,
      target: drift.targetFixedPoint,
      ratePerHourFixedPoint: drift.ratePerHourFixedPoint,
      elapsedSeconds,
      one: METER_FIXED_POINT_ONE,
    });
  }
  return proportionalDecayStep({
    value: valueFixedPoint,
    target: drift.targetFixedPoint,
    halfLife: drift.halfLifeSeconds,
    elapsed: elapsedSeconds,
  });
}

export interface MeterIntegrationView {
  definition: BodyMeterDefinition;
  state: BodyMeterState;
  /** Every modifier row for this actor + meter, any validity. */
  modifiers: readonly BodyModifier[];
  /**
   * E5.2 rhythm self-care as data: absolute-second set/add jumps the
   * integration folds as boundaries (window crossing — deterministic
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
 * self-care boundaries from the last material write. Never persists (that is
 * what makes partition invariance structural).
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

/** Subject-agnostic (definition + a number only) — reused as-is by item condition. */
export function thresholdCrossed(threshold: BodyThresholdDefinition, valueFixedPoint: number): boolean {
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
// E5.2 — rhythm self-care and the sleep coupling
// ---------------------------------------------------------------------------
/**
 * Window-crossing self-care: each rhythm row whose kind carries a self-care
 * effect lands that effect at its window-END minute, every story day. A skip
 * credits only the crossings it actually contains — landing at 6am (before a
 * 7am wash) and landing at 8am (past it) genuinely differ, and nothing ever
 * blanket-restores. Crossings are deterministic clock points, so they enter
 * integration as {@link ScheduledBodyAdjustment}s — no per-day tick, no
 * trigger, no persistence.
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
 * The per-meter {@link MeterIntegrationView} over one actor's already-loaded
 * body rows: resolve the meter's registry definition from the row's captured
 * `registryVersion` (validated through {@link bodyRegistryVersionSchema}),
 * attach that meter's modifiers, and fold the rhythm self-care crossings
 * through `horizon` as scheduled adjustments. `undefined` when the actor holds
 * no such meter row, or its registry version / definition cannot be resolved.
 *
 * Pure and total — the ONE builder the material and activity command stores AND
 * the read seams (`readSimChatMeters`) all route through, so a command-time
 * view and a read-time view can never diverge. Callers set `horizon` to their
 * need: the command path solves alarms across the full threshold horizon; a
 * read integrating only to "now" passes the branch clock itself.
 */
export function buildMeterView(
  rows: {
    meters: readonly BodyMeterState[];
    modifiers: readonly BodyModifier[];
    rhythms: readonly BodyRhythmRow[];
  },
  meterKey: string,
  horizon: number,
): MeterIntegrationView | undefined {
  const state = rows.meters.find((meter) => meter.meterKey === meterKey);
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
    modifiers: rows.modifiers.filter((modifier) => modifier.meterKey === meterKey),
    scheduledAdjustments: selfCareAdjustmentsBetween(
      rows.rhythms,
      meterKey,
      state.lastIntegratedAtStorySecond,
      horizon,
    ),
  };
}

/**
 * The sleep coupling, half one: falling asleep suspends the energy
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
 * The sleep coupling, half two: waking credits the reserve linearly by
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
