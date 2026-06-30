import { describe, expect, it } from "vitest";
import type { ActiveCondition } from "./condition";
import { conditionAttributeOverlays } from "./overlays";

const cond = (over: Partial<ActiveCondition> = {}): ActiveCondition => ({
  id: "c1",
  label: "test",
  startedAtMinutes: 0,
  attributeEffects: [],
  ...over,
});

describe("conditionAttributeOverlays", () => {
  it("maps a mutable attribute effect to a condition-sourced overlay (id, sourceId)", () => {
    const out = conditionAttributeOverlays([
      cond({ id: "abc", attributeEffects: [{ attributeId: "presentation.grooming", value: "unkempt" }] }),
    ]);
    expect(out).toEqual([{ id: "presentation.grooming", value: "unkempt", source: "condition", sourceId: "abc" }]);
  });

  it("drops an effect targeting an inherent attribute (the guard against rewriting eye colour/species)", () => {
    const out = conditionAttributeOverlays([cond({ attributeEffects: [{ attributeId: "skin.tone", value: "olive" }] })]);
    expect(out).toEqual([]);
  });

  it("drops an unknown attribute id", () => {
    const out = conditionAttributeOverlays([cond({ attributeEffects: [{ attributeId: "skin.nonexistent", value: "x" }] })]);
    expect(out).toEqual([]);
  });

  it("returns [] when conditions have no effects", () => {
    expect(conditionAttributeOverlays([cond()])).toEqual([]);
    expect(conditionAttributeOverlays([])).toEqual([]);
  });
});
