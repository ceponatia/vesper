import { describe, expect, it } from "vitest";
import { effectiveLadderCostPerThousand, fallbackInvocationRate } from "./composer-model-economics";

describe("fallbackInvocationRate", () => {
  it("uses the production degraded count rather than a quality score", () => {
    expect(fallbackInvocationRate(2, 20)).toBe(0.1);
    expect(fallbackInvocationRate(0, 20)).toBe(0);
  });

  it("returns null when no calls were measured", () => {
    expect(fallbackInvocationRate(0, 0)).toBeNull();
  });

  it("rejects impossible counts", () => {
    expect(() => fallbackInvocationRate(3, 2)).toThrow("invalid fallback counts");
    expect(() => fallbackInvocationRate(-1, 2)).toThrow("invalid fallback counts");
  });
});

describe("effectiveLadderCostPerThousand", () => {
  it("adds fallback spend only at the measured invocation rate", () => {
    expect(effectiveLadderCostPerThousand(0.1, 0.1, 1)).toBeCloseTo(0.2);
  });

  it("equals primary cost when the fallback never fires", () => {
    expect(effectiveLadderCostPerThousand(0.1, 0, null)).toBe(0.1);
  });

  it("stays unknown when a used fallback has no measured cost", () => {
    expect(effectiveLadderCostPerThousand(0.1, 0.1, null)).toBeNull();
  });
});
