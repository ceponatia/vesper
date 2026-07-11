import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, db: vi.fn() };
});

import { db } from "../db";
import { defaultOutfitPhrase, loadDefaultWardrobe, wardrobeOutfitText } from "./avatar";

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("wardrobeOutfitText (the chat scenario's Starting Outfit phrase)", () => {
  it("phrases visible garments description-primary, subtype-led, with appearance in parens", () => {
    const text = wardrobeOutfitText([
      {
        name: "Red Sundress",
        coverage: ["chest", "back", "waist", "pelvis", "thighs"],
        layer: 1,
        description: "a light red cotton sundress",
        appearance: "worn soft at the hem",
      },
      { name: "Thin Gold Hoop", coverage: ["nose"], layer: 1, subtype: "nose_ring" },
    ]);
    expect(text).toBe("a light red cotton sundress (worn soft at the hem), nose ring: Thin Gold Hoop");
  });

  it("omits hidden layers and hints sheer-covered pieces — never raw ids anywhere", () => {
    const text = wardrobeOutfitText([
      { name: "Lace Bralette", coverage: ["chest"], layer: 0 },
      { name: "Sheer Blouse", coverage: ["chest", "back", "waist"], layer: 1, opacity: "sheer" },
      { name: "Wool Coat", coverage: ["chest", "back", "waist", "upper_arms"], layer: 3 },
    ]);
    // The bralette is under a sheer layer AND an opaque coat → hidden entirely;
    // the blouse survives visible only where the coat doesn't cover.
    expect(text).toContain("Wool Coat");
    expect(text).not.toContain("Lace Bralette");
  });

  it("is empty for an empty wardrobe", () => {
    expect(wardrobeOutfitText([])).toBe("");
  });
});

describe("defaultOutfitPhrase degradation", () => {
  it("degrades to an empty phrase (composer inference) when the item lookup fails — never ids", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const sink = new DiagnosticCollector();
    expect(await defaultOutfitPhrase("u-1", ["itemid1abc"], sink)).toBe("");
    expect(sink.items.some((d) => d.code === "images.avatar.outfit_load_failed")).toBe(true);
  });
});

describe("loadDefaultWardrobe degradation", () => {
  it("degrades to no wardrobe AND records images.avatar.outfit_load_failed when the lookup throws", async () => {
    mockDb.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const sink = new DiagnosticCollector();
    const wardrobe = await loadDefaultWardrobe("u-1", ["item-1", "item-2"], sink);
    expect(wardrobe).toEqual([]); // degraded: attributes-only prompt
    const recorded = sink.items.filter((d) => d.code === "images.avatar.outfit_load_failed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.severity).toBe("warn");
    expect(recorded[0]?.context).toMatchObject({ itemIds: ["item-1", "item-2"] });
  });

  it("an empty outfit skips the lookup entirely — no query, no diagnostic", async () => {
    const sink = new DiagnosticCollector();
    expect(await loadDefaultWardrobe("u-1", [], sink)).toEqual([]);
    expect(mockDb).not.toHaveBeenCalled();
    expect(sink.items).toEqual([]);
  });
});
