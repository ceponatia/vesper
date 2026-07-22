import { describe, expect, it } from "vitest";
import { formatChatDate, formatChatTime, chatGameTime, formatStoryMoment } from "@/contracts";
import { formatStoryClock, formatStoryClockShort, formatStoryTime, storyCalendarParams, storyClockAt } from "./clock";

// R3 slice 4 (ruling 17): the sim story clock made legible — exactly what
// storySecond encodes (day index, time of day, light band), nothing invented.

describe("storyClockAt", () => {
  it("splits a storySecond into day index and clock time", () => {
    // The rollout world's origin: day 2 at 10:00am.
    const clock = storyClockAt(2 * 86_400 + 600 * 60);
    expect(clock.dayIndex).toBe(2);
    expect(clock.hour).toBe(10);
    expect(clock.minute).toBe(0);
    expect(clock.band).toBe("day");
    expect(clock.dayPart).toBe("morning");
  });

  it("maps hours onto the colloquial day parts", () => {
    expect(storyClockAt(8 * 3_600).dayPart).toBe("morning");
    expect(storyClockAt(13 * 3_600).dayPart).toBe("afternoon");
    expect(storyClockAt(19 * 3_600).dayPart).toBe("evening");
    expect(storyClockAt(23 * 3_600).dayPart).toBe("night");
    expect(storyClockAt(2 * 3_600).dayPart).toBe("night");
  });

  it("shares the daylight-band thresholds with the legacy clock", () => {
    expect(storyClockAt(6 * 3_600).band).toBe("dawn");
    expect(storyClockAt(12 * 3_600).band).toBe("day");
    expect(storyClockAt(19 * 3_600).band).toBe("dusk");
    expect(storyClockAt(22 * 3_600).band).toBe("night");
  });
});

describe("story clock formatting", () => {
  it("renders the face, the chip label, and the narrator line", () => {
    const clock = storyClockAt(2 * 86_400 + (10 * 60 + 4) * 60);
    expect(formatStoryTime(clock)).toBe("10:04am");
    expect(formatStoryClockShort(clock)).toBe("Day 3 · 10:04am");
    expect(formatStoryClock(clock)).toBe("Day 3 · 10:04am (morning)");
  });

  it("keeps midnight and noon on the 12-hour face", () => {
    expect(formatStoryTime(storyClockAt(0))).toBe("12:00am");
    expect(formatStoryTime(storyClockAt(12 * 3_600))).toBe("12:00pm");
  });
});

describe("storyCalendarParams (R5 calendar adapter)", () => {
  it("maps storySecond onto the legacy Gregorian formatters verbatim", () => {
    // Day 0 = Monday, June 1 2026; day 2 at 10:04am.
    const anchor = { year: 2026, month: 6, day: 1 };
    const params = storyCalendarParams(2 * 86_400 + (10 * 60 + 4) * 60, anchor);
    const time = chatGameTime(params.clockMinutes, params.calendarStart);
    expect(formatChatDate(time)).toBe("Wednesday, June 3");
    expect(formatChatTime(time)).toBe("10:04am");
    expect(formatStoryMoment(params.clockMinutes, params.calendarStart)).toBe(
      "Wednesday, June 3 — 10:04am (morning)",
    );
  });

  it("story day zero starts at the anchor date's midnight", () => {
    const params = storyCalendarParams(0, { year: 2026, month: 6, day: 1 });
    const time = chatGameTime(params.clockMinutes, params.calendarStart);
    expect(time.weekday).toBe("Monday");
    expect(time.hour).toBe(0);
    expect(time.dayIndex).toBe(0);
  });
});
