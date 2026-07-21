"use client";

import { MONTHS, WEEKDAYS, type CalendarStart } from "@/lib/clock";
import { cx } from "./cx";

/**
 * The calendar-grid picker's value shape (mobile-ux.plan.md ruling 2): the date
 * half of `CalendarStart` — `month` is 1-based, matching `src/lib/clock.ts`.
 * Hour/minute stay with the caller (the anchor editor's separate hour/am-pm
 * selects) since a date grid has no business modeling time-of-day.
 */
export type DatePickerValue = Pick<CalendarStart, "year" | "month" | "day">;

const WEEKDAY_LABELS = WEEKDAYS.map((name) => name.slice(0, 3));

/** Days in a Gregorian month (1-based `month`) — the Date.UTC day-0 trick. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday (0 = Sunday) of the 1st of a 1-based month. */
function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

/** Clamp a day-of-month into the month's real range (Feb 31 → Feb 28/29). */
function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/**
 * Page a value by whole months (paging UI) or whole years (the year stepper —
 * 12 months at once), rolling the year over naturally and clamping the day so
 * paging off a 31st into a shorter month never overflows.
 */
export function addMonths(value: DatePickerValue, delta: number): DatePickerValue {
  const total = value.month - 1 + delta;
  const year = value.year + Math.floor(total / 12);
  const month = (((total % 12) + 12) % 12) + 1;
  return { year, month, day: clampDay(year, month, value.day) };
}

interface GridCell {
  year: number;
  month: number;
  day: number;
  inMonth: boolean;
}

/** The 6×7 grid (real Gregorian layout, Sunday-start) covering `month`'s visible weeks. */
function buildGrid(year: number, month: number): GridCell[] {
  const leading = firstWeekday(year, month);
  const start = Date.UTC(year, month - 1, 1 - leading);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() + 1 === month && d.getUTCFullYear() === year,
    };
  });
}

const navButtonClass =
  "touch-target inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-paper-400 transition-colors hover:bg-ink-800 hover:text-paper-100";

/**
 * Themed month-grid calendar (mobile-ux.plan.md ruling 2): weekday headers make
 * the weekday visible by construction, ‹ › pages a month at a time (rolling the
 * year over naturally), and a compact « » year stepper covers big jumps. Fully
 * controlled and pure — the displayed month IS `value`'s month, so there's no
 * separate view state to reconcile when a caller (e.g. a typed-date parse)
 * changes `value` out from under it.
 */
export function DatePicker({ value, onChange }: { value: DatePickerValue; onChange: (value: DatePickerValue) => void }) {
  const grid = buildGrid(value.year, value.month);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          <button type="button" aria-label="Previous year" className={navButtonClass} onClick={() => onChange(addMonths(value, -12))}>
            «
          </button>
          <button type="button" aria-label="Previous month" className={navButtonClass} onClick={() => onChange(addMonths(value, -1))}>
            ‹
          </button>
        </div>
        <span className="text-sm font-medium text-paper-100">
          {MONTHS[value.month - 1] ?? "January"} {value.year}
        </span>
        <div className="flex items-center gap-0.5">
          <button type="button" aria-label="Next month" className={navButtonClass} onClick={() => onChange(addMonths(value, 1))}>
            ›
          </button>
          <button type="button" aria-label="Next year" className={navButtonClass} onClick={() => onChange(addMonths(value, 12))}>
            »
          </button>
        </div>
      </div>
      {/* minmax(2.5rem, 1fr): columns fill the Dialog's width but never shrink below the
          40px tap-size floor — fluid instead of a fixed 7×44px total that would overflow
          the ~318px content width a 390px-viewport Dialog actually leaves (mobile-ux.plan.md
          ruling 2's "fits the Dialog at 390px" is the target we're sized against). */}
      <div className="grid grid-cols-[repeat(7,minmax(2.5rem,1fr))] gap-1">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="flex h-5 items-center justify-center text-[10px] font-medium tracking-wide text-paper-500 uppercase">
            {label}
          </span>
        ))}
        {grid.map((cell) => {
          const selected = cell.year === value.year && cell.month === value.month && cell.day === value.day;
          return (
            <button
              key={`${cell.year}-${cell.month}-${cell.day}`}
              type="button"
              aria-pressed={selected}
              aria-label={`${MONTHS[cell.month - 1] ?? "January"} ${cell.day}, ${cell.year}`}
              onClick={() => onChange({ year: cell.year, month: cell.month, day: cell.day })}
              className={cx(
                "flex h-11 w-full cursor-pointer items-center justify-center rounded-md text-sm transition-colors",
                selected
                  ? "bg-accent-500 font-medium text-ink-950"
                  : cell.inMonth
                    ? "text-paper-200 hover:bg-ink-800"
                    : "text-paper-600 hover:bg-ink-800/60",
              )}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}
