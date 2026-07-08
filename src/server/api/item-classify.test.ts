import { describe, expect, it } from "vitest";
import { mergeClassifiedExtras } from "./item-classify";
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
