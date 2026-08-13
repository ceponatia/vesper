import { describe, expect, it } from "vitest";
import { expectRefsResolve } from "@/test/registry-invariants";
import { attributeRegistry } from "../attributes";
import { overlaySourceMayChange } from "../attributes/value";
import { catalogConditionForLabel, CONDITION_CATALOG } from "./catalog";

const catalogEntries = Object.values(CONDITION_CATALOG);

describe("condition catalog", () => {
  it("looks up by normalized (case/space-insensitive) label", () => {
    expect(catalogConditionForLabel("  Disheveled ")).toBe(CONDITION_CATALOG.disheveled);
    expect(catalogConditionForLabel("UNWASHED")).toBe(CONDITION_CATALOG.unwashed);
    expect(catalogConditionForLabel("nope")).toBeUndefined();
  });

  it("every catalog effect targets a known attribute", () => {
    expectRefsResolve(
      catalogEntries,
      (entry) => entry.attributeEffects.map((effect) => effect.attributeId),
      (attributeId) => attributeRegistry.byId(attributeId),
      (_entry, attributeId) => `unknown attribute ${attributeId}`,
    );
  });

  it("…and every one of them is MUTABLE, so the overlay guard never silently drops it", () => {
    for (const entry of catalogEntries) {
      for (const effect of entry.attributeEffects) {
        const def = attributeRegistry.byId(effect.attributeId);
        if (!def) continue; // the reference test above owns this failure
        expect(overlaySourceMayChange(def.mutability, "condition"), `inherent ${effect.attributeId}`).toBe(true);
      }
    }
  });
});
