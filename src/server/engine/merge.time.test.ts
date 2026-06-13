import { describe, expect, it } from "vitest";
import { actionById } from "@/contracts/actions/registry";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { meterDefinitions } from "@/contracts/meters/registry";
import { DAYLIGHT_BAND_START_MINUTES, daylightBand, DEFAULT_CALENDAR_START, resolveGameTime } from "@/lib/clock";
import { DEFAULT_LINK_TRAVEL_MINUTES, FALLBACK_MINUTES_ADVANCED, MAX_MINUTES_ADVANCED, REST_CLAMP_MINUTES, SCHEDULE_JITTER_MINUTES } from "./constants";
import { declaredRestMinutes, detectDeclaredRest } from "./intent";
import {
  applyActionMeterEffects,
  clampRestMinutes,
  linkTravelMinutes,
  resolveTurnMinutes,
  scheduleEntryAt,
  scheduleJitter,
  type ScheduleEntry,
} from "./merge";
import type { SceneLinkInput } from "./scene";

const shower = actionById("shower")!; // 20m, hygiene set 0.95
const nap = actionById("nap")!; // 90m, energy +0.3

describe("resolveTurnMinutes", () => {
  it("ordinary scene: the clamped estimate wins", () => {
    expect(resolveTurnMinutes({ estimate: 5, travelMinutes: 0, actions: [] })).toEqual({
      minutes: 5,
      cause: "scene",
    });
  });

  it("registered action beats a smaller estimate", () => {
    expect(resolveTurnMinutes({ estimate: 5, travelMinutes: 0, actions: [shower] })).toEqual({
      minutes: 20,
      cause: "shower",
    });
  });

  it("decision 40: a larger estimate beats the registered action (hour-long talk over dinner)", () => {
    expect(resolveTurnMinutes({ estimate: 60, travelMinutes: 0, actions: [shower] })).toEqual({
      minutes: 60,
      cause: "scene",
    });
  });

  it("travel beats a smaller estimate", () => {
    expect(resolveTurnMinutes({ estimate: 2, travelMinutes: 10, actions: [] })).toEqual({
      minutes: 10,
      cause: "travel",
    });
  });

  it("max, not sum: walk (10m) + shower (20m) is 20 minutes", () => {
    const r = resolveTurnMinutes({ estimate: 1, travelMinutes: 10, actions: [shower] });
    expect(r.minutes).toBe(20);
    expect(r.cause).toBe("shower");
  });

  it("multiple actions: the longest wins, never the sum", () => {
    const r = resolveTurnMinutes({ estimate: 1, travelMinutes: 0, actions: [shower, nap] });
    expect(r.minutes).toBe(90);
    expect(r.cause).toBe("nap");
  });

  it("an authored component beats an equal estimate on ties", () => {
    expect(resolveTurnMinutes({ estimate: 20, travelMinutes: 0, actions: [shower] }).cause).toBe("shower");
    expect(resolveTurnMinutes({ estimate: 10, travelMinutes: 10, actions: [] }).cause).toBe("travel");
  });

  it("failed simulant: fallback estimate still participates", () => {
    expect(resolveTurnMinutes({ estimate: null, travelMinutes: 0, actions: [] })).toEqual({
      minutes: FALLBACK_MINUTES_ADVANCED,
      cause: "scene",
    });
    // fallback (30) still beats a shorter registered action
    expect(resolveTurnMinutes({ estimate: null, travelMinutes: 0, actions: [shower] }).minutes).toBe(
      FALLBACK_MINUTES_ADVANCED,
    );
  });
});

