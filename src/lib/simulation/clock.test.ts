import { describe, expect, it } from "vitest";
import { formatStoryClock, formatStoryClockShort, formatStoryTime, storyClockAt } from "./clock";

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
