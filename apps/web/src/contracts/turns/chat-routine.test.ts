import { describe, expect, it } from "vitest";
import type { ScheduleEntry } from "../world/profile";
import { CHAT_DEFAULT_CALENDAR_START } from "./chat-clock";
import { routineLandings, scheduleOccurrences, sleepRoutineOf } from "./chat-routine";

/** Chat minute of `hour:minute` on calendar day `day` (default anchor: day 0, 8:00am = minute 0). */
const at = (day: number, hour: number, minute = 0): number => day * 1_440 + hour * 60 + minute - 8 * 60;

const row = (kind: ScheduleEntry["kind"], startMinute: number, endMinute: number): ScheduleEntry => ({
  startMinute,
  endMinute,
  locationName: "home",
  activity: kind ?? "errands",
  ...(kind === undefined ? {} : { kind }),
});

const washesBetween = (schedule: readonly ScheduleEntry[], from: number, to: number): number[] =>
  routineLandings(schedule, "wash", from, to, CHAT_DEFAULT_CALENDAR_START);

describe("the default morning wash", () => {
  it("lands once per story day, as that day's main sleep window ends — a nap never earns a second", () => {
    const nightAndNap = [row("sleep", 1_380, 420), row("sleep", 840, 930)]; // 23:00–07:00 and 14:00–15:30
    const expected = [at(1, 7), at(2, 7), at(3, 7)];
    expect(washesBetween(nightAndNap, at(0, 8), at(3, 8))).toEqual(expected);
    // Chosen per whole day, so however the span is read the same washes land.
    expect([
      ...washesBetween(nightAndNap, at(0, 8), at(0, 15, 30)),
      ...washesBetween(nightAndNap, at(0, 15, 30), at(1, 12)),
      ...washesBetween(nightAndNap, at(1, 12), at(3, 8)),
    ]).toEqual(expected);
  });

  it("gives way to a typed wash window, which lands at its own end", () => {
    const eveningBather = [row("sleep", 1_380, 420), row("wash", 1_140, 1_170)]; // wash 19:00–19:30
    expect(washesBetween(eveningBather, at(0, 8), at(2, 8))).toEqual([at(0, 19, 30), at(1, 19, 30)]);
  });
});

describe("zero-length rows", () => {
  it("a sleep row whose start equals its end is no window: the default night stands", () => {
    const degenerate = [row("sleep", 1_380, 1_380)];
    expect(sleepRoutineOf(degenerate)).toEqual(sleepRoutineOf([]));
    const nights = scheduleOccurrences(sleepRoutineOf(degenerate), "sleep", at(0, 8), at(1, 8), CHAT_DEFAULT_CALENDAR_START);
    expect(nights.map((night) => [night.startMinutes, night.endMinutes])).toEqual([[at(0, 23), at(1, 7)]]);
  });

  it("a wash row whose start equals its end does not replace the default wash", () => {
    expect(washesBetween([row("wash", 420, 420)], at(0, 8), at(1, 8))).toEqual(washesBetween([], at(0, 8), at(1, 8)));
    expect(washesBetween([row("wash", 420, 420)], at(0, 8), at(1, 8))).toEqual([at(1, 7)]);
  });
});
