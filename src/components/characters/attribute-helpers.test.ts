import { describe, expect, it } from "vitest";
import { attributeRegistry, type AttributeValue } from "@/contracts";
import {
  asList,
  attributeValueMap,
  defaultValueFor,
  isAiSourced,
  removeAttribute,
  setAttribute,
  sliderBounds,
} from "./attribute-helpers";

const aiValue: AttributeValue = { id: "hair.color", value: "auburn", source: "creation" };

describe("setAttribute", () => {
  it("upserts with manual provenance, claiming AI values", () => {
    const next = setAttribute([aiValue], "hair.color", "black");
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ id: "hair.color", value: "black", source: "manual" });
  });

  it("appends new values", () => {
    const next = setAttribute([aiValue], "eyes.color", "grey");
    expect(next).toHaveLength(2);
    expect(next[1]?.source).toBe("manual");
  });
});

describe("removeAttribute / attributeValueMap / isAiSourced", () => {
  it("removes by id", () => {
    expect(removeAttribute([aiValue], "hair.color")).toEqual([]);
    expect(removeAttribute([aiValue], "eyes.color")).toHaveLength(1);
  });

  it("maps by id", () => {
    expect(attributeValueMap([aiValue]).get("hair.color")?.value).toBe("auburn");
  });

  it("flags only creation-sourced values", () => {
    expect(isAiSourced(aiValue)).toBe(true);
    expect(isAiSourced({ ...aiValue, source: "manual" })).toBe(false);
  });
});

describe("sliderBounds", () => {
  it("uses explicit bounds with integer steps for wide ranges", () => {
    const bounds = sliderBounds({ min: 120, max: 220 });
    expect(bounds).toEqual({ min: 120, max: 220, step: 1 });
  });

  it("degrades to 0..1 with fine steps when bounds are missing", () => {
    expect(sliderBounds({})).toEqual({ min: 0, max: 1, step: 0.05 });
  });
});

describe("defaultValueFor (against the real registry)", () => {
  it("produces a registry-valid value for every definition", () => {
    for (const def of attributeRegistry.definitions) {
      const result = attributeRegistry.parseValue(def.id, defaultValueFor(def));
      if (def.valueType === "text") continue; // empty text is intentionally invalid until typed
      expect(result.ok, `${def.id} default should validate`).toBe(true);
    }
  });

  it("never defaults to an autoDefaultExcludes member when one is added", () => {
    const age = attributeRegistry.byId("identity.apparent_age");
    expect(age?.autoDefaultExcludes?.length).toBeGreaterThan(0);
    // A freshly-added apparent age must start on an adult band, not the first
    // (youngest) vocabulary entry.
    expect(age?.autoDefaultExcludes).not.toContain(defaultValueFor(age!));
  });
});

describe("asList", () => {
  it("normalizes scalars and arrays", () => {
    expect(asList(["a", "b"])).toEqual(["a", "b"]);
    expect(asList("a")).toEqual(["a"]);
    expect(asList("")).toEqual([]);
    expect(asList(3)).toEqual([]);
  });
});
