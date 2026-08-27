import { describe, expect, it } from "vitest";
import { expectAllValidate, expectRefsResolve, expectUniqueIds } from "@/test/registry-invariants";
import { attributeCategories } from "./category-ids";
import { attributeGroups } from "./categories";
import { materializeRegistryDefaults, registryDefaultSourceId } from "./index";
import { buildRegistry } from "./registry";
import { attributeDefinitionSchema, defineAttributeGroup } from "./types";
import { bodyLocationRegistry } from "../body/locations";

const registry = buildRegistry(attributeGroups);

describe("attribute registry invariants", () => {
  it("every definition validates against the definition schema", () => {
    expectAllValidate(registry.definitions, attributeDefinitionSchema);
  });

  it("all attribute ids are unique", () => {
    expectUniqueIds(registry.definitions, "attributeRegistry");
  });

  it("every enum/enum_list attribute has at least 2 allowed values", () => {
    for (const def of registry.definitions) {
      if (def.valueType === "enum" || def.valueType === "enum_list") {
        expect(def.allowedValues?.length ?? 0, def.id).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("every bodyLocationId references a known body location", () => {
    expectRefsResolve(
      registry.definitions,
      (def) => (def.bodyLocationId === undefined ? [] : [def.bodyLocationId]),
      (id) => bodyLocationRegistry.byId(id),
      (def, id) => `${def.id} → ${id}`,
    );
  });

  it("registers exactly one group per category, covering the full category list", () => {
    const registered = attributeGroups.map((g) => g.category);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...attributeCategories].sort());
    for (const category of attributeCategories) {
      expect(registry.forCategory(category).length, category).toBeGreaterThan(0);
    }
  });

  it("ids live in the group of their own category", () => {
    for (const group of attributeGroups) {
      for (const def of group.definitions) {
        expect(def.id.startsWith(`${group.category}.`), def.id).toBe(true);
        expect(def.category).toBe(group.category);
      }
    }
  });

  it("forBodyLocation returns attributes anchored at the location", () => {
    const atHair = registry.forBodyLocation("hair");
    expect(atHair.map((d) => d.id)).toContain("hair.color");
    expect(atHair.every((d) => d.bodyLocationId === "hair")).toBe(true);
  });

  it("narratorGuidance lives only on enum/enum_list attributes and keys only real members", () => {
    for (const def of registry.definitions) {
      if (!def.narratorGuidance) continue;
      expect(["enum", "enum_list"], def.id).toContain(def.valueType);
      for (const key of Object.keys(def.narratorGuidance)) {
        expect(def.allowedValues ?? [], `${def.id} → ${key}`).toContain(key);
      }
    }
  });

  // The orthogonality rule's cheap tripwire: a gloss
  // describes only its own attribute's dimension — height vocabulary outside the height
  // attributes reveals an entangled gloss. Extend the blocklist as authoring reveals leaks.
  it("orthogonality tripwire: no gloss outside height/apparent_age talks height", () => {
    for (const def of registry.definitions) {
      if (!def.narratorGuidance) continue;
      if (def.id === "build.height" || def.id === "identity.apparent_age") continue;
      for (const [key, gloss] of Object.entries(def.narratorGuidance)) {
        expect(/\b(tall|short|towering|height)\b/i.test(gloss), `${def.id}.${key}: "${gloss}"`).toBe(false);
      }
    }
  });

  it("defineAttributeGroup rejects narratorGuidance on non-enums and stray keys", () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "text",
          description: "Guidance on a non-enum.",
          mutability: "inherent",
          narratorGuidance: { anything: "a gloss" },
        },
      ]),
    ).toThrow(/not an enum/);
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "Guidance key outside the vocabulary.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          narratorGuidance: { c: "a gloss" },
        },
      ]),
    ).toThrow(/not in allowedValues/);
  });

  it('defineAttributeGroup rejects renderNoneInPrompts when "none" is not in the vocabulary', () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "Flagged none-keeper with no none member.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          renderNoneInPrompts: true,
        },
      ]),
    ).toThrow(/"none" is not in allowedValues/);
  });

  it("buildRegistry rejects duplicate ids", () => {
    const dup = registry.definitions[0];
    expect(dup).toBeDefined();
    if (!dup) return;
    expect(() => buildRegistry([{ category: dup.category, definitions: [dup, dup] }])).toThrow(/Duplicate attribute id/);
  });

  it("buildRegistry rejects enums with fewer than 2 values", () => {
    const group = defineAttributeGroup("build", [
      {
        id: "build.bogus",
        label: "Bogus",
        kind: "physical",
        category: "build",
        valueType: "enum",
        description: "Degenerate enum.",
        mutability: "inherent",
        allowedValues: ["only_one"],
      },
    ]);
    expect(() => buildRegistry([group])).toThrow(/fewer than 2/);
  });
});

