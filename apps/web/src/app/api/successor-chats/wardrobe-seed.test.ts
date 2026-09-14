import { describe, expect, it } from "vitest";
import { garmentBlueprintSchema, isDegradedGarmentBlueprint, parseSuccessorWornSlotKey } from "@/contracts";
import { successorWardrobeSeed } from "./wardrobe-seed";

describe("successorWardrobeSeed", () => {
  it("refuses a failed load instead of minting an empty durable outfit", () => {
    expect(successorWardrobeSeed({ wardrobe: [], failed: true })).toEqual({
      ok: false,
      reason: "load_failed",
      itemIds: [],
    });
  });

  it("refuses unreadable coverage instead of snapshotting covers-nothing garments", () => {
    expect(
      successorWardrobeSeed({
        wardrobe: [{ name: "linen shirt", coverage: [] }],
        coverageUnreliableIds: ["shirt-1"],
      }),
    ).toEqual({ ok: false, reason: "coverage_unreliable", itemIds: ["shirt-1"] });
  });

  it("maps a reliable load into category-keyed slots", () => {
    const seed = successorWardrobeSeed({
      wardrobe: [
        { id: "jacket-1", name: "denim jacket", category: "outerwear", coverage: ["chest", "upper_arms"] },
        { id: "tee-1", name: "white cotton tee", coverage: [] },
      ],
    });
    if (!seed.ok) throw new Error("expected a reliable seed");
    expect(seed.garments.map((garment) => garment.slotKey)).toEqual(["outerwear-0", "garment-1"]);
    expect(parseSuccessorWornSlotKey(seed.garments[0]!.slotKey)).toEqual({
      kind: "category",
      categoryId: "outerwear",
      index: 0,
    });
    // The unregistered-category garment keeps a slot that reads back UNKNOWN
    // rather than one that looks like a registry id.
    expect(parseSuccessorWornSlotKey(seed.garments[1]!.slotKey)).toEqual({ kind: "unknown", raw: "garment-1" });
  });

  it("mints a durable blueprint carrying the definition's own coverage", () => {
    const seed = successorWardrobeSeed({
      wardrobe: [{ id: "jacket-1", name: "denim jacket", category: "outerwear", coverage: ["chest", "upper_arms"] }],
    });
    if (!seed.ok) throw new Error("expected a reliable seed");
    const blueprint = garmentBlueprintSchema.parse(seed.garments[0]!.blueprint);
    expect(isDegradedGarmentBlueprint(blueprint)).toBe(false);
    const covered = new Set(blueprint.nodes.flatMap((node) => node.baselineCoverage));
    expect([...covered].sort()).toEqual(["chest", "upper_arms"]);
    expect(blueprint.nodes.length).toBeGreaterThan(1);
  });

  it("mints for a garment with no category rather than leaving the seed blueprint-less", () => {
    const seed = successorWardrobeSeed({ wardrobe: [{ name: "white cotton tee", coverage: ["chest"] }] });
    if (!seed.ok) throw new Error("expected a reliable seed");
    const blueprint = garmentBlueprintSchema.parse(seed.garments[0]!.blueprint);
    expect(isDegradedGarmentBlueprint(blueprint)).toBe(false);
    expect(blueprint.nodes.flatMap((node) => node.baselineCoverage)).toEqual(["chest"]);
  });
});
