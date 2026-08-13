import {
  DEFAULT_SLEEP_WINDOW,
  METER_FIXED_POINT_ONE,
  SECONDS_PER_DAY,
  circadianCurveV1,
  type BodyRhythmRow,
  type EnergyReadBand,
  type IntimacyPhase,
  type VisibleBodySign,
} from "../contracts/bodies";

/**
 * E5.2 — the §25.1 layer-3 READ surface for energy (ruling 15; the normative
 * semantics are chat-meter-economy.spec OQ1). Reads are pure, total,
 * contextual projections: the stored reserve never goes signed and never
 * learns vocabulary; the bidirectional axis, the bands, and the circadian
 * pressure all live here and persist nothing.
 */

const MINUTES_PER_DAY = 1_440;

export interface SleepWindow {
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

/** The actor's sleep rhythm row, or the default 23:00→07:00 window (degraded default). */
export function resolveSleepWindow(rhythmRows: readonly BodyRhythmRow[]): SleepWindow {
  const sleepRows = rhythmRows
    .filter((row) => row.kind === "sleep")
    .sort((left, right) => left.startMinuteOfDay - right.startMinuteOfDay);
  const [first] = sleepRows;
  if (!first) return { ...DEFAULT_SLEEP_WINDOW };
  return { startMinuteOfDay: first.startMinuteOfDay, endMinuteOfDay: first.endMinuteOfDay };
}

/** Window length in minutes, wrapping midnight (23:00→07:00 is 480). */
function windowLengthMinutes(window: SleepWindow): number {
  return ((window.endMinuteOfDay - window.startMinuteOfDay) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Minutes since the most recent scheduled wake (window end) at this second. */
function minutesSinceScheduledWake(atStorySecond: number, window: SleepWindow): number {
  const minuteOfDay = Math.floor(atStorySecond / 60) % MINUTES_PER_DAY;
  return ((minuteOfDay - window.endMinuteOfDay) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * The periodic circadian component, piecewise-linear through the
 * {@link circadianCurveV1} anchors expressed relative to the actor's own
 * wake (W) and bedtime (B). Falls back to the default window's geometry when
 * the authored window makes the anchors collide (a rhythm too strange for
 * the v1 curve degrades rather than failing the read — resilience rule).
 */
export function circadianComponentFixedPoint(atStorySecond: number, window: SleepWindow): number {
  const curve = circadianCurveV1;
  const sleepMinutes = windowLengthMinutes(window);
  const wakingSpanMinutes = MINUTES_PER_DAY - sleepMinutes;
  // Anchor offsets measured in minutes since wake. The night anchors derive
  // from the bedtime side: bed = wakingSpan, trough = wakingSpan + trough
  // offset (mid-sleep), wrapping to the next wake.
  const anchors: [number, number][] = [
    [0, curve.wakeInertiaFixedPoint],
    [curve.dayFloorOffsetMinutes, curve.dayFloorFixedPoint],
    [curve.afternoonDipOffsetMinutes, curve.afternoonDipFixedPoint],
    [curve.eveningLowOffsetMinutes, curve.eveningLowFixedPoint],
    [wakingSpanMinutes - curve.rampLeadMinutes, curve.rampFixedPoint],
    [wakingSpanMinutes, curve.bedtimeFixedPoint],
    [wakingSpanMinutes + curve.troughOffsetMinutes, curve.troughPeakFixedPoint],
    [MINUTES_PER_DAY, curve.wakeInertiaFixedPoint],
  ];
  const ordered = anchors.every(
    ([minute], index) => index === 0 || minute > (anchors[index - 1]?.[0] ?? 0),
  );
  if (!ordered) {
    return circadianComponentFixedPoint(atStorySecond, { ...DEFAULT_SLEEP_WINDOW });
  }
  const sinceWake = minutesSinceScheduledWake(atStorySecond, window);
  for (let index = 1; index < anchors.length; index += 1) {
    const [previousMinute, previousValue] = anchors[index - 1] ?? [0, 0];
    const [minute, value] = anchors[index] ?? [MINUTES_PER_DAY, 0];
    if (sinceWake <= minute) {
      const span = minute - previousMinute;
      if (span <= 0) return value;
      return previousValue + Math.floor(((value - previousValue) * (sinceWake - previousMinute)) / span);
    }
  }
  return curve.wakeInertiaFixedPoint;
}

export interface CircadianPressureInput {
  atStorySecond: number;
  /** The actor's sleep rhythm rows (any kinds tolerated; sleep rows used). */
  rhythmRows: readonly BodyRhythmRow[];
  /**
   * When the actor last finished sleeping (asleep-condition end or sleep
   * credit). Absent means assume the rhythm was followed — the most recent
   * scheduled wake counts, so escalation stays zero through a normal day.
   */
  lastSleepEndedAtStorySecond?: number;
}

/**
 * Circadian sleep pressure in meter fixed-point units. The periodic
 * component repeats daily; the escalation term grows once the actor has been
 * awake longer than their normal waking span, which is what pushes the read
 * to its saturated floor at ~40h with no hardcoded hour (OQ1).
 */
export function deriveCircadianPressure(input: CircadianPressureInput): number {
  const window = resolveSleepWindow(input.rhythmRows);
  const periodic = circadianComponentFixedPoint(input.atStorySecond, window);
  const wakingSpanSeconds = (MINUTES_PER_DAY - windowLengthMinutes(window)) * 60;
  const lastWake =
    input.lastSleepEndedAtStorySecond ??
    input.atStorySecond - minutesSinceScheduledWake(input.atStorySecond, window) * 60;
  const awakeSeconds = Math.max(0, input.atStorySecond - lastWake);
  const pastNormalSeconds = Math.max(0, awakeSeconds - wakingSpanSeconds);
  const escalation = Math.floor(
    (circadianCurveV1.escalationPerHourFixedPoint * pastNormalSeconds) / 3_600,
  );
  return periodic + escalation;
}

/**
 * The generalized deficit read (chat-meter-economy.spec §"deficit reads"):
 * signed, zero at the actor's own act-point, negative meaning overdue, both
 * poles saturating. Energy is its first customer; satiation and the other
 * reserves reuse it when they port.
 */
export function deriveDeficitRead(reserveFixedPoint: number, pressureFixedPoint: number): number {
  return Math.max(
    -METER_FIXED_POINT_ONE,
    Math.min(METER_FIXED_POINT_ONE, reserveFixedPoint - pressureFixedPoint),
  );
}

export interface EnergyRead {
  signedFixedPoint: number;
  band: EnergyReadBand;
}

export function deriveEnergyRead(input: {
  reserveFixedPoint: number;
  pressureFixedPoint: number;
}): EnergyRead {
  const signedFixedPoint = deriveDeficitRead(input.reserveFixedPoint, input.pressureFixedPoint);
  const band: EnergyReadBand =
    signedFixedPoint >= 6_000
      ? "bright"
      : signedFixedPoint >= 2_500
        ? "steady"
        : signedFixedPoint >= 0
          ? "winding_down"
          : signedFixedPoint >= -4_000
            ? "dragging"
            : signedFixedPoint >= -8_000
              ? "wrecked"
              : "collapsing";
  return { signedFixedPoint, band };
}

/** Seconds-of-day helper shared by tests and stores: minute m on story day d. */
export function storySecondAt(day: number, minuteOfDay: number): number {
  return day * SECONDS_PER_DAY + minuteOfDay * 60;
}

// ---------------------------------------------------------------------------
// E5.2 slice 2 — the intimacy pulse and perception-gated signs (OQ2)
// ---------------------------------------------------------------------------

/**
 * The intimacy pulse: arousal graded to the physiological vocabulary, with
 * an active afterglow condition overriding the whole scale — the settled
 * body after climax is its own phase, not "low arousal".
 */
export function deriveIntimacyRead(input: {
  arousalFixedPoint: number;
  afterglowActive: boolean;
}): IntimacyPhase {
  if (input.afterglowActive) return "afterglow";
  if (input.arousalFixedPoint >= 8_500) return "cresting";
  if (input.arousalFixedPoint >= 6_500) return "wound_tight";
  if (input.arousalFixedPoint >= 4_500) return "flushed";
  if (input.arousalFixedPoint >= 2_000) return "kindled";
  return "quiescent";
}

/**
 * What a WITNESS could perceive at conversational range (OQ2's answer to
 * "represented in narration"): facts, never mood instructions, gated on the
 * E4.1 detail tier — a glimpse (tier ≤ 1) reads nothing, plain sight
 * (tier 2) reads skin and posture, clear engaged attention (tier 3) also
 * reads breath and focus. Contact- and exposure-gated signs have no
 * vocabulary members yet by design (G5.2/G5.3 gate them when they exist).
 */
export function deriveVisibleBodySigns(input: {
  energyRead: EnergyRead;
  arousalFixedPoint: number;
  afterglowActive: boolean;
  detailTier: number;
}): VisibleBodySign[] {
  if (input.detailTier < 2) return [];
  const signs: VisibleBodySign[] = [];
  if (input.energyRead.band === "wrecked" || input.energyRead.band === "collapsing") {
    signs.push("visible_exhaustion");
  } else if (input.energyRead.band === "dragging") {
    signs.push("visible_fatigue");
  }
  if (input.afterglowActive) {
    signs.push("afterglow_softness");
  } else {
    if (input.arousalFixedPoint >= 4_500) signs.push("flushed_skin");
    if (input.detailTier >= 3) {
      if (input.arousalFixedPoint >= 6_500) signs.push("quickened_breath");
      if (input.arousalFixedPoint >= 8_500) signs.push("taut_attention");
    }
  }
  return signs;
}
