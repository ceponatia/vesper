import { describe, expect, it } from "vitest";
import {
  CHAT_DEFAULT_CALENDAR_START,
  chatGameTime,
  chatMomentLabel,
  dayPartAtMinute,
  dayStartClockMinutes,
  formatChatDate,
  formatChatMoment,
  formatChatTime,
  formatStoryMoment,
  ordinalDay,
  timeOfDayFor,
} from "./chat-clock";

const START = CHAT_DEFAULT_CALENDAR_START;
const DAY = 1440;

describe("the default anchor (owner ruling: stories begin January 1, 8:00am)", () => {
  it("minute 0 is Monday, January 1 at 8:00am (2024 pins Jan 1 to a Monday)", () => {
    const t = chatGameTime(0, START);
    expect(formatChatDate(t)).toBe("Monday, January 1");
    expect(formatChatTime(t)).toBe("8:00am");
    expect(t.weekdayIndex).toBe(1);
    expect(t.dayIndex).toBe(0);
  });

  it("the calendar is REAL: month lengths and the leap February come from Date math", () => {
    // 8:00am + 30 full days = Jan 31; one more = Feb 1 (January has 31 days).
    expect(chatGameTime(30 * DAY, START).day).toBe(31);
    expect(chatGameTime(31 * DAY, START).month).toBe(2);
    // 2024 is a leap year: day-index 59 from Jan 1 is Feb 29.
    const leap = chatGameTime(59 * DAY, START);
    expect([leap.month, leap.day]).toEqual([2, 29]);
  });
});

describe("dayPartAtMinute / timeOfDayFor (the canonical block-of-time shorthand)", () => {
  it("maps SCHEDULE_DAY_PARTS boundaries, wrapping night past midnight", () => {
    expect(dayPartAtMinute(359)).toBe("night");
    expect(dayPartAtMinute(360)).toBe("morning");
    expect(dayPartAtMinute(719)).toBe("morning");
    expect(dayPartAtMinute(720)).toBe("afternoon");
    expect(dayPartAtMinute(1080)).toBe("evening");
    expect(dayPartAtMinute(1379)).toBe("evening");
    expect(dayPartAtMinute(1380)).toBe("night");
    expect(dayPartAtMinute(0)).toBe("night");
  });

  it("derives from the clock against the anchor (8:00am start ⇒ clock 0 is morning)", () => {
    expect(timeOfDayFor(0, START)).toBe("morning");
    expect(timeOfDayFor(360, START)).toBe("afternoon"); // 2:00pm
    expect(timeOfDayFor(660, START)).toBe("evening"); // 7:00pm
    expect(timeOfDayFor(990, START)).toBe("night"); // 12:30am next day
  });
});

describe("day boundaries against the anchor", () => {
  it("dayStartClockMinutes lands on real midnight, not clock % 1440", () => {
    expect(dayStartClockMinutes(0, START)).toBe(-480); // midnight before the 8am start
    expect(dayStartClockMinutes(959, START)).toBe(-480); // 11:59pm, same story day
    expect(dayStartClockMinutes(960, START)).toBe(960); // midnight → day 2 begins
  });
});

describe("formatting", () => {
  it("formatChatMoment is the compact weekday + day-part landing", () => {
    // Friday 6:00pm = 4 days + 10h after Monday 8:00am.
    expect(formatChatMoment(4 * DAY + 600, START)).toBe("Friday evening");
  });

  it("formatStoryMoment is the full narrator/clock-card line", () => {
    expect(formatStoryMoment(0, START)).toBe("Monday, January 1 — 8:00am (morning)");
  });

  it("ordinalDay speaks English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinalDay)).toEqual([
      "the 1st", "the 2nd", "the 3rd", "the 4th", "the 11th", "the 12th", "the 13th",
      "the 21st", "the 22nd", "the 23rd", "the 31st",
    ]);
  });
});

describe("chatMomentLabel (owner ruling: real weekdays in plan labels)", () => {
  const now = 120; // Monday morning, 10:00am
  it("keeps natural words for today and tomorrow", () => {
    expect(chatMomentLabel(300, now, START)).toBe("this afternoon"); // Monday 1:00pm
    expect(chatMomentLabel(600, now, START)).toBe("this evening"); // Monday 6:00pm
    expect(chatMomentLabel(920, now, START)).toBe("tonight"); // Monday 11:20pm
    expect(chatMomentLabel(DAY + 600, now, START)).toBe("tomorrow evening"); // Tuesday 6:00pm
  });

  it("uses the bare weekday inside a week and the date beyond it", () => {
    expect(chatMomentLabel(4 * DAY + 600, now, START)).toBe("Friday evening");
    expect(chatMomentLabel(7 * DAY + 60, now, START)).toBe("Monday the 8th, morning");
  });

  it("keeps the weekday form for past targets (justMissed fallout)", () => {
    // Target: Saturday 9:00am (day 5); now: two days later.
    expect(chatMomentLabel(5 * DAY + 60, 7 * DAY, START)).toBe("Saturday morning");
  });
});