describe("materialized registry defaults (persisted-baseline)", () => {
  it("the flagged set is exactly the four foot structural fields — never feet.smell", () => {
    const flagged = registry.definitions.filter((def) => def.materializeDefault).map((def) => def.id);
    expect(flagged.sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
  });

  it("pins the exact default each materialized fact carries", () => {
    // The agreed baseline (owner correction, 2026-07-30): structural axes rest
    // at "average", and toenails at "trimmed" — ordinary nail length without
    // assuming additional grooming. Neon is backfilled from this map, so a
    // change here is a data migration, not a data edit.
    const defaults = Object.fromEntries(
      registry.definitions.filter((def) => def.materializeDefault).map((def) => [def.id, def.defaultValue]),
    );
    expect(defaults).toEqual({
      "feet.size": "average",
      "feet.arch": "average",
      "feet.nails": "trimmed",
      "feet.toes": "average",
    });
  });

  it("every flagged definition carries a defaultValue, and none is coreVisual", () => {
    for (const def of registry.definitions) {
      if (!def.materializeDefault) continue;
      expect(def.defaultValue, def.id).toBeDefined();
      expect(def.coreVisual ?? false, def.id).toBe(false);
    }
  });

  it("defineAttributeGroup rejects materializeDefault without a defaultValue", () => {
    expect(() =>
      defineAttributeGroup("build", [
        {
          id: "build.bogus",
          label: "Bogus",
          kind: "physical",
          category: "build",
          valueType: "enum",
          description: "A baseline with nothing to materialize.",
          mutability: "inherent",
          allowedValues: ["a", "b"],
          materializeDefault: true,
        },
      ]),
    ).toThrow(/no defaultValue/);
  });

  it("fills every missing flagged fact with the versioned creation provenance", () => {
    const filled = materializeRegistryDefaults([]);
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
    for (const value of filled) {
      expect(value.source).toBe("creation");
      expect(value.sourceId).toBe(registryDefaultSourceId("feet"));
    }
    expect(registryDefaultSourceId("feet")).toBe("registry-default:feet:v1");
  });

  it("never overwrites a supplied value, whatever its source", () => {
    const authored = [{ id: "feet.arch" as const, value: "high", source: "manual" as const }];
    const filled = materializeRegistryDefaults(authored);
    expect(filled.filter((value) => value.id === "feet.arch")).toEqual(authored);
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.nails", "feet.size", "feet.toes"]);
  });

  it("is idempotent — a second pass adds nothing", () => {
    const once = materializeRegistryDefaults([]);
    expect(materializeRegistryDefaults(once)).toEqual(once);
  });

  it("respects the applicability gate", () => {
    const filled = materializeRegistryDefaults([], { isApplicable: (def) => def.id !== "feet.nails" });
    expect(filled.map((value) => value.id).sort()).toEqual(["feet.arch", "feet.size", "feet.toes"]);
  });

  it("prefers the rule default when narrowing rejects the registry default, and skips when both fail", () => {
    const narrowed = materializeRegistryDefaults([], {
      allowedValuesFor: (def) => (def.id === "feet.arch" ? ["flat", "low"] : def.allowedValues),
      ruleDefaultFor: (def) => (def.id === "feet.arch" ? "low" : undefined),
    });
    expect(narrowed.find((value) => value.id === "feet.arch")?.value).toBe("low");

    const impossible = materializeRegistryDefaults([], {
      allowedValuesFor: (def) => (def.id === "feet.arch" ? ["flat"] : def.allowedValues),
      ruleDefaultFor: () => undefined,
    });
    expect(impossible.some((value) => value.id === "feet.arch")).toBe(false);
    expect(impossible.map((value) => value.id).sort()).toEqual(["feet.nails", "feet.size", "feet.toes"]);
  });
});

describe("parseValue", () => {
  it("enum: accepts an allowed value, rejects anything else", () => {
    expect(registry.parseValue("hair.color", "auburn")).toEqual({ ok: true, value: "auburn" });
    expect(registry.parseValue("hair.color", "neon_green").ok).toBe(false);
    expect(registry.parseValue("hair.color", 4).ok).toBe(false);
  });

  it("enum_list: accepts a non-empty array of allowed values", () => {
    expect(registry.parseValue("skin.markings", ["tattoos", "scars"])).toEqual({
      ok: true,
      value: ["tattoos", "scars"],
    });
    expect(registry.parseValue("skin.markings", []).ok).toBe(false);
    expect(registry.parseValue("skin.markings", ["tattoos", "antlers"]).ok).toBe(false);
    expect(registry.parseValue("skin.markings", "tattoos").ok).toBe(false);
  });

  it("text: accepts 1–500 chars, rejects empty and oversized", () => {
    expect(registry.parseValue("hair.style", "loose braid over one shoulder")).toEqual({
      ok: true,
      value: "loose braid over one shoulder",
    });
    expect(registry.parseValue("hair.style", "").ok).toBe(false);
    expect(registry.parseValue("hair.style", "x".repeat(501)).ok).toBe(false);
  });

  // The starter vocabulary has no number/flag attributes yet; exercise those
  // parse paths through a synthetic registry so they stay covered.
  it("number: respects min/max bounds", () => {
    const synthetic = buildRegistry([
      defineAttributeGroup("build", [
        {
          id: "build.reach_cm",
          label: "Reach",
          kind: "physical",
          category: "build",
          valueType: "number",
          description: "Synthetic bounded number.",
          mutability: "inherent",
          min: 0,
          max: 100,
        },
        {
          id: "build.double_jointed",
          label: "Double-jointed",
          kind: "biological",
          category: "build",
          valueType: "flag",
          description: "Synthetic flag.",
          mutability: "inherent",
        },
      ]),
    ]);
    expect(synthetic.parseValue("build.reach_cm", 42)).toEqual({ ok: true, value: 42 });
    expect(synthetic.parseValue("build.reach_cm", -1).ok).toBe(false);
    expect(synthetic.parseValue("build.reach_cm", 101).ok).toBe(false);
    expect(synthetic.parseValue("build.reach_cm", "42").ok).toBe(false);
    expect(synthetic.parseValue("build.double_jointed", true)).toEqual({ ok: true, value: true });
    expect(synthetic.parseValue("build.double_jointed", "yes").ok).toBe(false);
  });

  it("unknown attribute id fails with an issue, not a throw", () => {
    const result = registry.parseValue("hair.glitter", "sparkly");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/unknown attribute id/);
  });
});

