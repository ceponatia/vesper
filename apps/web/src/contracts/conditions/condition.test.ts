import { describe, expect, it } from "vitest";
import { activeConditionSchema, isConditionExpired, type ActiveCondition } from "./condition";

function condition(partial: Partial<ActiveCondition> = {}): ActiveCondition {
  return activeConditionSchema.parse({
    id: "cond_soaked",
    label: "soaked",
    startedAtMinutes: 100,
    ...partial,
  });
}

describe("isConditionExpired", () => {
  it("never expires without a duration", () => {
    expect(isConditionExpired(condition(), 100)).toBe(false);
    expect(isConditionExpired(condition(), 1_000_000)).toBe(false);
  });

  it("is active strictly before start + duration", () => {
    const c = condition({ durationMinutes: 30 });
    expect(isConditionExpired(c, 100)).toBe(false);
    expect(isConditionExpired(c, 129)).toBe(false);
  });

  it("expires exactly at start + duration and after", () => {
    const c = condition({ durationMinutes: 30 });
    expect(isConditionExpired(c, 130)).toBe(true);
    expect(isConditionExpired(c, 131)).toBe(true);
  });

  it("schema defaults attributeEffects to an empty list", () => {
    expect(condition().attributeEffects).toEqual([]);
  });
});
