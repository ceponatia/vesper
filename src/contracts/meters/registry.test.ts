import { describe, expect, it } from "vitest";
import {
  applyMeterDrift,
  crossedThresholdHints,
  deriveMoodDescriptor,
  initialMeters,
  meterBaselineOf,
  meterById,
  meterDefinitions,
  type MeterDefinition,
} from "./registry";

describe("meter registry", () => {
  it("ids are unique and initial values are in range", () => {
    const ids = meterDefinitions.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of meterDefinitions) {
      expect(def.initial).toBeGreaterThanOrEqual(0);
      expect(def.initial).toBeLessThanOrEqual(1);
    }
  });

  it("initialMeters seeds every definition at its initial value", () => {
    const meters = initialMeters();
    expect(Object.keys(meters).sort()).toEqual(meterDefinitions.map((m) => m.id).sort());
    expect(meters.hygiene).toBe(meterById("hygiene")?.initial);
  });
});

describe("applyMeterDrift", () => {
  it("applies signed per-hour drift scaled by elapsed minutes", () => {
    const next = applyMeterDrift({ hygiene: 0.9, stress: 0.5 }, 60);
    expect(next.hygiene).toBeCloseTo(0.86, 10); // -0.04/h
    expect(next.stress).toBeCloseTo(0.47, 10); // -0.03/h
  });

  it("scales fractionally for partial hours", () => {
    const next = applyMeterDrift({ hygiene: 0.9 }, 30);
    expect(next.hygiene).toBeCloseTo(0.88, 10);
  });

  it("clamps at 0", () => {
    const next = applyMeterDrift({ hygiene: 0.02 }, 120);
    expect(next.hygiene).toBe(0);
  });

  it("clamps at 1", () => {
    const rising: MeterDefinition = {
      id: "warmth",
      label: "Warmth",
      description: "Synthetic rising meter.",
      initial: 0.5,
      perHour: 0.5,
      thresholds: [],
    };
    const next = applyMeterDrift({ warmth: 0.9 }, 120, [rising]);
    expect(next.warmth).toBe(1);
  });

  it("leaves meters without a current value and values without a definition untouched", () => {
    const next = applyMeterDrift({ mystery: 0.4 }, 60);
    expect(next.mystery).toBe(0.4);
    expect(next.hygiene).toBeUndefined();
  });

  it("does not mutate the input record", () => {
    const meters = { hygiene: 0.9 };
    applyMeterDrift(meters, 60);
    expect(meters.hygiene).toBe(0.9);
  });

  it("drifts toward a non-pole baseline and stops there (no overshoot)", () => {
    const def: MeterDefinition = {
      id: "mood",
      label: "Mood",
      description: "x",
      initial: 0.5,
      perHour: 0,
      baseline: 0.5,
      recoveryPerHour: 0.1,
      thresholds: [],
    };
    // From above the baseline, ten hours of 0.1/h would pass 0.5 — it must stop at 0.5.
    expect(applyMeterDrift({ mood: 0.9 }, 600, [def]).mood).toBe(0.5);
    // From below, likewise rises only to the baseline.
    expect(applyMeterDrift({ mood: 0.1 }, 600, [def]).mood).toBe(0.5);
    // A partial step approaches but doesn't reach it.
    expect(applyMeterDrift({ mood: 0.9 }, 60, [def]).mood).toBeCloseTo(0.8, 10);
  });

  it("the mood meter rests at an even keel (baseline 0.5)", () => {
    expect(meterBaselineOf(meterById("mood")!)).toBe(0.5);
    expect(initialMeters().mood).toBe(0.5);
  });
});

describe("deriveMoodDescriptor", () => {
  it("blends valence with stress/energy into a phrase", () => {
    expect(deriveMoodDescriptor({ mood: 0.2, stress: 0.7 })).toBe("low and on edge");
    expect(deriveMoodDescriptor({ mood: 0.2, energy: 0.2 })).toBe("low and listless");
    expect(deriveMoodDescriptor({ mood: 0.2 })).toBe("subdued and withdrawn");
    expect(deriveMoodDescriptor({ mood: 0.8, energy: 0.8 })).toBe("bright and playful");
    expect(deriveMoodDescriptor({ mood: 0.8, energy: 0.3 })).toBe("warm and content");
    expect(deriveMoodDescriptor({ mood: 0.5, stress: 0.7 })).toBe("outwardly even but tense");
  });

  it("says nothing for an even, unstressed keel or when mood is absent", () => {
    expect(deriveMoodDescriptor({ mood: 0.5, stress: 0.1 })).toBe("");
    expect(deriveMoodDescriptor({ stress: 0.9 })).toBe(""); // no mood meter ⇒ no descriptor
  });
});

describe("crossedThresholdHints", () => {
  const hygieneHints = meterById("hygiene")?.thresholds.map((t) => t.promptHint) ?? [];
  const stressHints = meterById("stress")?.thresholds.map((t) => t.promptHint) ?? [];

  it("emits hints for every below-threshold the value has crossed", () => {
    const hints = crossedThresholdHints({ hygiene: 0.2 });
    expect(hints).toEqual(hygieneHints); // crossed both 0.55 and 0.3
  });

  it("emits only the thresholds actually crossed", () => {
    const hints = crossedThresholdHints({ hygiene: 0.5 });
    expect(hints).toEqual([hygieneHints[0]]);
  });

  it("emits above-threshold hints", () => {
    const hints = crossedThresholdHints({ stress: 0.9 });
    expect(hints).toEqual(stressHints);
  });

  it("a value exactly at the threshold has not crossed it", () => {
    expect(crossedThresholdHints({ hygiene: 0.55 })).toEqual([]);
    expect(crossedThresholdHints({ stress: 0.6 })).toEqual([]);
  });

  it("emits nothing for healthy values or unknown meter ids", () => {
    expect(crossedThresholdHints({ hygiene: 0.9, stress: 0.1, mystery: 0 })).toEqual([]);
  });
});
