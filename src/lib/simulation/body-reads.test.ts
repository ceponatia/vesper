import { describe, expect, it } from "vitest";
import {
  bodyMeterRegistryV1,
  bodyMeterStateSchema,
  bodyModifierSchema,
  bodyRhythmRowSchema,
  type BodyMeterDefinition,
  type BodyRhythmRow,
} from "@/contracts/simulation/bodies";
import {
  deriveSleepCredit,
  integrateMeterValue,
  selfCareAdjustmentsBetween,
  solveNextThresholdCrossing,
  type MeterIntegrationView,
} from "./bodies";
import {
  circadianComponentFixedPoint,
  deriveCircadianPressure,
  deriveDeficitRead,
  deriveEnergyRead,
  deriveIntimacyRead,
  deriveVisibleBodySigns,
  resolveSleepWindow,
  storySecondAt,
} from "./body-reads";

const ACTOR = "actor-mara";

/** 7am wake / 11pm bed — the chat spec's verified reference actor. */
const SLEEP_ROW: BodyRhythmRow = bodyRhythmRowSchema.parse({
  actorId: ACTOR,
  kind: "sleep",
  startMinuteOfDay: 1_380,
  endMinuteOfDay: 420,
});

const WASH_ROW: BodyRhythmRow = bodyRhythmRowSchema.parse({
  actorId: ACTOR,
  kind: "wash",
  startMinuteOfDay: 405,
  endMinuteOfDay: 420,
});

/** Day-10 7am, the reference wake instant with a full 0.95 reserve. */
const WAKE = storySecondAt(10, 420);

function registryDefinition(key: string): BodyMeterDefinition {
  const definition = bodyMeterRegistryV1.find((candidate) => candidate.key === key);
  if (!definition) throw new Error(`registry meter ${key} missing`);
  return definition;
}

function energyViewAtWake(): MeterIntegrationView {
  return {
    definition: registryDefinition("energy"),
    state: bodyMeterStateSchema.parse({
      actorId: ACTOR,
      meterKey: "energy",
      valueFixedPoint: 9_500,
      baselineFixedPoint: 0,
      lastIntegratedAtStorySecond: WAKE,
      registryVersion: "body-v1",
    }),
    modifiers: [],
  };
}

function pressureAt(atStorySecond: number, lastSleepEndedAtStorySecond: number): number {
  return deriveCircadianPressure({
    atStorySecond,
    rhythmRows: [SLEEP_ROW],
    lastSleepEndedAtStorySecond,
  });
}

