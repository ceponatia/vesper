import { describe, expect, it } from "vitest";
import { attributeRegistry } from "../attributes";
import { overlaySourceMayChange } from "../attributes/value";
import { catalogConditionForLabel, CONDITION_CATALOG } from "./catalog";

describe("condition catalog", () => {
  it("looks up by normalized (case/space-insensitive) label", () => {
    expect(catalogConditionForLabel("  Disheveled ")).toBe(CONDITION_CATALOG.disheveled);
    expect(catalogConditionForLabel("UNWASHED")).toBe(CONDITION_CATALOG.unwashed);
    expect(catalogConditionForLabel("nope")).toBeUndefined();
  });

  it("every catalog effect targets a known, mutable attribute (so the overlay guard never silently drops it)", () => {
    for (const entry of Object.values(CONDITION_CATALOG)) {
      for (const effect of entry.attributeEffects) {
        const def = attributeRegistry.byId(effect.attributeId);
        expect(def, `unknown attribute ${effect.attributeId}`).toBeDefined();
        if (!def) continue;
        expect(overlaySourceMayChange(def.mutability, "condition"), `inherent ${effect.attributeId}`).toBe(true);
      }
    }
  });
});
