import { describe, expect, it } from "vitest";
import { circadianCurveV1, METER_FIXED_POINT_ONE } from "@vesper/simulation-core/contracts/bodies";
import { CHAT_DEFAULT_CALENDAR_START } from "../turns/chat-clock";
import type { ScheduleEntry } from "../world/profile";
import { deriveChatEnergyRead, meterReadPips, readChatMeters, type ChatMeterReadContext } from "./reads";
import { meterStateCue } from "./registry";

/**
 * The chat minute of `hour:minute` on calendar day `day` for the default anchor
 * (Monday 1 January 2024, 8:00am — chat minute 0).
 */
const at = (day: number, hour: number, minute = 0): number => day * 1_440 + hour * 60 + minute - 8 * 60;

const context = (clockMinutes: number, overrides: Partial<ChatMeterReadContext> = {}): ChatMeterReadContext => ({
  clockMinutes,
  calendarStart: CHAT_DEFAULT_CALENDAR_START,
  schedule: [],
  lastSleepEndedAtMinutes: null,
  conditions: [],
  ...overrides,
});

const pressureAt = (clockMinutes: number, overrides: Partial<ChatMeterReadContext> = {}): number =>
  deriveChatEnergyRead(0.5, context(clockMinutes, overrides)).pressureFixedPoint;

const sleepRow = (startMinute: number, endMinute: number, days?: number[]): ScheduleEntry => ({
  startMinute,
  endMinute,
  locationName: "home",
  activity: "sleeping",
  kind: "sleep",
  ...(days === undefined ? {} : { days }),
});

describe("sleep pressure on the chat calendar", () => {
  it("follows the default 23:00–07:00 window when no row is typed sleep", () => {
    expect(pressureAt(at(0, 23))).toBe(circadianCurveV1.bedtimeFixedPoint);
    expect(pressureAt(at(0, 11))).toBe(circadianCurveV1.dayFloorFixedPoint); // four hours after the 07:00 wake
    // A kind-less row never shapes pressure, whatever its window.
    const untyped: ScheduleEntry = { ...sleepRow(60, 540), kind: undefined };
    expect(pressureAt(at(0, 23), { schedule: [untyped] })).toBe(circadianCurveV1.bedtimeFixedPoint);
  });

  it("follows a non-default sleep row and the calendar anchor's own time of day", () => {
    const schedule = [sleepRow(60, 540)]; // 01:00–09:00
    expect(pressureAt(at(1, 1), { schedule })).toBe(circadianCurveV1.bedtimeFixedPoint);
    expect(pressureAt(at(0, 13), { schedule })).toBe(circadianCurveV1.dayFloorFixedPoint);
    // Anchored at 21:30, chat minute 90 is 23:00 on the story calendar.
    const lateAnchor = { ...CHAT_DEFAULT_CALENDAR_START, hour: 21, minute: 30 };
    expect(pressureAt(90, { calendarStart: lateAnchor })).toBe(circadianCurveV1.bedtimeFixedPoint);
  });

  it("honors weekday masks: the sleep window that last began governs", () => {
    // Sunday–Thursday nights 23:00–07:00, and a Saturday 01:00–10:00 lie-in.
    const schedule = [sleepRow(1_380, 420, [0, 1, 2, 3, 4]), sleepRow(60, 600, [6])];
    expect(pressureAt(at(2, 23), { schedule })).toBe(circadianCurveV1.bedtimeFixedPoint); // Wednesday
    // Saturday 23:00: the lie-in is the last window to begin, so its geometry
    // holds — two hours before its own 01:00 bedtime, on the ramp.
    expect(pressureAt(at(5, 23), { schedule })).toBe(circadianCurveV1.rampFixedPoint);
  });
});

describe("the energy read", () => {
  /** The reserve a normal day leaves at bedtime — the curve's zero definition. */
  const bedtimeReserve = circadianCurveV1.bedtimeFixedPoint / METER_FIXED_POINT_ONE;

  it("is zero at a normal day's bedtime and falls into the night trough when kept up", () => {
    expect(deriveChatEnergyRead(bedtimeReserve, context(at(0, 23))).read.signedFixedPoint).toBe(0);
    const trough = deriveChatEnergyRead(bedtimeReserve, context(at(1, 4))); // bedtime + 5 h, still up
    expect(trough.pressureFixedPoint).toBeGreaterThanOrEqual(circadianCurveV1.troughPeakFixedPoint);
    expect(trough.read.band).toBe("wrecked");
  });

  it("stays within −1…1 at both poles, and its band-scale value within 0…1", () => {
    const restedContext = context(at(0, 11));
    // Awake since 07:00 two days ago, at 4am: pressure far past any reserve.
    const spentContext = context(at(1, 4), { lastSleepEndedAtMinutes: at(-2, 7) });
    expect(deriveChatEnergyRead(1, restedContext).read.signedFixedPoint).toBeLessThanOrEqual(METER_FIXED_POINT_ONE);
    expect(deriveChatEnergyRead(0, spentContext).read.signedFixedPoint).toBe(-METER_FIXED_POINT_ONE);
    expect(readChatMeters({ energy: 1 }, restedContext).energy).toBeLessThanOrEqual(1);
    expect(readChatMeters({ energy: 0 }, spentContext).energy).toBe(0);
  });

  it("drives energy's bands from the balance, not the reserve", () => {
    // The same reserve reads as nothing to say at bedtime and exhausted at 4am.
    const atBedtime = readChatMeters({ energy: bedtimeReserve }, context(at(0, 23))).energy ?? Number.NaN;
    expect(meterStateCue("energy", atBedtime)).toBeNull();
    const kept = readChatMeters({ energy: bedtimeReserve }, context(at(1, 4)));
    expect(meterStateCue("energy", kept.energy ?? Number.NaN)?.pipLabel).toBe("exhausted");
    expect(meterReadPips(kept)).toContainEqual({ meterId: "energy", label: "exhausted" });
  });

  it("reads every meter as stored when another engine owns them (no context)", () => {
    expect(readChatMeters({ energy: 0.2, hygiene: 0.5 }, null)).toEqual({ energy: 0.2, hygiene: 0.5 });
  });
});

describe("meterReadPips", () => {
  it("gives mood's valence chips from the same read path as every threshold chip", () => {
    expect(meterReadPips({ mood: 0.9 })).toEqual([{ meterId: "mood", label: "bright" }]);
    expect(meterReadPips({ mood: 0.2 })).toEqual([{ meterId: "mood", label: "low" }]);
    expect(meterReadPips({ mood: 0.5, intoxication: 0.8 })).toEqual([{ meterId: "intoxication", label: "drunk" }]);
  });
});
