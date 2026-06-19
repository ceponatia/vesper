import { describe, expect, it } from "vitest";
import { attributeRegistry, realizeBody, type AttributeDefinition, type AttributeValue } from "@/contracts";
import {
  allowedOptionsFor,
  asList,
  attributeValueMap,
  defaultValueFor,
  isAiSourced,
  isOutOfRuleValue,
  removeAttribute,
  seedRequiredAttributes,
  seedValueFor,
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

// --- Slice 3: editor narrowing by species rule (attribute-mutability.spec.md §8) ---

const attrDef = (id: string): AttributeDefinition => {
  const d = attributeRegistry.byId(id);
  if (!d) throw new Error(`no such attribute: ${id}`);
  return d;
};

// A faerie's wings.shape is rule-locked to "butterfly"; an elf's ears.shape is a
// required trait defaulting to "pointed". Humans carry no attribute rules.
const faerie = realizeBody({ speciesId: "faerie", bodyPlanId: "humanoid", intimateRegions: [] });
const elf = realizeBody({ speciesId: "elf", bodyPlanId: "humanoid", intimateRegions: [] });
const human = realizeBody({ speciesId: "human", bodyPlanId: "humanoid", intimateRegions: [] });

describe("allowedOptionsFor — editor enum hard-restriction", () => {
  it("narrows to the species rule's allowed set", () => {
    expect(allowedOptionsFor(attrDef("wings.shape"), faerie)).toEqual(["butterfly"]);
  });

  it("narrows an elf's ears.shape to a subset of the definition", () => {
    const all = attrDef("ears.shape").allowedValues ?? [];
    const narrowed = allowedOptionsFor(attrDef("ears.shape"), elf);
    expect(narrowed).toEqual(["slightly_pointed", "pointed", "long_pointed"]);
    expect(narrowed.length).toBeLessThan(all.length);
  });

  it("falls back to the full definition list when no rule applies", () => {
    expect(allowedOptionsFor(attrDef("eyes.color"), human)).toEqual(attrDef("eyes.color").allowedValues);
  });
});

describe("isOutOfRuleValue — surface, don't drop", () => {
  it("flags a stored value outside the narrowed set", () => {
    // "rounded" is a valid ears.shape in the definition but not allowed for an elf.
    expect(isOutOfRuleValue(allowedOptionsFor(attrDef("ears.shape"), elf), "rounded")).toBe(true);
  });

  it("accepts a value inside the narrowed set, and ignores an unset value", () => {
    expect(isOutOfRuleValue(allowedOptionsFor(attrDef("ears.shape"), elf), "pointed")).toBe(false);
    expect(isOutOfRuleValue(["pointed"], "")).toBe(false);
  });
});

describe("seedValueFor — adding an attribute", () => {
  it("uses the species rule default when there is one", () => {
    expect(seedValueFor(attrDef("wings.shape"), faerie)).toBe("butterfly");
    expect(seedValueFor(attrDef("ears.shape"), elf)).toBe("pointed");
  });

  it("falls back to the generic default when no rule default applies", () => {
    expect(seedValueFor(attrDef("eyes.color"), human)).toBe("brown");
  });
});

describe("seedRequiredAttributes — species/heritage default seeding", () => {
  const cfg = (speciesId: string, bodyFeatures?: string[]) => ({
    speciesId,
    bodyPlanId: "humanoid",
    intimateRegions: [] as string[],
    ...(bodyFeatures ? { bodyFeatures } : {}),
  });

  it("seeds an elf's required ears.shape default", () => {
    expect(seedRequiredAttributes([], cfg("elf"))).toContainEqual({
      id: "ears.shape",
      value: "pointed",
      source: "creation",
    });
  });

  it("never clobbers a value the author already set", () => {
    const existing: AttributeValue[] = [{ id: "ears.shape", value: "long_pointed", source: "manual" }];
    const out = seedRequiredAttributes(existing, cfg("elf"));
    expect(out.filter((a) => a.id === "ears.shape")).toEqual(existing);
  });

  it("seeds nothing for a species with no required rules (human)", () => {
    expect(seedRequiredAttributes([], cfg("human"))).toEqual([]);
  });

  it("only seeds attributes applicable to the realized body", () => {
    // Faerie defaults to the wings feature → wings.shape (required) is seeded…
    expect(seedRequiredAttributes([], cfg("faerie"))).toContainEqual({
      id: "wings.shape",
      value: "butterfly",
      source: "creation",
    });
    // …but explicitly stripping the feature drops the wings attributes entirely.
    expect(seedRequiredAttributes([], cfg("faerie", [])).some((a) => a.id === "wings.shape")).toBe(false);
  });
});
