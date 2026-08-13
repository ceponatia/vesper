import { beforeEach, describe, expect, it } from "vitest";
import {
  laneHealth,
  laneRetryAfterSeconds,
  recordProviderOutcome,
  resetProviderHealth,
} from "./backpressure";

const T0 = 1_000_000;

function failTimes(lane: "text" | "image" | "embedding", times: number, now = T0): void {
  for (let i = 0; i < times; i++) recordProviderOutcome(lane, false, now);
}

describe("provider lane health", () => {
  beforeEach(() => resetProviderHealth());

  it("starts healthy and stays healthy through transient blips", () => {
    expect(laneHealth("image", T0)).toBe("healthy");
    failTimes("image", 4);
    expect(laneHealth("image", T0)).toBe("healthy");
  });

  it("trips to unhealthy on sustained consecutive failures", () => {
    failTimes("image", 5);
    expect(laneHealth("image", T0)).toBe("unhealthy");
  });

  it("a success resets the streak, so failures must be consecutive to trip", () => {
    failTimes("image", 4);
    recordProviderOutcome("image", true, T0);
    failTimes("image", 4);
    expect(laneHealth("image", T0)).toBe("healthy");
  });

  it("half-opens after the cooldown so recovery can be probed", () => {
    failTimes("image", 5);
    expect(laneHealth("image", T0 + 29_000)).toBe("unhealthy");
    expect(laneHealth("image", T0 + 30_000)).toBe("degraded");
  });

  it("closes on any success, however long it was tripped", () => {
    failTimes("image", 5);
    recordProviderOutcome("image", true, T0 + 45_000);
    expect(laneHealth("image", T0 + 45_000)).toBe("healthy");
  });

  it("lanes are independent — one dead provider does not shed the others", () => {
    failTimes("image", 5);
    expect(laneHealth("image", T0)).toBe("unhealthy");
    expect(laneHealth("text", T0)).toBe("healthy");
    expect(laneHealth("embedding", T0)).toBe("healthy");
  });

  describe("retry advice", () => {
    it("counts down the remaining cooldown", () => {
      failTimes("image", 5);
      expect(laneRetryAfterSeconds("image", T0)).toBe(30);
      expect(laneRetryAfterSeconds("image", T0 + 20_000)).toBe(10);
    });

    it("never advertises zero while still tripped, and nothing when healthy", () => {
      expect(laneRetryAfterSeconds("image", T0)).toBe(0);
      failTimes("image", 5);
      expect(laneRetryAfterSeconds("image", T0 + 29_999)).toBe(1);
    });
  });
});
