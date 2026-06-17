import { z } from "zod";

export const calendarStartSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23).default(8),
  minute: z.number().int().min(0).max(59).default(0),
});

export type CalendarStart = z.infer<typeof calendarStartSchema>;

export const DEFAULT_CALENDAR_START: CalendarStart = { year: 2024, month: 6, day: 1, hour: 8, minute: 0 };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export interface GameTime {
  year: number;
  month: number;
  day: number;
  weekday: string;
  /** 0 = Sunday … 6 = Saturday — for schedule day masks. */
  weekdayIndex: number;
  /** Whole days since the calendar start — for per-day deterministic seeds. */
  dayIndex: number;
  hour: number;
  minute: number;
  /** Minutes since session start. */
  clockMinutes: number;
}

/** Resolve a session clock (minutes since start) against the world's calendar start. */
export function resolveGameTime(clockMinutes: number, start: CalendarStart): GameTime {
  const base = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute);
  const at = new Date(base + clockMinutes * 60_000);
  const startMidnight = Date.UTC(start.year, start.month - 1, start.day);
  const atMidnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    weekday: WEEKDAYS[at.getUTCDay()] ?? "Sunday",
    weekdayIndex: at.getUTCDay(),
    dayIndex: Math.round((atMidnight - startMidnight) / 86_400_000),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
    clockMinutes,
  };
}

export type DaylightBand = "dawn" | "day" | "dusk" | "night";

/**
 * Minute-of-day each daylight band begins (dawn 05:00, day 07:00, dusk 18:00,
 * night 20:00). Wake-time anchors read this — "until morning" means the next
 * dawn band start — so band boundaries live in exactly one place.
 */
export const DAYLIGHT_BAND_START_MINUTES: Record<DaylightBand, number> = {
  dawn: 5 * 60,
  day: 7 * 60,
  dusk: 18 * 60,
  night: 20 * 60,
};

/**
 * Daylight band (multi-character-v1-defaults.phase3.md): dawn 05–07, day 07–18,
 * dusk 18–20, night otherwise. Style-overridable later; consumers (perception
 * darkness, drive curfews, declared-rest wake times) read this instead of
 * re-deriving hours.
 */
export function daylightBand(time: GameTime): DaylightBand {
  const minute = minuteOfDay(time);
  if (minute >= DAYLIGHT_BAND_START_MINUTES.dawn && minute < DAYLIGHT_BAND_START_MINUTES.day) return "dawn";
  if (minute >= DAYLIGHT_BAND_START_MINUTES.day && minute < DAYLIGHT_BAND_START_MINUTES.dusk) return "day";
  if (minute >= DAYLIGHT_BAND_START_MINUTES.dusk && minute < DAYLIGHT_BAND_START_MINUTES.night) return "dusk";
  return "night";
}

export type Meridiem = "am" | "pm";

/** Split a 24-hour hour (0–23) into a 12-hour clock face + meridiem. */
export function to12Hour(hour24: number): { hour12: number; meridiem: Meridiem } {
  return { hour12: hour24 % 12 === 0 ? 12 : hour24 % 12, meridiem: hour24 < 12 ? "am" : "pm" };
}

/** Combine a 12-hour clock face (1–12) + meridiem into a 24-hour hour (0–23). */
export function from12Hour(hour12: number, meridiem: Meridiem): number {
  const base = hour12 % 12; // 12 → 0
  return meridiem === "pm" ? base + 12 : base;
}

export function formatGameClock(time: GameTime): string {
  const { hour12, meridiem } = to12Hour(time.hour);
  const month = MONTHS[time.month - 1] ?? "January";
  return `${time.weekday}, ${month} ${time.day}, ${time.year} — ${hour12}:${String(time.minute).padStart(2, "0")}${meridiem}`;
}

/** Minute of day (0–1439), for schedule windows. */
export function minuteOfDay(time: GameTime): number {
  return time.hour * 60 + time.minute;
}

export function formatElapsed(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}${hours % 24 ? ` ${hours % 24}h` : ""}`;
  return rest ? `${hours}h ${rest}m` : `${hours} hour${hours === 1 ? "" : "s"}`;
}
