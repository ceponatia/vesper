import { describe, expect, it } from "vitest";
import { analyzeShadowParity, type ShadowDivergenceRowInput } from "./shadow-parity";

// R4 slice 2: the scale-aware parity analysis — deltas for clocks, normalized
// meters, recorder-judged presence/prose, ruled rows excluded from findings.

let counter = 0;
function row(overrides: Partial<ShadowDivergenceRowInput> & { domain: string }): ShadowDivergenceRowInput {
  counter += 1;
  return {
    id: `row-${counter}`,
    messageId: `msg-${counter}`,
    legacy: {},
    successor: {},
    detail: "",
    verdict: "open",
    createdAt: new Date(1_700_000_000_000 + counter * 60_000),
    ...overrides,
  };
}

describe("analyzeShadowParity clock deltas", () => {
  it("compares successive deltas, not absolutes, and flags drift beyond tolerance", () => {
    const report = analyzeShadowParity([
      row({ domain: "clock", legacy: { clockMinutes: 100 }, successor: { storySecond: 720_000 } }),
      // Both lanes moved 180 minutes — a matched skip, no finding.
      row({ domain: "clock", legacy: { clockMinutes: 280 }, successor: { storySecond: 720_000 + 180 * 60 } }),
      // Legacy moved 60, successor only 1 — drift.
      row({ domain: "clock", legacy: { clockMinutes: 340 }, successor: { storySecond: 720_000 + 181 * 60 } }),
    ]);
    expect(report.clock.steps).toBe(2);
    expect(report.clock.driftingSteps).toHaveLength(1);
    expect(report.clock.driftingSteps[0]).toMatchObject({ legacyDeltaMinutes: 60, successorDeltaMinutes: 1 });
    expect(report.findings.some((finding) => finding.includes("clock drift"))).toBe(true);
  });

  it("names the latest successor clock legibly", () => {
    const report = analyzeShadowParity([
      row({ domain: "clock", legacy: { clockMinutes: 0 }, successor: { storySecond: 2 * 86_400 + 600 * 60 } }),
    ]);
    expect(report.clock.latestSuccessorClock).toBe("Day 3 · 10:00am");
  });
});

describe("analyzeShadowParity meters", () => {
  it("normalizes fixed-point to the chat scale and flags beyond-tolerance keys", () => {
    const report = analyzeShadowParity([
      row({
        domain: "meters",
        legacy: { meters: { energy: 0.8, arousal: 0.1, chatOnly: 0.5 } },
        // energy 0.78 (within 0.15), arousal 0.6 (beyond), mirrorOnly unshared.
        successor: { metersFixedPoint: { energy: 7_800, arousal: 6_000, mirrorOnly: 100 } },
      }),
    ]);
    expect(report.meters.sharedKeys).toEqual(["arousal", "energy"]);
    expect(report.meters.beyondTolerance).toHaveLength(1);
    expect(report.meters.beyondTolerance[0]).toMatchObject({ meterKey: "arousal" });
    expect(report.meters.missingOnMirror).toEqual(["chatOnly"]);
    expect(report.meters.missingOnChat).toEqual(["mirrorOnly"]);
  });
});

describe("analyzeShadowParity verdicts and degradation", () => {
  it("excludes ruled rows from findings and skips malformed payloads without throwing", () => {
    const report = analyzeShadowParity([
      row({ domain: "presence", detail: "chat says present but no open scene", verdict: "intentional" }),
      row({ domain: "presence", detail: "chat says present but no open scene" }),
      row({ domain: "prose", successor: { status: "refused" }, detail: "the mirror scene could not open: busy" }),
      row({ domain: "prose", successor: { status: "rendered" } }),
      row({ domain: "clock", legacy: "garbage", successor: { storySecond: 1 } }),
    ]);
    // Only the OPEN presence mismatch and the refused prose land as findings.
    expect(report.presence.mismatches).toHaveLength(1);
    expect(report.prose).toMatchObject({ pairs: 2, rendered: 1 });
    expect(report.prose.failures).toHaveLength(1);
    expect(report.totals.skippedMalformed).toBe(1);
    expect(report.totals.byVerdict).toMatchObject({ open: 4, intentional: 1 });
    expect(report.findings).toHaveLength(2);
  });
});
