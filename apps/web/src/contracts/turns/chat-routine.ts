import { resolveGameTime, type CalendarStart } from "@/lib/clock";
import type { ScheduleEntry, ScheduleKind } from "../world/profile";

/**
 * A character's authored daily routine laid onto the chat's story calendar.
 * PURE. The chat clock counts minutes from the scenario's `calendarStart`
 * (UTC-backed, so every day is exactly 1 440 minutes and weekdays are real);
 * this module turns a schedule row's minute-of-day window and weekday mask into
 * concrete chat-minute intervals — the one place the story-time body model
 * (sleep pressure, routine self-care crossings) reads a routine from.
 *
 * A window belongs to the day it STARTS on: a 23:00→07:00 row masked to Friday
 * is Friday night, running into Saturday morning. A row whose start equals its
 * end covers nothing.
 */

const MINUTES_PER_DAY = 1_440;

/** One concrete stretch of a schedule row, in chat minutes; `endMinutes` > `startMinutes`. */
export interface ScheduleOccurrence {
  entry: ScheduleEntry;
  startMinutes: number;
  endMinutes: number;
}

/** Minute of day the chat's minute 0 falls on. */
export function anchorMinuteOfDay(calendarStart: CalendarStart): number {
  return calendarStart.hour * 60 + calendarStart.minute;
}

/** Calendar day of a chat minute, counted from the anchor's own day (0). */
function dayIndexAt(clockMinutes: number, calendarStart: CalendarStart): number {
  return Math.floor((anchorMinuteOfDay(calendarStart) + clockMinutes) / MINUTES_PER_DAY);
}

/**
 * Every occurrence of the rows of `kind` that overlaps `[fromMinutes, toMinutes]`,
 * earliest first. Rows without that kind — including every row with no kind —
 * contribute nothing.
 */
export function scheduleOccurrences(
  schedule: readonly ScheduleEntry[],
  kind: ScheduleKind,
  fromMinutes: number,
  toMinutes: number,
  calendarStart: CalendarStart,
): ScheduleOccurrence[] {
  const rows = schedule.filter((entry) => entry.kind === kind && entry.startMinute !== entry.endMinute);
  if (rows.length === 0 || toMinutes < fromMinutes) return [];
  const anchor = anchorMinuteOfDay(calendarStart);
  const anchorWeekday = resolveGameTime(0, calendarStart).weekdayIndex;
  const occurrences: ScheduleOccurrence[] = [];
  // The day before `from` too: a window that wraps midnight can start there.
  for (let day = dayIndexAt(fromMinutes, calendarStart) - 1; day <= dayIndexAt(toMinutes, calendarStart); day += 1) {
    const weekday = (((anchorWeekday + day) % 7) + 7) % 7;
    const dayStart = day * MINUTES_PER_DAY - anchor;
    for (const entry of rows) {
      if (entry.days !== undefined && !entry.days.includes(weekday)) continue;
      const startMinutes = dayStart + entry.startMinute;
      const endMinutes = dayStart + entry.endMinute + (entry.endMinute < entry.startMinute ? MINUTES_PER_DAY : 0);
      if (endMinutes > fromMinutes && startMinutes < toMinutes) occurrences.push({ entry, startMinutes, endMinutes });
    }
  }
  return occurrences.sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);
}

/**
 * The most recent occurrence of a row of `kind` that began at or before
 * `atMinutes`, looking back one week (the longest a weekday mask can skip);
 * null when the routine has none.
 */
export function latestScheduleOccurrence(
  schedule: readonly ScheduleEntry[],
  kind: ScheduleKind,
  atMinutes: number,
  calendarStart: CalendarStart,
): ScheduleOccurrence | null {
  let latest: ScheduleOccurrence | null = null;
  // `+ 1` so a window starting exactly at `atMinutes` is a candidate (the overlap test is strict).
  for (const occurrence of scheduleOccurrences(schedule, kind, atMinutes - 8 * MINUTES_PER_DAY, atMinutes + 1, calendarStart)) {
    if (occurrence.startMinutes <= atMinutes && (latest === null || occurrence.startMinutes >= latest.startMinutes)) {
      latest = occurrence;
    }
  }
  return latest;
}