describe("E5.2 circadian pressure and the bidirectional energy read", () => {
  it("reproduces the chat spec's verified table across a 40-hour bender", () => {
    const view = energyViewAtWake();
    const table = [
      // [hours awake, expected read, tolerance, band]
      [4, 6_898, 80, "bright"],
      [8, 4_262, 80, "steady"],
      [14, 1_960, 80, "winding_down"],
      [21, -7_904, 120, "wrecked"],
      [25, -3_267, 400, "dragging"],
      [40, -10_000, 0, "collapsing"],
    ] as const;
    for (const [hours, expected, tolerance, band] of table) {
      const at = WAKE + hours * 3_600;
      const read = deriveEnergyRead({
        reserveFixedPoint: integrateMeterValue(view, at),
        pressureFixedPoint: pressureAt(at, WAKE),
      });
      expect(Math.abs(read.signedFixedPoint - expected)).toBeLessThanOrEqual(tolerance);
      expect(read.band).toBe(band);
    }
  });

  it("defines zero as bedtime: reserve meets pressure at the actor's own 11pm", () => {
    const view = energyViewAtWake();
    const bedtime = WAKE + 16 * 3_600;
    const read = deriveDeficitRead(
      integrateMeterValue(view, bedtime),
      pressureAt(bedtime, WAKE),
    );
    expect(Math.abs(read)).toBeLessThanOrEqual(150);
  });

  it("keeps the second wind: 8am after an all-nighter reads better than 4am", () => {
    const view = energyViewAtWake();
    const fourAm = WAKE + 21 * 3_600;
    const eightAm = WAKE + 25 * 3_600;
    const readAt = (at: number) =>
      deriveDeficitRead(integrateMeterValue(view, at), pressureAt(at, WAKE));
    expect(readAt(eightAm)).toBeGreaterThan(readAt(fourAm));
  });

  it("saturates the floor at −1 with no hardcoded hour", () => {
    const view = energyViewAtWake();
    const read = deriveEnergyRead({
      reserveFixedPoint: integrateMeterValue(view, WAKE + 40 * 3_600),
      pressureFixedPoint: pressureAt(WAKE + 40 * 3_600, WAKE),
    });
    expect(read.signedFixedPoint).toBe(-10_000);
    expect(read.band).toBe("collapsing");
  });

  it("answers the nap case: past bedtime but fueled reads up and a little wired", () => {
    // Naps 2–6pm: decay to 2pm, suspend during the nap, credit at wake.
    const napStart = WAKE + 7 * 3_600;
    const napEnd = WAKE + 11 * 3_600;
    const suspended: MeterIntegrationView = {
      ...energyViewAtWake(),
      modifiers: [
        bodyModifierSchema.parse({
          id: "mod-nap",
          actorId: ACTOR,
          meterKey: "energy",
          operation: { kind: "suspend" },
          stackingGroup: "sleep",
          priority: 0,
          validFromStorySecond: napStart,
          validUntilStorySecond: napEnd,
          visibility: "obvious",
          sourceEventId: "event-nap",
        }),
      ],
    };
    const reserveAtNapEnd = integrateMeterValue(suspended, napEnd);
    const credit = deriveSleepCredit({
      sleptSeconds: napEnd - napStart,
      reserveAtWakeFixedPoint: reserveAtNapEnd,
    });
    // 4h of restore would overshoot; the cap binds and she wakes at 0.95.
    expect(reserveAtNapEnd + credit).toBe(9_500);

    const rested: MeterIntegrationView = {
      ...energyViewAtWake(),
      state: bodyMeterStateSchema.parse({
        actorId: ACTOR,
        meterKey: "energy",
        valueFixedPoint: 9_500,
        baselineFixedPoint: 0,
        lastIntegratedAtStorySecond: napEnd,
        registryVersion: "body-v1",
      }),
    };
    const bedtime = WAKE + 16 * 3_600;
    const read = deriveDeficitRead(
      integrateMeterValue(rested, bedtime),
      pressureAt(bedtime, napEnd),
    );
    // The spec's answer: read ≈ +0.35 — up, and a little wired.
    expect(read).toBeGreaterThan(3_300);
    expect(read).toBeLessThan(3_600);
  });

  it("credits sleep by the spec's arithmetic: full night refills, a bender leaves debt", () => {
    const night = 8 * 3_600;
    expect(deriveSleepCredit({ sleptSeconds: night, reserveAtWakeFixedPoint: 3_500 })).toBe(6_000);
    // 0.08 + 0.72 → 0.80: day two starts short, with no debt mechanic written.
    expect(deriveSleepCredit({ sleptSeconds: night, reserveAtWakeFixedPoint: 800 })).toBe(7_200);
    expect(deriveSleepCredit({ sleptSeconds: 0, reserveAtWakeFixedPoint: 800 })).toBe(0);
    // Linear restore composes exactly: split sleep credits identically.
    const splitA = deriveSleepCredit({ sleptSeconds: 3 * 3_600, reserveAtWakeFixedPoint: 800 });
    const splitB = deriveSleepCredit({ sleptSeconds: 5 * 3_600, reserveAtWakeFixedPoint: 800 + splitA });
    expect(splitA + splitB).toBe(7_200);
  });

  it("falls back to the default window and degrades strange windows", () => {
    expect(resolveSleepWindow([])).toEqual({ startMinuteOfDay: 1_380, endMinuteOfDay: 420 });
    // A 20h "sleep window" makes the anchors collide; the curve degrades to
    // the default geometry instead of failing the read.
    const strange = { startMinuteOfDay: 600, endMinuteOfDay: 540 };
    const normal = circadianComponentFixedPoint(WAKE, { startMinuteOfDay: 1_380, endMinuteOfDay: 420 });
    expect(circadianComponentFixedPoint(WAKE, strange)).toBe(normal);
  });

  it("escalates nothing through a rhythm-followed day with no sleep history", () => {
    const at = storySecondAt(12, 1_200);
    const withHistory = pressureAt(at, storySecondAt(12, 420));
    const assumed = deriveCircadianPressure({ atStorySecond: at, rhythmRows: [SLEEP_ROW] });
    expect(assumed).toBe(withHistory);
  });
});

