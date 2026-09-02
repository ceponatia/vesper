import { describe, expect, it } from "vitest";
import { groundItemDraft, mergeClassifiedExtras } from "./item-classify";
import { itemExtrasSchema } from "./schemas";

const empty = () => itemExtrasSchema.parse({});

describe("mergeClassifiedExtras", () => {
  it("fills absent clothing facets and grounds them against the registries", () => {
    const { merged, changed } = mergeClassifiedExtras(empty(), "clothing", {
      index: 0,
      category: "skirt",
      layer: 1,
      wearer: "feminine",
      color: { family: "blue", shade: "aqua" },
    });
    expect(changed).toBe(true);
    expect(merged.category).toBe("skirt");
    expect(merged.layer).toBe(1);
    expect(merged.wearer).toBe("feminine");
    expect(merged.color).toEqual({ family: "blue", shade: "aqua" });
  });

  it("never overwrites a present value — only absent fields fill", () => {
    const extras = itemExtrasSchema.parse({
      category: "top",
      wearer: "unisex",
      layer: 3,
      color: { family: "red" },
    });
    const { merged, changed } = mergeClassifiedExtras(extras, "clothing", {
      index: 0,
      category: "skirt",
      layer: 0,
      wearer: "feminine",
      color: { family: "blue" },
    });
    expect(changed).toBe(false);
    expect(merged.category).toBe("top");
    expect(merged.wearer).toBe("unisex");
    expect(merged.layer).toBe(3);
    expect(merged.color).toEqual({ family: "red" });
  });

  it("drops unknown vocabulary instead of writing it", () => {
    const { merged, changed } = mergeClassifiedExtras(empty(), "clothing", {
      index: 0,
      category: "tuxedo",
      wearer: "androgynous",
      color: { family: "chartreuse" },
    });
    expect(changed).toBe(false);
    expect(merged.category).toBeUndefined();
    expect(merged.wearer).toBeUndefined();
    expect(merged.color).toBeUndefined();
  });

  it("objects take subtype + color; clothing facets are ignored for them", () => {
    const { merged, changed } = mergeClassifiedExtras(empty(), "object", {
      index: 0,
      subtype: "tool",
      category: "top", // must not apply to an object
      wearer: "feminine",
      color: { family: "red" },
    });
    expect(changed).toBe(true);
    expect(merged.subtype).toBe("tool");
    expect(merged.category).toBeUndefined();
    expect(merged.wearer).toBeUndefined();
    expect(merged.color).toEqual({ family: "red" });
  });

  it("containers take color only", () => {
    const { merged, changed } = mergeClassifiedExtras(empty(), "container", {
      index: 0,
      subtype: "tool",
      color: { family: "brown" },
    });
    expect(changed).toBe(true);
    expect(merged.color).toEqual({ family: "brown" });
    expect(merged.subtype).toBeUndefined();
  });
});

describe("groundItemDraft (✦ draft-from-description, ux-improvements slice 5)", () => {
  it("keeps a carve-out coverage exactly — the peep-toe sandal covers a foot minus toes", () => {
    const proposal = groundItemDraft("clothing", {
      category: "footwear",
      layer: 1,
      coverage: ["top_of_foot", "sole", "heel"],
      opacity: "opaque",
    });
    expect(proposal.category).toBe("footwear");
    expect(proposal.coverage).toEqual(["top_of_foot", "sole", "heel"]);
    expect(proposal.coverage).not.toContain("toes");
    expect(proposal.coverage).not.toContain("feet");
  });

  it("explodes a parent id to the explicit-id convention", () => {
    const proposal = groundItemDraft("clothing", { coverage: ["feet"] });
    expect(proposal.coverage).toEqual(expect.arrayContaining(["feet", "toes", "top_of_foot", "sole", "heel"]));
  });

  it("drops unknown and non-coverage-relevant location ids", () => {
    expect(groundItemDraft("clothing", { coverage: ["nonsense_zone"] }).coverage).toBeUndefined();
    // Intimate locations are not garment slots — an all-intimate proposal must
    // not survive as "covers nothing".
    expect(groundItemDraft("clothing", { coverage: ["vulva"] }).coverage).toBeUndefined();
  });

  it("grounds facets and drops unknown vocabulary per-field", () => {
    const proposal = groundItemDraft("clothing", {
      category: "tuxedo", // unknown → dropped
      wearer: "feminine",
      color: { family: "chartreuse" }, // unknown family → dropped
      opacity: "sheer",
      sensory: { appearance: " sits low on the hips ", scent: "", tactile: undefined },
    });
    expect(proposal.category).toBeUndefined();
    expect(proposal.wearer).toBe("feminine");
    expect(proposal.color).toBeUndefined();
    expect(proposal.opacity).toBe("sheer");
    expect(proposal.sensory).toEqual({ appearance: "sits low on the hips", scent: undefined, tactile: undefined });
  });

  it("drops clothing-only facets for objects; object subtype grounds", () => {
    const proposal = groundItemDraft("object", {
      category: "top",
      coverage: ["feet"],
      opacity: "sheer",
      subtype: "tool",
      color: { family: "red", shade: "rust" },
    });
    expect(proposal.category).toBeUndefined();
    expect(proposal.coverage).toBeUndefined();
    expect(proposal.opacity).toBeUndefined();
    expect(proposal.subtype).toBe("tool");
    expect(proposal.color).toEqual({ family: "red", shade: "rust" });
  });

  it("returns an empty proposal when nothing survives grounding", () => {
    expect(groundItemDraft("container", { category: "top", coverage: ["feet"] })).toEqual({});
  });

  // Hair occlusion is a headwear-only OVERRIDE of the subtype default
  // (docs/contracts/items/README.md §Hair occlusion). Falsified by a grounding
  // that stores the proposal wherever the model wrote it: a redundant band
  // would freeze what the type already resolves to, a band on a non-headwear
  // garment would be dropped at save anyway, and a non-band must never reach
  // the form.
  it.each([
    ["headscarf with the fringe out", "headwear", "headscarf", "partial", "partial"],
    ["fully enclosing helmet", "headwear", "helmet", "full", "full"],
    ["hat perched above the hairstyle", "headwear", "hat", "none", "none"],
    ["hat already partial by type — redundant", "headwear", "hat", "partial", undefined],
    ["non-headwear garment", "jewelry", "choker", "full", undefined],
    ["not a band", "headwear", "hat", "mostly", undefined],
  ] as const)("hair occlusion: %s", (_label, category, subtype, band, expected) => {
    const proposal = groundItemDraft("clothing", { category, subtype, hairOcclusion: band as never });
    expect(proposal.hairOcclusion).toBe(expected);
  });
});
