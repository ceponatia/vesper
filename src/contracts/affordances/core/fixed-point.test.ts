import { describe, expect, it } from "vitest";
import {
  addUnits,
  complementUnit,
  divideUnits,
  multiplyUnits,
  toUnitInterval,
  unitIntervalSchema,
  AFFORDANCE_UNIT_ONE,
  AFFORDANCE_UNIT_ZERO,
} from "./fixed-point";

/**
 * The unit algebra's one promise: **no value escapes `[0, ONE]`**, on any path,
 * for any input — including the degenerate ones (zero denominators, negative
 * scratch values, a `NaN` leaking in from a bad upstream read).
 */

/** A spread of representative units, including both saturated ends. */
const GRID = [0, 1, 2_500, 3_333, 5_000, 7_777, 9_999, AFFORDANCE_UNIT_ONE].map(toUnitInterval);

const inRange = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= AFFORDANCE_UNIT_ONE;

describe("toUnitInterval", () => {
  it("clamps both ends and floors fractions", () => {
    expect(toUnitInterval(-1)).toBe(0);
    expect(toUnitInterval(-99_999)).toBe(0);
    expect(toUnitInterval(AFFORDANCE_UNIT_ONE + 1)).toBe(AFFORDANCE_UNIT_ONE);
    expect(toUnitInterval(1_234.9)).toBe(1_234);
  });

  it("degrades a non-finite value to zero rather than propagating NaN", () => {
    // Zero, not saturation: an infinity is a bug upstream, and the conservative
    // reading of a broken number is "no effect", never "full effect".
    expect(toUnitInterval(Number.NaN)).toBe(0);
    expect(toUnitInterval(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toUnitInterval(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("brands the value: the schema accepts the range and refuses everything else", () => {
    expect(unitIntervalSchema.safeParse(0).success).toBe(true);
    expect(unitIntervalSchema.safeParse(AFFORDANCE_UNIT_ONE).success).toBe(true);
    expect(unitIntervalSchema.safeParse(-1).success).toBe(false);
    expect(unitIntervalSchema.safeParse(AFFORDANCE_UNIT_ONE + 1).success).toBe(false);
    expect(unitIntervalSchema.safeParse(0.5).success).toBe(false);
  });
});

describe("complementUnit", () => {
  it("is an involution that always sums to one", () => {
    expect(complementUnit(AFFORDANCE_UNIT_ZERO)).toBe(AFFORDANCE_UNIT_ONE);
    expect(complementUnit(AFFORDANCE_UNIT_ONE)).toBe(AFFORDANCE_UNIT_ZERO);
    for (const value of GRID) {
      expect(complementUnit(value) + value).toBe(AFFORDANCE_UNIT_ONE);
      expect(complementUnit(complementUnit(value))).toBe(value);
      expect(inRange(complementUnit(value))).toBe(true);
    }
  });
});

describe("multiplyUnits", () => {
  it("only ever damps: a product never exceeds its smallest factor", () => {
    for (const left of GRID) {
      for (const right of GRID) {
        const product = multiplyUnits(left, right);
        expect(inRange(product)).toBe(true);
        expect(product).toBeLessThanOrEqual(Math.min(left, right));
      }
    }
  });

  it("saturation is the identity and zero annihilates", () => {
    for (const value of GRID) {
      expect(multiplyUnits(value, AFFORDANCE_UNIT_ONE)).toBe(value);
      expect(multiplyUnits(value, AFFORDANCE_UNIT_ZERO)).toBe(0);
    }
  });

  it("is monotone in each factor — the invariant the domain laws rest on", () => {
    // "greater density never lowers effective load" is only provable downstream
    // if the shared multiply itself never inverts.
    for (const other of GRID) {
      let previous = -1;
      for (const value of GRID) {
        const product = multiplyUnits(value, other);
        expect(product).toBeGreaterThanOrEqual(previous);
        previous = product;
      }
    }
  });

  it("takes a third term without leaving the range", () => {
    for (const value of GRID) {
      const triple = multiplyUnits(value, GRID[3]!, GRID[5]!);
      expect(inRange(triple)).toBe(true);
      expect(triple).toBeLessThanOrEqual(value);
    }
    expect(multiplyUnits(AFFORDANCE_UNIT_ONE, AFFORDANCE_UNIT_ONE, AFFORDANCE_UNIT_ONE)).toBe(AFFORDANCE_UNIT_ONE);
  });
});

describe("divideUnits", () => {
  it("divides, clamping at saturation", () => {
    expect(divideUnits({ numerator: toUnitInterval(2_500), denominator: toUnitInterval(5_000), denominatorFloor: 1 })).toBe(5_000);
    expect(divideUnits({ numerator: toUnitInterval(5_000), denominator: toUnitInterval(2_500), denominatorFloor: 1 })).toBe(
      AFFORDANCE_UNIT_ONE,
    );
  });

  it("a zero denominator falls back to the declared floor instead of exploding", () => {
    const quotient = divideUnits({
      numerator: toUnitInterval(100),
      denominator: AFFORDANCE_UNIT_ZERO,
      denominatorFloor: 1_000,
    });
    expect(quotient).toBe(1_000);
    expect(inRange(quotient)).toBe(true);
  });

  it("never escapes the range across the grid", () => {
    for (const numerator of GRID) {
      for (const denominator of GRID) {
        expect(inRange(divideUnits({ numerator, denominator, denominatorFloor: 500 }))).toBe(true);
      }
    }
  });

  it("refuses a non-positive or fractional floor — a definition bug, not runtime data", () => {
    const numerator = toUnitInterval(100);
    const denominator = toUnitInterval(100);
    expect(() => divideUnits({ numerator, denominator, denominatorFloor: 0 })).toThrow(RangeError);
    expect(() => divideUnits({ numerator, denominator, denominatorFloor: -5 })).toThrow(RangeError);
    expect(() => divideUnits({ numerator, denominator, denominatorFloor: 1.5 })).toThrow(RangeError);
  });
});

describe("addUnits", () => {
  it("clamps at both ends", () => {
    expect(addUnits(toUnitInterval(9_000), 5_000)).toBe(AFFORDANCE_UNIT_ONE);
    expect(addUnits(toUnitInterval(1_000), -5_000)).toBe(0);
    for (const value of GRID) {
      expect(inRange(addUnits(value, 3_000))).toBe(true);
      expect(inRange(addUnits(value, -3_000))).toBe(true);
    }
  });
});