describe("resolveAlias", () => {
  it("resolves a free-text mention to its attribute", () => {
    expect(registry.resolveAlias("ginger").map((d) => d.id)).toEqual(["hair.color"]);
  });

  it("is case-insensitive", () => {
    expect(registry.resolveAlias("Ginger").map((d) => d.id)).toEqual(["hair.color"]);
    expect(registry.resolveAlias("FRECKLED").map((d) => d.id)).toEqual(["face.freckles"]);
  });

  it("returns an empty list for unknown text", () => {
    expect(registry.resolveAlias("dorsal fin")).toEqual([]);
  });

  it("fans out a shared alias to every attribute that claims it", () => {
    // Aliases are deliberately many-to-many: a generic mention ("feet") can
    // surface several candidate attributes. resolveAlias returns all of them.
    const shared = buildRegistry([
      defineAttributeGroup("feet", [
        { id: "feet.a", label: "A", kind: "physical", category: "feet", valueType: "text", description: "x", mutability: "inherent", aliases: ["paws"] },
        { id: "feet.b", label: "B", kind: "presentation", category: "feet", valueType: "text", description: "y", mutability: "mutable", aliases: ["paws"] },
      ]),
    ]);
    expect(shared.resolveAlias("paws").map((d) => d.id).sort()).toEqual(["feet.a", "feet.b"]);
  });
});