describe("E5.2 intimacy pulse and visible signs (OQ2)", () => {
  it("grades arousal to the physiological vocabulary, afterglow overriding", () => {
    expect(deriveIntimacyRead({ arousalFixedPoint: 500, afterglowActive: false })).toBe("quiescent");
    expect(deriveIntimacyRead({ arousalFixedPoint: 3_000, afterglowActive: false })).toBe("kindled");
    expect(deriveIntimacyRead({ arousalFixedPoint: 5_000, afterglowActive: false })).toBe("flushed");
    expect(deriveIntimacyRead({ arousalFixedPoint: 7_000, afterglowActive: false })).toBe("wound_tight");
    expect(deriveIntimacyRead({ arousalFixedPoint: 9_000, afterglowActive: false })).toBe("cresting");
    // The settled body after climax is its own phase, not "low arousal".
    expect(deriveIntimacyRead({ arousalFixedPoint: 500, afterglowActive: true })).toBe("afterglow");
  });

  it("gates signs by detail tier: glimpse nothing, sight skin, engagement breath", () => {
    const wired = {
      energyRead: deriveEnergyRead({ reserveFixedPoint: 2_000, pressureFixedPoint: 8_000 }),
      arousalFixedPoint: 9_000,
      afterglowActive: false,
    };
    expect(deriveVisibleBodySigns({ ...wired, detailTier: 1 })).toEqual([]);
    expect(deriveVisibleBodySigns({ ...wired, detailTier: 2 })).toEqual([
      "visible_exhaustion",
      "flushed_skin",
    ]);
    expect(deriveVisibleBodySigns({ ...wired, detailTier: 3 })).toEqual([
      "visible_exhaustion",
      "flushed_skin",
      "quickened_breath",
      "taut_attention",
    ]);
    const afterglow = deriveVisibleBodySigns({
      energyRead: deriveEnergyRead({ reserveFixedPoint: 8_000, pressureFixedPoint: 1_000 }),
      arousalFixedPoint: 500,
      afterglowActive: true,
      detailTier: 3,
    });
    expect(afterglow).toEqual(["afterglow_softness"]);
  });
});

describe("E5.2 wash crossings — the §25.5 window law", () => {
  function hygieneView(valueFixedPoint: number, lastIntegratedAt: number): MeterIntegrationView {
    return {
      definition: registryDefinition("hygiene"),
      state: bodyMeterStateSchema.parse({
        actorId: ACTOR,
        meterKey: "hygiene",
        valueFixedPoint,
        baselineFixedPoint: 0,
        lastIntegratedAtStorySecond: lastIntegratedAt,
        registryVersion: "body-v1",
      }),
      modifiers: [],
      // Through the full solve horizon, as the store threads them.
      scheduledAdjustments: selfCareAdjustmentsBetween(
        [WASH_ROW],
        "hygiene",
        lastIntegratedAt,
        lastIntegratedAt + 31 * 86_400,
      ),
    };
  }

  it("lands 6am and 8am differently: only a crossed wash row credits", () => {
    const tenPm = storySecondAt(10, 1_320);
    const view = hygieneView(5_000, tenPm);
    // 6am next day: the 7am row is NOT crossed — she has not showered.
    expect(integrateMeterValue(view, storySecondAt(11, 360))).toBe(3_800);
    // 8am: crossed at 7am (set 0.95), then one further hour of honest drain.
    expect(integrateMeterValue(view, storySecondAt(11, 480))).toBe(9_350);
    // Exactly at the crossing minute the wash has just landed.
    expect(integrateMeterValue(view, storySecondAt(11, 420))).toBe(9_500);
  });

  it("one big skip equals its partitions across the crossing", () => {
    const tenPm = storySecondAt(10, 1_320);
    const view = hygieneView(5_000, tenPm);
    const direct = integrateMeterValue(view, storySecondAt(11, 480));
    // Probing at every intermediate hour persists nothing and changes nothing.
    for (let hour = 0; hour < 10; hour += 1) {
      integrateMeterValue(view, tenPm + hour * 3_600);
    }
    expect(integrateMeterValue(view, storySecondAt(11, 480))).toBe(direct);
  });

  it("suppresses the grimy alarm entirely while a daily wash holds the line", () => {
    const tenPm = storySecondAt(10, 1_320);
    expect(solveNextThresholdCrossing(hygieneView(9_000, tenPm), tenPm)).toBeUndefined();
    // Without the rhythm the same state crosses on schedule.
    const bare: MeterIntegrationView = { ...hygieneView(9_000, tenPm), scheduledAdjustments: [] };
    expect(solveNextThresholdCrossing(bare, tenPm)?.crossesAtStorySecond).toBe(
      tenPm + ((9_000 - 2_500) * 3_600) / 150,
    );
  });

  it("lets a wash preempt a crossing due minutes after it", () => {
    const sixFifty = storySecondAt(11, 410);
    const view = hygieneView(2_650, sixFifty);
    // Drift would cross 2 500 at ~7:50, but the 7:00 wash resets first and
    // the daily rhythm then holds the meter above the line for good.
    expect(solveNextThresholdCrossing(view, sixFifty)).toBeUndefined();
    const bare: MeterIntegrationView = { ...view, scheduledAdjustments: [] };
    expect(bare && solveNextThresholdCrossing(bare, sixFifty)?.crossesAtStorySecond).toBe(
      sixFifty + ((2_650 - 2_500) * 3_600) / 150,
    );
  });
});
