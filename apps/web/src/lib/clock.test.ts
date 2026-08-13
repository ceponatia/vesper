import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_START,
  formatElapsed,
  formatGameClock,
  from12Hour,
  minuteOfDay,
  resolveGameTime,
  to12Hour,
  type CalendarStart,
} from "./clock";

describe("resolveGameTime", () => {
  it("returns the calendar start at clock zero", () => {
    const t = resolveGameTime(0, DEFAULT_CALENDAR_START);
    expect(t).toEqual({
      year: 2024,
      month: 6,
      day: 1,
      weekday: "Saturday", // 2024-06-01 really was a Saturday
      weekdayIndex: 6,
      dayIndex: 0,
      hour: 8,
      minute: 0,
      clockMinutes: 0,
    });
  });

  it("advances hours and minutes", () => {
    const t = resolveGameTime(95, DEFAULT_CALENDAR_START);
    expect(t.hour).toBe(9);
    expect(t.minute).toBe(35);
    expect(t.day).toBe(1);
    expect(t.clockMinutes).toBe(95);
  });

  it("rolls over midnight into the next day and weekday", () => {
    const lateStart: CalendarStart = { year: 2024, month: 6, day: 1, hour: 23, minute: 30 };
    const t = resolveGameTime(45, lateStart);
    expect(t.day).toBe(2);
    expect(t.weekday).toBe("Sunday");
    expect(t.hour).toBe(0);
    expect(t.minute).toBe(15);
  });

  it("rolls over month boundaries", () => {
    const t = resolveGameTime(24 * 60 * 30, DEFAULT_CALENDAR_START); // +30 days
    expect(t.month).toBe(7);
    expect(t.day).toBe(1);
  });
});

describe("minuteOfDay", () => {
  it("maps the wall clock to minutes since midnight", () => {
    expect(minuteOfDay(resolveGameTime(0, DEFAULT_CALENDAR_START))).toBe(480);
    expect(minuteOfDay(resolveGameTime(0, { year: 2024, month: 6, day: 1, hour: 0, minute: 0 }))).toBe(0);
    expect(minuteOfDay(resolveGameTime(0, { year: 2024, month: 6, day: 1, hour: 23, minute: 59 }))).toBe(1439);
  });
});

describe("formatGameClock", () => {
  it("formats a 12-hour clock with am/pm", () => {
    expect(formatGameClock(resolveGameTime(0, DEFAULT_CALENDAR_START))).toBe("Saturday, June 1, 2024 — 8:00am");
  });

  it("handles midnight and noon", () => {
    const midnight = resolveGameTime(0, { year: 2024, month: 6, day: 1, hour: 0, minute: 5 });
    const noon = resolveGameTime(0, { year: 2024, month: 6, day: 1, hour: 12, minute: 0 });
    expect(formatGameClock(midnight)).toContain("12:05am");
    expect(formatGameClock(noon)).toContain("12:00pm");
  });
});

describe("12-hour conversion", () => {
  it("splits 24-hour hours into a clock face + meridiem", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, meridiem: "am" });
    expect(to12Hour(8)).toEqual({ hour12: 8, meridiem: "am" });
    expect(to12Hour(12)).toEqual({ hour12: 12, meridiem: "pm" });
    expect(to12Hour(13)).toEqual({ hour12: 1, meridiem: "pm" });
    expect(to12Hour(23)).toEqual({ hour12: 11, meridiem: "pm" });
  });

  it("combines a clock face + meridiem back into 24-hour hours", () => {
    expect(from12Hour(12, "am")).toBe(0);
    expect(from12Hour(8, "am")).toBe(8);
    expect(from12Hour(12, "pm")).toBe(12);
    expect(from12Hour(1, "pm")).toBe(13);
    expect(from12Hour(11, "pm")).toBe(23);
  });

  it("round-trips every hour of the day", () => {
    for (let h = 0; h < 24; h++) {
      const { hour12, meridiem } = to12Hour(h);
      expect(from12Hour(hour12, meridiem)).toBe(h);
    }
  });
});

describe("formatElapsed", () => {
  it("formats sub-hour spans in minutes", () => {
    expect(formatElapsed(1)).toBe("1 minute");
    expect(formatElapsed(45)).toBe("45 minutes");
  });

  it("formats whole and mixed hours", () => {
    expect(formatElapsed(60)).toBe("1 hour");
    expect(formatElapsed(120)).toBe("2 hours");
    expect(formatElapsed(90)).toBe("1h 30m");
  });

  it("formats day-scale spans", () => {
    expect(formatElapsed(1440)).toBe("1 day");
    expect(formatElapsed(1500)).toBe("1 day 1h");
    expect(formatElapsed(2880)).toBe("2 days");
  });
});
