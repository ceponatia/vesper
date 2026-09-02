import { describe, expect, it } from "vitest";
import { hairOcclusionForItem, headwearSubtypes } from "./subtypes";
import { resolveHairOcclusion } from "./hair-occlusion";

/**
 * Hair occlusion (docs/contracts/items/README.md §Hair occlusion): the band
 * every image, narrator and affordance consumer reads is resolved HERE, once,
 * from the worn headwear — subtype default, item override, strongest worn
 * piece wins, and everything unknown resolves toward showing hair.
 *
 * What a defect here does: a hijab that resolves `partial` puts hair back
 * into an image prompt; a held hat that counts hides hair nobody is wearing;
 * an unknown value that resolves `full` silently erases a character's hair.
 */
describe("hairOcclusionForItem", () => {
  it("every headwear subtype declares a band", () => {
    for (const subtype of headwearSubtypes) expect(subtype.hairOcclusion, subtype.id).toBeDefined();
  });

  it.each([
    ["headband", "none"],
    ["cap", "partial"],
    ["hijab", "full"],
  ] as const)("%s defaults to %s", (subtypeId, band) => {
    expect(hairOcclusionForItem(subtypeId)).toBe(band);
  });

  it("an item override beats the subtype default in either direction", () => {
    expect(hairOcclusionForItem("headscarf", "partial")).toBe("partial");
    expect(hairOcclusionForItem("helmet", "full")).toBe("full");
  });

  it("an unknown override or subtype resolves toward showing hair", () => {
    expect(hairOcclusionForItem("cap", "total")).toBe("partial");
    expect(hairOcclusionForItem("cap", 3)).toBe("partial");
    expect(hairOcclusionForItem("balaclava")).toBe("none");
    expect(hairOcclusionForItem(undefined, undefined)).toBe("none");
  });
});

describe("resolveHairOcclusion", () => {
  it("the strongest WORN piece wins", () => {
    expect(
      resolveHairOcclusion([
        { worn: true, hairOcclusion: "none" },
        { worn: true, hairOcclusion: "full" },
        { worn: true, hairOcclusion: "partial" },
      ]),
    ).toBe("full");
    expect(resolveHairOcclusion([{ worn: true, hairOcclusion: "partial" }, { worn: true }])).toBe("partial");
  });

  it("a held, stored or placed piece hides nothing", () => {
    expect(resolveHairOcclusion([{ worn: false, hairOcclusion: "full" }, { worn: true, hairOcclusion: "partial" }])).toBe(
      "partial",
    );
    expect(resolveHairOcclusion([{ worn: false, hairOcclusion: "full" }])).toBe("none");
  });

  it("nothing worn, or no band carried, is none", () => {
    expect(resolveHairOcclusion([])).toBe("none");
    expect(resolveHairOcclusion([{ worn: true }, { worn: true, hairOcclusion: undefined }])).toBe("none");
  });
});
