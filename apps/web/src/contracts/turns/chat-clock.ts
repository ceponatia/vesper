import {
  MONTHS,
  minuteOfDay,
  resolveGameTime,
  to12Hour,
  type CalendarStart,
  type GameTime,
} from "@/lib/clock";
import { SCHEDULE_DAY_PARTS, type ScheduleDayPartId } from "../world/profile";

/**
 * The chat lane's story calendar. The chat clock
 * (`character_chats.clock_minutes`, minute 0 = the conversation's first beat) is
 * anchored to a real simulated calendar via the scenario's `calendarStart`:
 * `resolveGameTime` is `Date.UTC`-backed, so month lengths, leap years, and
 * weekday↔date alignment are all real Gregorian behavior for free. Everything
 * here is PURE; nothing reads the wall clock (D3/D8 — the calendar maps STORY
 * minutes to dates).
 */

/**
 * The default anchor when the author hasn't set one (owner ruling 2026-07-15):
 * stories begin January 1 at 8:00am. The chat lane keeps its own constant so the
 * session lane's June-1 `DEFAULT_CALENDAR_START` is untouched. The year is
 * required by the Date math (it pins the Jan-1 weekday — Monday for 2024 — and
 * leap-year Februaries); the display simply omits it.
 */
export const CHAT_DEFAULT_CALENDAR_START: CalendarStart = { year: 2024, month: 1, day: 1, hour: 8, minute: 0 };

/** Resolve a chat clock reading against the scenario anchor. Thin, but names the lane. */
export function chatGameTime(clockMinutes: number, start: CalendarStart): GameTime {
  return resolveGameTime(clockMinutes, start);
}

/**
 * The canonical block-of-time shorthand (owner ruling 2026-07-15): the
 * `SCHEDULE_DAY_PARTS` block at this clock reading — the ONE day-part
 * vocabulary shared by schedules, plans, and prompts. Replaces the retired
 * free-text `scene_memory.timeOfDay`.
 */
export function timeOfDayFor(clockMinutes: number, start: CalendarStart): ScheduleDayPartId {
  return dayPartAtMinute(minuteOfDay(resolveGameTime(clockMinutes, start)));
}

/** The day-part block covering a minute-of-day (0–1439). Night wraps past midnight. */
export function dayPartAtMinute(minute: number): ScheduleDayPartId {
  const bounded = ((Math.round(minute) % 1440) + 1440) % 1440;
  for (const part of SCHEDULE_DAY_PARTS) {
    if (part.startMinute <= part.endMinute) {
      if (bounded >= part.startMinute && bounded < part.endMinute) return part.id;
    } else if (bounded >= part.startMinute || bounded < part.endMinute) {
      return part.id;
    }
  }
  return "night";
}

/**
 * The clock minute at the current story day's midnight (negative on day 0 when
 * the anchor starts mid-day). The day-boundary origin for day-offset math —
 * `floor(clockMinutes / 1440)` is WRONG once minute 0 is 8:00am.
 */
export function dayStartClockMinutes(clockMinutes: number, start: CalendarStart): number {
  return clockMinutes - minuteOfDay(resolveGameTime(clockMinutes, start));
}

/** "Friday, January 5" — the story date, year omitted (it exists; it just isn't story-facing). */
export function formatChatDate(time: GameTime): string {
  return `${time.weekday}, ${MONTHS[time.month - 1] ?? "January"} ${time.day}`;
}

/** "2:10pm" */
export function formatChatTime(time: GameTime): string {
  const { hour12, meridiem } = to12Hour(time.hour);
  return `${hour12}:${String(time.minute).padStart(2, "0")}${meridiem}`;
}

/** "Friday evening" — the compact skip-landing / meanwhile shorthand. */
export function formatChatMoment(clockMinutes: number, start: CalendarStart): string {
  const time = resolveGameTime(clockMinutes, start);
  return `${time.weekday} ${dayPartAtMinute(minuteOfDay(time))}`;
}

/**
 * "Friday, January 5 — 2:10pm (afternoon)" — the full story moment for the
 * narrator's binding Story-time line and the clock card. Weekday + date + clock
 * time + the canonical day-part block.
 */
export function formatStoryMoment(clockMinutes: number, start: CalendarStart): string {
  const time = resolveGameTime(clockMinutes, start);
  return `${formatChatDate(time)} — ${formatChatTime(time)} (${dayPartAtMinute(minuteOfDay(time))})`;
}

/** "the 12th" — ordinal day-of-month for far-out plan labels. */
export function ordinalDay(day: number): string {
  const mod100 = day % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : day % 10 === 1 ? "st" : day % 10 === 2 ? "nd" : day % 10 === 3 ? "rd" : "th";
  return `the ${day}${suffix}`;
}

/**
 * A calendar-aware "when" phrase for a scheduled story-clock target (owner
 * ruling 2026-07-15 — real weekdays): today/tomorrow keep their natural words,
 * a bare weekday carries days 2–6 out (unambiguous inside a week), and 7+ days
 * out the date disambiguates ("Friday the 12th, evening"). Past targets keep
 * the weekday ("Friday evening" — the justMissed fallout reads naturally).
 * Derived at render time from `targetMinutes` + the anchor, never stored, so
 * editing `calendarStart` rebases every label for free.
 */
export function chatMomentLabel(targetMinutes: number, nowMinutes: number, start: CalendarStart): string {
  const target = resolveGameTime(targetMinutes, start);
  const now = resolveGameTime(nowMinutes, start);
  const part = dayPartAtMinute(minuteOfDay(target));
  const dayDelta = target.dayIndex - now.dayIndex;
  if (dayDelta === 0) {
    switch (part) {
      case "morning":
        return "this morning";
      case "afternoon":
        return "this afternoon";
      case "evening":
        return "this evening";
      case "night":
        return "tonight";
    }
  }
  if (dayDelta === 1) return `tomorrow ${part}`;
  if (dayDelta >= 7) return `${target.weekday} ${ordinalDay(target.day)}, ${part}`;
  return `${target.weekday} ${part}`;
}
