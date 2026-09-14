import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../body/locations";
import { clothingCategories, clothingCategoryById } from "./clothing-categories";
import { garmentBlueprintSchema, garmentRootNode, isDegradedGarmentBlueprint } from "./garment-blueprint";
import {
  parseSuccessorWornSlotKey,
  successorGarmentBlueprint,
  successorWornSlotCoverage,
  successorWornSlotKey,
  SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD,
} from "./successor-worn-slot";

/** Every coverage-relevant location, derived — never a copied list. */
const coverageLocations = bodyLocationRegistry.all.filter((location) => location.coverageRelevant !== false);

describe("successorWornSlotKey", () => {
  it("round-trips every registered clothing category", () => {
    for (const [index, category] of clothingCategories.entries()) {
      const key = successorWornSlotKey(category.id, index);
      expect(key).toBe(`${category.id}-${index}`);
      expect(parseSuccessorWornSlotKey(key)).toEqual({ kind: "category", categoryId: category.id, index });
    }
  });

  it("writes the unknown head rather than an unregistered category id", () => {
    expect(successorWornSlotKey("not-a-category", 2)).toBe(`${SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD}-2`);
    expect(successorWornSlotKey(undefined, 0)).toBe(`${SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD}-0`);
    // …and that head is deliberately not a registry id, so it reads back unknown.
    expect(clothingCategoryById(SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD)).toBeUndefined();
    expect(bodyLocationRegistry.byId(SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD)).toBeUndefined();
  });

  it("normalizes a negative or fractional index instead of writing a broken key", () => {
    expect(successorWornSlotKey("top", -3)).toBe("top-0");
    expect(successorWornSlotKey("top", 1.9)).toBe("top-1");
  });
});

describe("parseSuccessorWornSlotKey", () => {
  it("reads every coverage-relevant body location as the earlier seed vocabulary", () => {
    for (const location of coverageLocations) {
      expect(parseSuccessorWornSlotKey(`${location.id}-0`)).toEqual({
        kind: "location",
        locationId: location.id,
        index: 0,
      });
    }
  });

  it("refuses anything the registries do not know, keeping the raw key for the diagnostic", () => {
    for (const raw of [
      `${SUCCESSOR_WORN_SLOT_UNKNOWN_HEAD}-1`, // the legacy fallback head
      "torso", // no index
      "top-", // empty index
      "-0", // no head
      "top-x", // non-numeric index
      "shirt-0", // a garment noun, not a registry id
      "",
    ]) {
      expect(parseSuccessorWornSlotKey(raw)).toEqual({ kind: "unknown", raw: raw.trim() });
    }
  });

  it("keeps the two vocabularies disjoint, so precedence never silently reclassifies a key", () => {
    const categoryIds = new Set(clothingCategories.map((category) => category.id));
    const collisions = bodyLocationRegistry.all.filter((location) => categoryIds.has(location.id));
    expect(collisions).toEqual([]);
  });
});

describe("successorWornSlotCoverage", () => {
  it("expands a category slot to the template's descendants, in registry order", () => {
    const covers = successorWornSlotCoverage({ kind: "category", categoryId: "pants", index: 0 });
    const template = clothingCategoryById("pants")?.coverage ?? [];
    expect(template.length).toBeGreaterThan(0);
    for (const id of template) expect(covers).toContain(id);
    const order = covers.map((id) => bodyLocationRegistry.all.findIndex((location) => location.id === id));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("expands a location slot to that location and everything under it", () => {
    const covers = successorWornSlotCoverage({ kind: "location", locationId: "torso", index: 0 });
    expect(covers).toContain("torso");
    for (const id of bodyLocationRegistry.expand("torso")) {
      if (bodyLocationRegistry.byId(id)?.coverageRelevant === false) continue;
      expect(covers).toContain(id);
    }
  });

  it("says nothing for an unknown slot — which is not the same as covering nothing", () => {
    expect(successorWornSlotCoverage({ kind: "unknown", raw: "garment-0" })).toEqual([]);
    // `jewelry` is a REGISTERED category that legitimately covers nothing; the
    // two cases are only distinguishable through the read's reliability flag.
    expect(successorWornSlotCoverage({ kind: "category", categoryId: "jewelry", index: 0 })).toEqual([]);
  });
});

/** Re-parse the opaque mint the way the read adapter does, so the test reads the same graph. */
function parsed(blueprint: Record<string, unknown>): ReturnType<typeof garmentBlueprintSchema.parse> {
  return garmentBlueprintSchema.parse(blueprint);
}

describe("successorGarmentBlueprint", () => {
  it("mints a usable graph whose coverage is exactly the definition's, not the category template's", () => {
    const blueprint = successorGarmentBlueprint({
      id: "def-1",
      name: "linen bandeau",
      category: "top",
      coverage: ["chest"],
    });
    const covered = new Set(parsed(blueprint).nodes.flatMap((node) => node.baselineCoverage));
    expect([...covered]).toEqual(["chest"]);
    // A `top` template claims shoulders/back/waist/upper_arms too — rescoping is
    // what stops a bandeau instantiating as a full shirt.
    expect(clothingCategoryById("top")?.coverage.length).toBeGreaterThan(covered.size);
  });

  it("still mints a real graph for a definition with no registered category", () => {
    const blueprint = parsed(successorGarmentBlueprint({ name: "a borrowed wrap", coverage: ["shoulders"] }));
    expect(isDegradedGarmentBlueprint(blueprint)).toBe(false);
    expect(garmentRootNode(blueprint)).toBeDefined();
    expect(blueprint.nodes.flatMap((node) => node.baselineCoverage)).toContain("shoulders");
  });

  it("infers material from the definition's free text, so the mint matches the chat lane's", () => {
    const denim = successorGarmentBlueprint({ name: "jacket", description: "worn denim", coverage: ["chest"] });
    const unknown = successorGarmentBlueprint({ name: "jacket", coverage: ["chest"] });
    const profileOf = (blueprint: Record<string, unknown>): string =>
      parsed(blueprint).nodes[0]?.materialProfileId ?? "";
    expect(profileOf(denim)).toBe("denim");
    expect(profileOf(unknown)).toBe("unknown");
  });
});
