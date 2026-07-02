import { describe, expect, it } from "vitest";
import {
  attributeValueSchema,
  attributeValueSources,
  overlaySourceMayChange,
  resolveAttributes,
  type AttributeValue,
} from "./value";

function av(partial: Partial<AttributeValue> & Pick<AttributeValue, "value" | "source">): AttributeValue {
  return { id: "hair.color", ...partial };
}

function effective(values: AttributeValue[], id = "hair.color"): AttributeValue | undefined {
  return values.find((v) => v.id === id);
}

describe("resolveAttributes precedence", () => {
  it("creation beats base", () => {
    const out = resolveAttributes([av({ value: "brown", source: "base" })], [av({ value: "auburn", source: "creation" })]);
    expect(effective(out)?.value).toBe("auburn");
  });

  it("narrative beats creation", () => {
    const out = resolveAttributes(
      [av({ value: "auburn", source: "creation" })],
      [av({ value: "dyed_vivid", source: "narrative" })],
    );
    expect(effective(out)?.value).toBe("dyed_vivid");
  });

  it("condition beats narrative", () => {
    const out = resolveAttributes(
      [],
      [
        av({ value: "dyed_vivid", source: "narrative" }),
        av({ value: "gray", source: "condition", sourceId: "cond_curse" }),
      ],
    );
    expect(effective(out)?.value).toBe("gray");
  });

  it("manual beats condition", () => {
    const out = resolveAttributes(
      [],
      [
        av({ value: "gray", source: "condition" }),
        av({ value: "platinum", source: "manual" }),
      ],
    );
    expect(effective(out)?.value).toBe("platinum");
  });

  it("a low-precedence overlay never shadows a higher-precedence base entry", () => {
    const out = resolveAttributes(
      [av({ value: "platinum", source: "manual" })],
      [av({ value: "brown", source: "narrative" })],
    );
    expect(effective(out)?.value).toBe("platinum");
  });

  it("full chain: manual > condition > narrative > creation > base", () => {
    const out = resolveAttributes(
      [av({ value: "v_base", source: "base" }), av({ value: "v_creation", source: "creation" })],
      [
        av({ value: "v_manual", source: "manual" }),
        av({ value: "v_narrative", source: "narrative" }),
        av({ value: "v_condition", source: "condition" }),
      ],
    );
    expect(effective(out)?.value).toBe("v_manual");
  });

  it("ties at equal precedence: the later entry wins", () => {
    const out = resolveAttributes(
      [],
      [
        av({ value: "first", source: "condition", sourceId: "c1" }),
        av({ value: "second", source: "item", sourceId: "i1" }),
      ],
    );
    expect(effective(out)?.value).toBe("second");
    expect(effective(out)?.sourceId).toBe("i1");
  });

  it("same source twice: the later write wins", () => {
    const out = resolveAttributes(
      [],
      [av({ value: "stale", source: "narrative" }), av({ value: "fresh", source: "narrative" })],
    );
    expect(effective(out)?.value).toBe("fresh");
  });

  it("keeps distinct attribute ids independent", () => {
    const out = resolveAttributes(
      [av({ value: "brown", source: "base" }), av({ id: "eyes.color", value: "green", source: "base" })],
      [av({ value: "auburn", source: "narrative" })],
    );
    expect(out).toHaveLength(2);
    expect(effective(out)?.value).toBe("auburn");
    expect(effective(out, "eyes.color")?.value).toBe("green");
  });

  it("returns base values untouched when there are no overlays", () => {
    const base = [av({ value: "brown", source: "base" })];
    expect(resolveAttributes(base, [])).toEqual(base);
  });
});

describe("attributeValueSchema degradation", () => {
  it("a malformed source degrades to low-precedence creation instead of rejecting", () => {
    const parsed = attributeValueSchema.safeParse({ id: "hair.color", value: "auburn", source: "bogus" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source).toBe("creation");
  });

  it("one malformed source in an array cannot reject the siblings", () => {
    const arr = attributeValueSchema.array().safeParse([
      { id: "hair.color", value: "auburn", source: 42 },
      { id: "eyes.color", value: "green", source: "manual" },
    ]);
    expect(arr.success).toBe(true);
    if (arr.success) {
      expect(arr.data[0]?.source).toBe("creation");
      expect(arr.data[1]?.source).toBe("manual");
    }
  });
});

describe("overlaySourceMayChange", () => {
  it("inherent admits only manual and magic", () => {
    expect(overlaySourceMayChange("inherent", "manual")).toBe(true);
    expect(overlaySourceMayChange("inherent", "magic")).toBe(true);
  });

  it("inherent rejects narrative and every other non-deliberate source", () => {
    for (const source of ["base", "creation", "narrative", "condition", "injury", "item", "environment"] as const) {
      expect(overlaySourceMayChange("inherent", source)).toBe(false);
    }
  });

  it("mutable admits every source", () => {
    for (const source of attributeValueSources) {
      expect(overlaySourceMayChange("mutable", source)).toBe(true);
    }
  });
});