describe("declared rest detection (T7)", () => {
  const DAWN = DAYLIGHT_BAND_START_MINUTES.dawn;

  it("bare sleep intents default to the next morning (dawn band start)", () => {
    for (const input of ["I sleep.", "I go to bed.", "I turn in for the night.", "I fall asleep on the couch."]) {
      const rest = detectDeclaredRest(input);
      expect(rest, input).not.toBeNull();
      expect(rest?.activity).toBe("sleep");
      expect(rest?.untilMinute).toBe(DAWN);
      expect(rest?.label).toBe("morning");
    }
  });

  it("schedule-aware endpoints: named bands and explicit wake times", () => {
    expect(detectDeclaredRest("I sleep until morning.")?.untilMinute).toBe(DAWN);
    expect(detectDeclaredRest("I wait until evening.")).toMatchObject({
      activity: "wait",
      untilMinute: DAYLIGHT_BAND_START_MINUTES.dusk,
      label: "evening",
    });
    expect(detectDeclaredRest("I wait until 7am.")).toMatchObject({ untilMinute: 420, untilMinuteAlt: null });
    expect(detectDeclaredRest("I sleep until 19:30.")).toMatchObject({ untilMinute: 1170 });
    // No meridiem: keep both candidates; the resolver picks the sooner.
    expect(detectDeclaredRest("I sleep until 6:30.")).toMatchObject({ untilMinute: 390, untilMinuteAlt: 1110 });
  });

  it("explicit durations stay durations — never misread as clock times", () => {
    expect(detectDeclaredRest("I sleep for 2 hours.")).toMatchObject({ durationMinutes: 120, untilMinute: null });
    expect(detectDeclaredRest("I wait for 30 minutes.")).toMatchObject({ activity: "wait", durationMinutes: 30 });
  });

  it("does not trigger on refusals, waits without a time, quoted speech, or registered actions", () => {
    expect(detectDeclaredRest("I can't sleep.")).toBeNull();
    expect(detectDeclaredRest("I won't go to bed yet.")).toBeNull();
    expect(detectDeclaredRest("I wait for Mara.")).toBeNull();
    expect(detectDeclaredRest('"Go to sleep," I tell her.')).toBeNull();
    expect(detectDeclaredRest("I take a nap.")).toBeNull(); // registered action seam, 90 min
    expect(detectDeclaredRest("I look around.")).toBeNull(); // the no-regression case
  });

  it("endpoint math wraps past midnight: until morning at 23:00 vs 03:00", () => {
    const rest = detectDeclaredRest("I sleep until morning.");
    if (!rest) throw new Error("expected rest");
    expect(declaredRestMinutes(rest, 23 * 60)).toEqual({ minutes: 360, cause: "slept until morning" });
    expect(declaredRestMinutes(rest, 3 * 60)).toEqual({ minutes: 120, cause: "slept until morning" });
    // Already at the endpoint: a full day (the merge clamps it).
    expect(declaredRestMinutes(rest, DAWN).minutes).toBe(1440);
  });

  it("ambiguous 12-hour endpoints resolve to the sooner occurrence", () => {
    const rest = detectDeclaredRest("I wait until 7.");
    if (!rest) throw new Error("expected rest");
    expect(declaredRestMinutes(rest, 10 * 60)).toEqual({ minutes: 540, cause: "waited until 7:00" }); // → 19:00
    expect(declaredRestMinutes(rest, 23 * 60).minutes).toBe(480); // → 07:00
  });
});

describe("clampRestMinutes / rest in resolveTurnMinutes (T7)", () => {
  it("clamps to REST_CLAMP_MINUTES with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    expect(clampRestMinutes(1440, sink)).toBe(REST_CLAMP_MINUTES);
    expect(sink.items.some((d) => d.code === "merge.clock.rest_clamped")).toBe(true);
    expect(clampRestMinutes(REST_CLAMP_MINUTES)).toBe(REST_CLAMP_MINUTES);
    expect(clampRestMinutes(0)).toBe(1);
  });

  it("rest participates in max composition with its own clamp and cause", () => {
    expect(
      resolveTurnMinutes({ estimate: 30, travelMinutes: 0, actions: [], rest: { minutes: 360, cause: "slept until morning" } }),
    ).toEqual({ minutes: 360, cause: "slept until morning" });
    // A whole missed day clamps to 960 — above the 480 estimate ceiling.
    const sink = new DiagnosticCollector();
    const r = resolveTurnMinutes(
      { estimate: 100_000, travelMinutes: 0, actions: [], rest: { minutes: 1440, cause: "slept until morning" } },
      sink,
    );
    expect(r).toEqual({ minutes: REST_CLAMP_MINUTES, cause: "slept until morning" });
    expect(sink.items.some((d) => d.code === "merge.clock.rest_clamped")).toBe(true);
  });

  it("ordinary turns are unaffected: no rest component, estimate keeps the 480 clamp", () => {
    expect(resolveTurnMinutes({ estimate: 100_000, travelMinutes: 0, actions: [] })).toEqual({
      minutes: MAX_MINUTES_ADVANCED,
      cause: "scene",
    });
    expect(resolveTurnMinutes({ estimate: 25, travelMinutes: 0, actions: [], rest: null })).toEqual({
      minutes: 25,
      cause: "scene",
    });
  });
});

describe("linkTravelMinutes", () => {
  const links: SceneLinkInput[] = [
    { fromId: "a", toId: "b", travelMinutes: 10 },
    { fromId: "b", toId: "c" },
  ];

  it("reads the link cost in either direction", () => {
    expect(linkTravelMinutes("a", "b", links)).toBe(10);
    expect(linkTravelMinutes("b", "a", links)).toBe(10);
  });

  it("defaults when the link has no travelMinutes", () => {
    expect(linkTravelMinutes("b", "c", links)).toBe(DEFAULT_LINK_TRAVEL_MINUTES);
  });

  it("placing an unplaced participant costs nothing", () => {
    expect(linkTravelMinutes(null, "b", links)).toBe(0);
  });

  it("defaults for an unknown link (already validated as adjacent upstream)", () => {
    expect(linkTravelMinutes("a", "c", links)).toBe(DEFAULT_LINK_TRAVEL_MINUTES);
  });
});

