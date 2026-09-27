import { deriveCircadianPressure, deriveEnergyRead, type EnergyRead } from "@vesper/simulation-core/body-reads";
import { METER_FIXED_POINT_ONE, type BodyRhythmRow } from "@vesper/simulation-core/contracts/bodies";
import { worldCharacterIdSchema } from "@vesper/simulation-core/contracts/identity";
import type { CalendarStart } from "@/lib/clock";
import type { ActiveCondition } from "../conditions/condition";
import { anchorMinuteOfDay, latestScheduleOccurrence } from "../turns/chat-routine";
import type { ScheduleEntry } from "../world/profile";
import {
  MOOD_BRIGHT_MIN,
  MOOD_LOW_MAX,
  meterDefinitions,
  meterStateCue,
  type MeterDefinition,
} from "./registry";

/**
 * The ONE derived-read path for chat meters. Stored meters are where drift and
 * sources act; every consumer of their band vocabulary — the narrator's state
 * cues and mood phrase, the anti-repetition bands, the status strip's chips,
 * the emotion chip, image visible effects — reads the values `readChatMeters`
 * returns instead, so a meter whose read is derived (energy's circadian
 * balance) means the same thing on every surface and no surface special-cases
 * it. PURE and client-importable.
 *
 * The energy read is simulation-core's own (`deriveCircadianPressure`,
 * `deriveEnergyRead`): this module only converts chat units — story minutes
 * anchored at `calendarStart`, 0–1 meters — to its story seconds (second 0 =
 * midnight of the anchor's day) and fixed-point values. Pressure is always
 * derived here and never stored.
 */

/** Everything a derived read needs beyond the stored meters. */
export interface ChatMeterReadContext {
  /** The story minute the read is taken at. */
  clockMinutes: number;
  calendarStart: CalendarStart;
  /** The character's authored schedule; only `kind: "sleep"` rows shape sleep pressure. */
  schedule: readonly ScheduleEntry[];
  /**
   * The story minute the character last actually came out of sleep; null ⇒ no
   * sleep is on record, and the pressure curve assumes the routine was kept.
   */
  lastSleepEndedAtMinutes: number | null;
  /** The character's standing conditions, for reads that depend on them. */
  conditions: readonly ActiveCondition[];
}

/** The rhythm rows handed to simulation-core are keyed to an actor it never looks up. */
const CHAT_RHYTHM_ACTOR = worldCharacterIdSchema.parse("chat-character");

/** A chat minute on simulation-core's story clock (seconds; second 0 = midnight of the anchor's day). */
export function chatStorySecond(clockMinutes: number, calendarStart: CalendarStart): number {
  return (anchorMinuteOfDay(calendarStart) + clockMinutes) * 60;
}

/**
 * The sleep rhythm governing a moment: the typed sleep row whose latest
 * occurrence began at or before it, weekday mask honored. Empty when the
 * schedule has none, which simulation-core reads as its 23:00–07:00 default.
 */
export function chatSleepRhythmAt(
  schedule: readonly ScheduleEntry[],
  clockMinutes: number,
  calendarStart: CalendarStart,
): BodyRhythmRow[] {
  const occurrence = latestScheduleOccurrence(schedule, "sleep", clockMinutes, calendarStart);
  if (occurrence === null) return [];
  return [
    {
      actorId: CHAT_RHYTHM_ACTOR,
      kind: "sleep",
      startMinuteOfDay: occurrence.entry.startMinute,
      endMinuteOfDay: occurrence.entry.endMinute,
    },
  ];
}

export interface ChatEnergyRead {
  /** The stored reserve, fixed-point. */
  reserveFixedPoint: number;
  /** Derived circadian sleep pressure at the read's clock, fixed-point. */
  pressureFixedPoint: number;
  /** Simulation-core's signed read, `clamp(−1, 1, reserve − pressure)` in fixed point, and its band. */
  read: EnergyRead;
}

/** The energy read for a 0–1 reserve at the context's clock. */
export function deriveChatEnergyRead(reserve: number, context: ChatMeterReadContext): ChatEnergyRead {
  const reserveFixedPoint = Math.round(Math.min(1, Math.max(0, reserve)) * METER_FIXED_POINT_ONE);
  const pressureFixedPoint = deriveCircadianPressure({
    atStorySecond: chatStorySecond(context.clockMinutes, context.calendarStart),
    rhythmRows: chatSleepRhythmAt(context.schedule, context.clockMinutes, context.calendarStart),
    ...(context.lastSleepEndedAtMinutes === null
      ? {}
      : { lastSleepEndedAtStorySecond: chatStorySecond(context.lastSleepEndedAtMinutes, context.calendarStart) }),
  });
  return { reserveFixedPoint, pressureFixedPoint, read: deriveEnergyRead({ reserveFixedPoint, pressureFixedPoint }) };
}

/** A signed energy read carried onto the 0–1 band scale: (read + 1) / 2. */
export function circadianBalanceReadValue(read: EnergyRead): number {
  return (read.signedFixedPoint / METER_FIXED_POINT_ONE + 1) / 2;
}

/**
 * Stored meters → the values their band vocabulary reads. A meter reads as
 * stored unless its definition declares a derived read. `context` null reads
 * every meter as stored — for meters another engine already reads (a
 * world-routed chat's successor meters).
 */
export function readChatMeters(
  meters: Readonly<Record<string, number>>,
  context: ChatMeterReadContext | null,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): Record<string, number> {
  const reads = { ...meters };
  if (context === null) return reads;
  for (const def of definitions) {
    const stored = meters[def.id];
    if (stored === undefined || def.read?.kind !== "circadian_balance") continue;
    reads[def.id] = circadianBalanceReadValue(deriveChatEnergyRead(stored, context).read);
  }
  return reads;
}

export interface MeterReadPip {
  meterId: string;
  label: string;
}

/**
 * The status strip's chips from READ values: each meter's deepest crossed
 * band that names a chip, then mood's valence (mood has no thresholds — its
 * prose is the derived descriptor — so its two chips are the shared band cuts).
 */
export function meterReadPips(
  reads: Readonly<Record<string, number>>,
  definitions: readonly MeterDefinition[] = meterDefinitions,
): MeterReadPip[] {
  const pips: MeterReadPip[] = [];
  for (const def of definitions) {
    const value = reads[def.id];
    if (value === undefined) continue;
    const cue = meterStateCue(def.id, value, definitions);
    if (cue?.pipLabel) pips.push({ meterId: def.id, label: cue.pipLabel });
  }
  const mood = reads.mood;
  if (mood !== undefined && mood >= MOOD_BRIGHT_MIN) pips.push({ meterId: "mood", label: "bright" });
  else if (mood !== undefined && mood <= MOOD_LOW_MAX) pips.push({ meterId: "mood", label: "low" });
  return pips;
}
