import { describe, expect, it } from "vitest";
import { settledReferenceViewSelectionKeys } from "./reference-view-selection";

describe("reference-view regeneration selection", () => {
  it("clears queued and already-busy targets while preserving refused work", () => {
    const settled = settledReferenceViewSelectionKeys([
      { angle: "front_full", wardrobe: "clothed", state: "queued" },
      { angle: "back_full", wardrobe: "clothed", state: "busy" },
      { angle: "side_left", wardrobe: "clothed", state: "budget" },
      { angle: "side_right", wardrobe: "clothed", state: "storage" },
    ]);
    expect([...settled]).toEqual(["front_full clothed", "back_full clothed"]);
  });
});
