import { daylightBandAtMinute, to12Hour, type DaylightBand } from "@/lib/clock";

/**
 * R3 slice 4 (engine.rollout.plan.md, ruling 17) — the sim story clock made
 * legible. `storySecond` truthfully encodes a day index and a time of day and
 * nothing more; this seam renders exactly that ("Day 3 · 10:04am (morning)")
 * for the narrator prompt, the chat clock chip, and skip-landing previews.
 * Weekday/month naming waits for the R5 calendar anchor — presentation never
 * invents a calendar the world does not have.
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
