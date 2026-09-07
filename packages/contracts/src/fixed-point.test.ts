import { describe, expect, it } from "vitest";
import {
  addClamped,
  clampFixedPoint,
  exp2NegativeFixedPoint,
  linearDriftStep,
  proportionalDecayStep,
  scaleFixedPoint,
  EXP2_SCALE,
  FIXED_POINT_ONE,
} from "./fixed-point";

/**
 * The shared kernel, extracted under the owner's ruling that the chat lane reuse
 * the successor's existing fixed-point integration kernel — generalizing its
 * pure numerics where needed — rather than grow its own floating-point turn math.
 *
 * The load-bearing claim is that the generalization changed NOTHING. Two proofs:
 * `packages/simulation-core/src/lib/bodies.test.ts` and the neighboring
 * `material-condition.test.ts` still pass untouched (the successor's own suites),
 * and the sweep below compares the new
 * primitives against a verbatim copy of the pre-extraction numerics.
 */

// ---------------------------------------------------------------------------
// The PRE-EXTRACTION body `driftStep`, copied verbatim before the shared
// fixed-point primitive existed. Current body integration lives in
// `simulation-core/src/lib/bodies/integration.ts`. This oracle stays
// deliberately duplicated: importing the code under test would prove nothing.
// ---------------------------------------------------------------------------

const METER_ONE = 10_000;

function legacyClamp(value: number): number {
  return Math.max(0, Math.min(METER_ONE, value));
}

function legacyDriftStep(
  valueFixedPoint: number,
  drift:
    | { kind: "linear"; targetFixedPoint: number; ratePerHourFixedPoint: number }
    | { kind: "proportional_decay"; targetFixedPoint: number; halfLifeSeconds: number },
  elapsedSeconds: number,
): number {
  if (elapsedSeconds <= 0) return valueFixedPoint;
  if (drift.kind === "linear") {
    const magnitude = Math.floor((Math.abs(drift.ratePerHourFixedPoint) * elapsedSeconds) / 3_600);
    if (drift.ratePerHourFixedPoint >= 0) {
      if (valueFixedPoint > drift.targetFixedPoint) {
        return Math.max(drift.targetFixedPoint, valueFixedPoint - magnitude);
      }
      return Math.min(drift.targetFixedPoint, valueFixedPoint + magnitude);
    }
    if (valueFixedPoint >= drift.targetFixedPoint) return legacyClamp(valueFixedPoint + magnitude);
    return legacyClamp(valueFixedPoint - magnitude);
  }
  const scaled = exp2NegativeFixedPoint(elapsedSeconds, drift.halfLifeSeconds);
  const distance = Math.abs(valueFixedPoint - drift.targetFixedPoint);
  const remaining = Math.floor((distance * scaled) / EXP2_SCALE);
  return valueFixedPoint >= drift.targetFixedPoint
    ? drift.targetFixedPoint + remaining
    : drift.targetFixedPoint - remaining;
}

/** A deterministic spread of values/targets/rates/spans — no randomness in a determinism test. */
const VALUES = [0, 1, 137, 2_500, 4_999, 5_000, 7_500, 9_999, 10_000] as const;
const TARGETS = [0, 2_500, 5_000, 10_000] as const;
const RATES = [-9_000, -1_200, 0, 1, 600, 3_333, 10_000] as const;
const SPANS = [0, 1, 60, 3_600, 86_400, 2_592_000] as const;
const HALF_LIVES = [1, 900, 3_600, 39_925, 1_000_000_000] as const;

describe("kernel generalization equivalence", () => {
  it("linearDriftStep reproduces the pre-extraction linear branch exactly", () => {
    let compared = 0;
    for (const value of VALUES) {
      for (const target of TARGETS) {
        for (const ratePerHourFixedPoint of RATES) {
          for (const elapsedSeconds of SPANS) {
            expect(
              linearDriftStep({ value, target, ratePerHourFixedPoint, elapsedSeconds, one: METER_ONE }),
            ).toBe(legacyDriftStep(value, { kind: "linear", targetFixedPoint: target, ratePerHourFixedPoint }, elapsedSeconds));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(VALUES.length * TARGETS.length * RATES.length * SPANS.length);
  });

  it("proportionalDecayStep reproduces the pre-extraction decay branch exactly", () => {
    for (const value of VALUES) {
      for (const target of TARGETS) {
        for (const halfLifeSeconds of HALF_LIVES) {
          for (const elapsed of SPANS) {
            expect(proportionalDecayStep({ value, target, halfLife: halfLifeSeconds, elapsed })).toBe(
              legacyDriftStep(value, { kind: "proportional_decay", targetFixedPoint: target, halfLifeSeconds }, elapsed),
            );
          }
        }
      }
    }
  });

  it("keeps the exp2 contract the successor solver relies on", () => {
    expect(exp2NegativeFixedPoint(0, 3_600)).toBe(EXP2_SCALE);
    expect(exp2NegativeFixedPoint(3_600, 3_600)).toBe(EXP2_SCALE / 2);
    expect(exp2NegativeFixedPoint(7_200, 3_600)).toBe(EXP2_SCALE / 4);
    expect(exp2NegativeFixedPoint(3_600 * 60, 3_600)).toBe(0);
    expect(() => exp2NegativeFixedPoint(-1, 10)).toThrow(RangeError);
    expect(() => exp2NegativeFixedPoint(10, 0)).toThrow(RangeError);
  });
});

describe("clamped source application", () => {
  it("clamps into [0, one] in both directions", () => {
    expect(clampFixedPoint(-5)).toBe(0);
    expect(clampFixedPoint(20_000)).toBe(FIXED_POINT_ONE);
    expect(addClamped(9_000, 5_000)).toBe(FIXED_POINT_ONE);
    expect(addClamped(1_000, -5_000)).toBe(0);
    expect(addClamped(1_000, 500)).toBe(1_500);
  });

  it("scales by a coefficient, flooring so a coefficient only ever damps", () => {
    expect(scaleFixedPoint(7_500, FIXED_POINT_ONE)).toBe(7_500);
    expect(scaleFixedPoint(7_500, 0)).toBe(0);
    expect(scaleFixedPoint(7_500, 1_200)).toBe(900);
    // 7_500 × 0.3333 = 2_499.75 — floors, never rounds up past the source.
    expect(scaleFixedPoint(7_500, 3_333)).toBe(2_499);
  });
});

describe("degraded inputs never throw (docs/resilience.md)", () => {
  it("treats a non-positive half-life as no drift rather than a RangeError", () => {
    expect(proportionalDecayStep({ value: 5_000, target: 0, halfLife: 0, elapsed: 600 })).toBe(5_000);
    expect(proportionalDecayStep({ value: 5_000, target: 0, halfLife: -1, elapsed: 600 })).toBe(5_000);
  });

  it("treats a non-positive span as the identity", () => {
    expect(proportionalDecayStep({ value: 5_000, target: 0, halfLife: 100, elapsed: 0 })).toBe(5_000);
    expect(linearDriftStep({ value: 5_000, target: 0, ratePerHourFixedPoint: 600, elapsedSeconds: -1 })).toBe(5_000);
  });
});
