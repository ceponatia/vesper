import { z } from "zod";
import { formatStoryMoment } from "@/contracts/turns/chat-clock";
import { daylightBandAtMinute, to12Hour, type CalendarStart, type DaylightBand } from "@/lib/clock";

/**
 * The sim story clock made legible. `storySecond` truthfully encodes a day
 * index and a time of day and nothing more; this seam renders exactly that
 * ("Day 3 · 10:04am (morning)") for the narrator prompt, the chat clock chip,
 * and skip-landing previews. Weekday/month naming waits for the R5 calendar
 * anchor — presentation never invents a calendar the world does not have.
 */

const SECONDS_PER_DAY = 86_400;

/** Colloquial time-of-day word — the vocabulary the narration colors with. */
export type StoryDayPart = "morning" | "afternoon" | "evening" | "night";

export interface StoryClock {
  storySecond: number;
  /** Whole story days since second 0 (0-based; display as `Day ${dayIndex + 1}`). */
  dayIndex: number;
  minuteOfDay: number;
  hour: number;
  minute: number;
  /** Light band (dawn/day/dusk/night) — shared thresholds with the legacy clock. */
  band: DaylightBand;
  /** Colloquial part of day (morning/afternoon/evening/night) — for prose color. */
  dayPart: StoryDayPart;
}

/** Resolve a branch `storySecond` into the legible story clock. */
export function storyClockAt(storySecond: number): StoryClock {
  const secondOfDay = ((storySecond % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const minuteOfDay = Math.floor(secondOfDay / 60);
  const hour = Math.floor(minuteOfDay / 60);
  return {
    storySecond,
    dayIndex: Math.floor(storySecond / SECONDS_PER_DAY),
    minuteOfDay,
    hour,
    minute: minuteOfDay % 60,
    band: daylightBandAtMinute(minuteOfDay),
    dayPart: storyDayPart(hour),
  };
}

function storyDayPart(hour: number): StoryDayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/** "10:04am" — the clock face alone. */
export function formatStoryTime(clock: StoryClock): string {
  const { hour12, meridiem } = to12Hour(clock.hour);
  return `${hour12}:${String(clock.minute).padStart(2, "0")}${meridiem}`;
}

/** "Day 3 · 10:04am" — the chip label. */
export function formatStoryClockShort(clock: StoryClock): string {
  return `Day ${clock.dayIndex + 1} · ${formatStoryTime(clock)}`;
}

/** "Day 3 · 10:04am (morning)" — the narrator's world-clock line. */
export function formatStoryClock(clock: StoryClock): string {
  return `${formatStoryClockShort(clock)} (${clock.dayPart})`;
}

/**
 * R5 time domain — the per-world calendar anchor: the DATE of
 * story day zero. Time-of-day lives in `storySecond` itself, so the anchor is
 * date-only; null/absent means "no calendar declared" and presentation stays
 * "Day N".
 */
export const simCalendarStartSchema = z
  .object({
    year: z.number().int().min(1).max(9_999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  })
  .strict();
export type SimCalendarStart = z.infer<typeof simCalendarStartSchema>;

/**
 * Map a branch clock onto the legacy calendar math. `storySecond` 0 IS the
 * anchor date's midnight, so `{clockMinutes: s/60, start: anchor@00:00}` makes
 * every legacy formatter (`chatGameTime`, `formatChatDate/Time/Moment`,
 * `formatStoryMoment`) correct verbatim — one Gregorian truth, zero new date
 * math. This adapter is the WHOLE calendar integration seam.
 */
export function storyCalendarParams(
  storySecond: number,
  anchor: SimCalendarStart,
): { clockMinutes: number; calendarStart: CalendarStart } {
  return {
    clockMinutes: Math.floor(storySecond / 60),
    calendarStart: { ...anchor, hour: 0, minute: 0 },
  };
}

/**
 * The legible landing label for a branch `storySecond` — a real weekday/date +
 * time when the world declares a calendar anchor ("Friday, Jun 5 · 10:05am"),
 * else the anchorless story clock ("Day 3 · 10:05am (morning)"). The one seam
 * the skip toast AND the travel toast both name their landing through.
 */
export function formatSimLanding(storySecond: number, anchor: SimCalendarStart | null): string {
  if (anchor !== null) {
    const params = storyCalendarParams(storySecond, anchor);
    return formatStoryMoment(params.clockMinutes, params.calendarStart);
  }
  return formatStoryClock(storyClockAt(storySecond));
}
