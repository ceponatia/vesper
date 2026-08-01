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

  it("matches across a plural/singular split in either direction", () => {
    expect(matchGarment("she pulls off a boot", pool)?.id).toBe("boots");
    const singular: GarmentDescriptor[] = [{ id: "boot", name: "riding boot" }];
    expect(matchGarment("kicks off her boots", singular)?.id).toBe("boot");
  });

  it("matches across an alias spelling in either direction", () => {
    expect(matchGarment("she peels off her T-shirt", worn)?.id).toBe("tee");
    const aliased: GarmentDescriptor[] = [{ id: "shirt", name: "faded band t-shirt" }];
    expect(matchGarment("pulls on a tee", aliased)?.id).toBe("shirt");
  });

  it("matches a spaced compound garment name", () => {
    const tops: GarmentDescriptor[] = [
      { id: "tank", name: "ribbed tank top" },
      { id: "sweater", name: "cropped sweater" },
    ];
    expect(matchGarment("she tugs on a tank top", tops)?.id).toBe("tank");
  });

  it("uses descriptive tokens to separate two candidates of the same garment type", () => {
    const boots: GarmentDescriptor[] = [
      { id: "brown", name: "brown leather boots" },
      { id: "black", name: "black suede boots" },
    ];
    expect(matchGarment("laces up her black suede boots", boots)?.id).toBe("black");
    expect(matchGarment("the brown boots", boots)?.id).toBe("brown");
  });

  it("never lets material overlap match a different garment type", () => {
    const jacketOnly: GarmentDescriptor[] = [{ id: "jacket", name: "leather jacket" }];
    expect(matchGarment("she pulls off her leather boots", jacketOnly)).toBeUndefined();
  });

  it("falls back to raw token overlap for a garment outside the noun registry", () => {
    const custom: GarmentDescriptor[] = [
      { id: "tiara", name: "jeweled tiara" },
      { id: "cardigan", name: "grey wool cardigan" },
    ];
    expect(matchGarment("she lifts off the jeweled tiara", custom)?.id).toBe("tiara");
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

  it("removes across a plural/singular split, where no raw token overlaps", () => {
    const sink = new DiagnosticCollector();
    const bootWorn: GarmentDescriptor[] = [{ id: "boot", name: "riding boot" }];
    const result = applyWornGarmentChanges({
      wornIds: ["boot"],
      worn: bootWorn,
      pool: [],
      change: { removed: ["she kicks off her boots"], added: [] },
      overlay: "",
      sink,
    });
    expect(result.wornIds).toEqual([]);
    expectCleanSink(sink);
  });

  it("adds the modelled pool item for an alias spelling rather than an overlay", () => {
    const sink = new DiagnosticCollector();
    const teePool: GarmentDescriptor[] = [{ id: "tee", name: "white cotton tee" }];
    const result = applyWornGarmentChanges({
      wornIds: ["jeans"],
      worn,
      pool: teePool,
      change: { removed: [], added: ["she pulls on a t-shirt"] },
      overlay: "",
      sink,
    });
    expect(result.wornIds).toEqual(["jeans", "tee"]);
    expect(result.overlay).toBe("");
    expectCleanSink(sink);
  });

  it("does not remove a garment of another type that merely shares a material", () => {
    const sink = new DiagnosticCollector();
    const leather: GarmentDescriptor[] = [{ id: "leatherJacket", name: "leather jacket" }];
    const result = applyWornGarmentChanges({
      wornIds: ["leatherJacket"],
      worn: leather,
      pool: [],
      change: { removed: ["she pulls off her leather boots"], added: [] },
      overlay: "",
      sink,
    });
    expect(result.wornIds).toEqual(["leatherJacket"]);
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
