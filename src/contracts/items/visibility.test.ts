import { describe, expect, it } from "vitest";
import { resolveWardrobeVisibility, type WornItemInput } from "./visibility";

function worn(partial: Partial<WornItemInput> & Pick<WornItemInput, "instanceId" | "coverage" | "layer">): WornItemInput {
  return { name: partial.instanceId, opacity: "opaque", ...partial };
}

function viewOf(views: ReturnType<typeof resolveWardrobeVisibility>, instanceId: string) {
  const view = views.find((v) => v.instanceId === instanceId);
  expect(view, instanceId).toBeDefined();
  return view!;
}

describe("resolveWardrobeVisibility", () => {
  it("the highest-layer item at a location is visible there", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "shirt", coverage: ["chest"], layer: 1 }),
      worn({ instanceId: "jacket", coverage: ["chest"], layer: 3 }),
    ]);
    expect(viewOf(views, "jacket").visibility).toBe("visible");
    expect(viewOf(views, "jacket").visibleAt).toContain("chest");
    expect(viewOf(views, "shirt").visibility).toBe("hidden");
    expect(viewOf(views, "shirt").visibleAt).toEqual([]);
  });

  it("an item under only sheer layers is hinted", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "bra", coverage: ["chest"], layer: 0 }),
      worn({ instanceId: "blouse", coverage: ["chest"], layer: 1, opacity: "sheer" }),
    ]);
    expect(viewOf(views, "blouse").visibility).toBe("visible");
    expect(viewOf(views, "bra").visibility).toBe("hinted");
  });

  it("one opaque layer anywhere above makes the buried item hidden", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "bra", coverage: ["chest"], layer: 0 }),
      worn({ instanceId: "blouse", coverage: ["chest"], layer: 1, opacity: "sheer" }),
      worn({ instanceId: "coat", coverage: ["chest"], layer: 3 }),
    ]);
    expect(viewOf(views, "bra").visibility).toBe("hidden");
    expect(viewOf(views, "blouse").visibility).toBe("hidden");
  });

  it("parent coverage expands to descendants: torso covers chest", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "bralette", coverage: ["chest"], layer: 0 }),
      worn({ instanceId: "dress", coverage: ["torso"], layer: 2 }),
    ]);
    expect(viewOf(views, "bralette").visibility).toBe("hidden");
    expect(viewOf(views, "dress").visibleAt).toEqual(expect.arrayContaining(["torso", "chest", "waist", "neck"]));
  });

  it("an item visible at any one location is visible overall", () => {
    // The shirt is buried at the torso but still shows at the arms.
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "shirt", coverage: ["torso", "arms"], layer: 1 }),
      worn({ instanceId: "vest", coverage: ["torso"], layer: 2 }),
    ]);
    const shirt = viewOf(views, "shirt");
    expect(shirt.visibility).toBe("visible");
    expect(shirt.visibleAt).toContain("arms");
    expect(shirt.visibleAt).not.toContain("chest");
  });

  it("hinted at one location beats hidden at another", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "slip", coverage: ["chest", "hips"], layer: 0 }),
      worn({ instanceId: "sheer_top", coverage: ["chest"], layer: 1, opacity: "sheer" }),
      worn({ instanceId: "skirt", coverage: ["hips"], layer: 2 }),
    ]);
    expect(viewOf(views, "slip").visibility).toBe("hinted");
  });

  it("ignores unknown coverage ids", () => {
    const views = resolveWardrobeVisibility([
      worn({ instanceId: "harness", coverage: ["wings", "chest"], layer: 0 }),
      worn({ instanceId: "coat", coverage: ["torso"], layer: 3 }),
    ]);
    // "wings" contributes nothing; the chest coverage is buried under the coat.
    expect(viewOf(views, "harness").visibility).toBe("hidden");
    expect(viewOf(views, "harness").visibleAt).toEqual([]);
  });

  it("an item with no resolvable coverage defaults to visible", () => {
    const views = resolveWardrobeVisibility([worn({ instanceId: "aura", coverage: ["wings"], layer: 1 })]);
    expect(viewOf(views, "aura").visibility).toBe("visible");
    expect(viewOf(views, "aura").visibleAt).toEqual([]);
  });

  it("returns an empty list for an empty wardrobe", () => {
    expect(resolveWardrobeVisibility([])).toEqual([]);
  });
});