describe("applyActionMeterEffects", () => {
  it("set wins over the current value (shower restores hygiene)", () => {
    const next = applyActionMeterEffects({ hygiene: 0.2, energy: 0.5 }, [shower], meterDefinitions);
    expect(next.hygiene).toBe(0.95);
    expect(next.energy).toBe(0.5);
  });

  it("delta adjusts and clamps", () => {
    const next = applyActionMeterEffects({ energy: 0.9 }, [nap], meterDefinitions);
    expect(next.energy).toBe(1);
  });

  it("unknown/disabled meter: effect skipped with a diagnostic, others still apply", () => {
    const sink = new DiagnosticCollector();
    const noHygiene = meterDefinitions.filter((d) => d.id !== "hygiene");
    const next = applyActionMeterEffects({ energy: 0.5 }, [shower, nap], noHygiene, sink, "Tester");
    expect(next.energy).toBeCloseTo(0.8, 10);
    expect(next.hygiene).toBeUndefined();
    expect(sink.items.some((d) => d.code === "merge.action.unknown_meter")).toBe(true);
  });
});

describe("schedule day mask", () => {
  const weekdaysOnly: ScheduleEntry = {
    startMinute: 540,
    endMinute: 1020,
    locationName: "Shop",
    activity: "working",
    days: [1, 2, 3, 4, 5],
  };
  const nightlyWrap: ScheduleEntry = { startMinute: 1320, endMinute: 360, locationName: "Home", activity: "sleeping" };

  it("entries without days match every weekday (old entries parse unchanged)", () => {
    expect(scheduleEntryAt([nightlyWrap], 1400, 0)?.activity).toBe("sleeping");
    expect(scheduleEntryAt([nightlyWrap], 1400, 6)?.activity).toBe("sleeping");
  });

  it("masked entries skip off days", () => {
    expect(scheduleEntryAt([weekdaysOnly], 600, 2)?.activity).toBe("working"); // Tuesday
    expect(scheduleEntryAt([weekdaysOnly], 600, 0)).toBeNull(); // Sunday
    expect(scheduleEntryAt([weekdaysOnly], 600, 6)).toBeNull(); // Saturday
  });

  it("no weekday argument keeps legacy behavior (mask ignored)", () => {
    expect(scheduleEntryAt([weekdaysOnly], 600)?.activity).toBe("working");
  });
});

describe("scheduleJitter", () => {
  it("is deterministic per character per day and bounded", () => {
    const a = scheduleJitter("npc-1", 3);
    expect(scheduleJitter("npc-1", 3)).toBe(a);
    expect(Math.abs(a)).toBeLessThanOrEqual(SCHEDULE_JITTER_MINUTES);
  });

  it("varies across days and characters", () => {
    const days = new Set(Array.from({ length: 14 }, (_, d) => scheduleJitter("npc-1", d)));
    expect(days.size).toBeGreaterThan(1);
    expect(scheduleJitter("npc-1", 3) === scheduleJitter("npc-2", 3)).toBe(false);
  });
});

describe("game time context", () => {
  it("exposes weekdayIndex and dayIndex", () => {
    // DEFAULT_CALENDAR_START is Saturday, June 1, 2024, 08:00.
    const t0 = resolveGameTime(0, DEFAULT_CALENDAR_START);
    expect(t0.weekdayIndex).toBe(6);
    expect(t0.dayIndex).toBe(0);
    const nextDay = resolveGameTime(24 * 60, DEFAULT_CALENDAR_START);
    expect(nextDay.dayIndex).toBe(1);
    expect(nextDay.weekdayIndex).toBe(0);
    // dayIndex rolls at midnight, not 24h after start (start is 08:00).
    const lateNight = resolveGameTime(17 * 60, DEFAULT_CALENDAR_START); // 01:00 next day
    expect(lateNight.dayIndex).toBe(1);
  });

  it("daylight bands follow the v1 boundaries", () => {
    const at = (hour: number) => resolveGameTime((hour - 8) * 60, DEFAULT_CALENDAR_START);
    expect(daylightBand(at(5))).toBe("dawn");
    expect(daylightBand(at(12))).toBe("day");
    expect(daylightBand(at(18))).toBe("dusk");
    expect(daylightBand(at(23))).toBe("night");
    expect(daylightBand(at(2))).toBe("night");
  });
});
