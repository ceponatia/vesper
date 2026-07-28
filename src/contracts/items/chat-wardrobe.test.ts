import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { DiagnosticCollector } from "../diagnostics";
import { FULLY_COVERED, intimateRegionsBare, type RegionExposure } from "./visibility";
import { applyWornGarmentChanges, matchGarment, type GarmentDescriptor } from "./chat-wardrobe";

const worn: GarmentDescriptor[] = [
  { id: "jacket", name: "denim jacket" },
  { id: "tee", name: "white cotton tee" },
  { id: "jeans", name: "blue jeans" },
];
const pool: GarmentDescriptor[] = [
  { id: "cardigan", name: "grey wool cardigan" },
  { id: "boots", name: "leather boots", description: "tall lace-up boots" },
];

describe("matchGarment", () => {
  it("matches a free-text phrase by token overlap on name/description", () => {
    expect(matchGarment("she slips off her jacket", worn)?.id).toBe("jacket");
    expect(matchGarment("pulls on the wool cardigan", pool)?.id).toBe("cardigan");
    // Description tokens count too.
    expect(matchGarment("laces up her boots", pool)?.id).toBe("boots");
  });

  it("returns undefined when nothing meaningful overlaps (only stopwords / no match)", () => {
    expect(matchGarment("she takes off her", worn)).toBeUndefined(); // all stopwords
    expect(matchGarment("a jeweled tiara", worn)).toBeUndefined();
  });
});

describe("applyWornGarmentChanges", () => {
  it("removes a matched worn garment by id and keeps the rest", () => {
    const sink = new DiagnosticCollector();
    const result = applyWornGarmentChanges({
      wornIds: ["jacket", "tee", "jeans"],
      worn,
      pool,
      change: { removed: ["her denim jacket"], added: [] },
      overlay: "",
      sink,
    });
    expect(result.wornIds).toEqual(["tee", "jeans"]);
    expect(result.overlay).toBe("");
    expectCleanSink(sink);
  });

  it("adds a matched pool garment's id (deduped against the worn list)", () => {
    const result = applyWornGarmentChanges({
      wornIds: ["tee", "jeans"],
      worn,
      pool,
      change: { removed: [], added: ["a wool cardigan"] },
      overlay: "",
    });
    expect(result.wornIds).toEqual(["tee", "jeans", "cardigan"]);
  });

  it("keeps a narrated-but-unowned added garment as free-text overlay, with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const result = applyWornGarmentChanges({
      wornIds: ["tee"],
      worn,
      pool,
      change: { removed: [], added: ["a borrowed hoodie"] },
      overlay: "",
      sink,
    });
    expect(result.wornIds).toEqual(["tee"]);
    expect(result.overlay).toBe("a borrowed hoodie");
    expectDiagnostic(sink, "chat_wardrobe.add_overlay");
  });

  it("degrades an unmatched removal with a diagnostic (never fails the fold)", () => {
    const sink = new DiagnosticCollector();
    const result = applyWornGarmentChanges({
      wornIds: ["tee", "jeans"],
      worn,
      pool,
      change: { removed: ["a feather boa"], added: [] },
      overlay: "keep me",
      sink,
    });
    expect(result.wornIds).toEqual(["tee", "jeans"]); // untouched
    expect(result.overlay).toBe("keep me"); // existing overlay preserved
    expectDiagnostic(sink, "chat_wardrobe.remove_unmatched");
  });

  it("swaps a piece: removes one and adds another in a single fold", () => {
    const result = applyWornGarmentChanges({
      wornIds: ["jacket", "tee", "jeans"],
      worn,
      pool,
      change: { removed: ["the denim jacket"], added: ["her wool cardigan"] },
      overlay: "",
    });
    expect(result.wornIds).toEqual(["tee", "jeans", "cardigan"]);
  });
});

describe("intimateRegionsBare", () => {
  it("is true when torso or pelvis reads bare, false when covered", () => {
    expect(intimateRegionsBare(FULLY_COVERED)).toBe(false);
    const toplessButCovered: RegionExposure = { torso: "bare", pelvis: "covered", legs: "covered", feet: "covered" };
    expect(intimateRegionsBare(toplessButCovered)).toBe(true);
    const bottomlessSheerTop: RegionExposure = { torso: "sheer", pelvis: "bare", legs: "bare", feet: "bare" };
    expect(intimateRegionsBare(bottomlessSheerTop)).toBe(true);
    const sheerOnly: RegionExposure = { torso: "sheer", pelvis: "sheer", legs: "bare", feet: "bare" };
    expect(intimateRegionsBare(sheerOnly)).toBe(false);
  });
});
