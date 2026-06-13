import { describe, expect, it } from "vitest";
import { attributeRegistry, DiagnosticCollector, type ItemDefinition } from "@/contracts";
import { characterDraftSchema } from "./drafts";
import {
  buildAttributeSectionSchema,
  demoCharacterAttributeSection,
  demoCharacterOutfitSection,
  fillCoreVisualDefaults,
  forgeCharacter,
  forgeCharacterSection,
  groundAttributeRanges,
  groundAttributeValues,
  groundOutfitItems,
  matchOutfitAgainstLibrary,
} from "./character-forge";
import type { LibraryLookup } from "./library";

const noLibrary: LibraryLookup = async () => [];

describe("registry-derived attribute section schema", () => {
  it("accepts registered attribute ids", () => {
    const schema = buildAttributeSectionSchema();
    const result = schema.safeParse({ attributes: [{ id: "hair.color", value: "auburn" }] });
    expect(result.success).toBe(true);
  });

  it("rejects ids outside the registry enum", () => {
    const schema = buildAttributeSectionSchema();
    const result = schema.safeParse({ attributes: [{ id: "hair.nonexistent", value: "auburn" }] });
    expect(result.success).toBe(false);
  });

  it("defaults to empty attribute and range lists", () => {
    const schema = buildAttributeSectionSchema();
    expect(schema.parse({})).toEqual({ attributes: [], ranges: [] });
  });

  it("accepts ranges on registered ids, rejects unknown range ids", () => {
    const schema = buildAttributeSectionSchema();
    expect(schema.safeParse({ ranges: [{ id: "hair.color", plausible: ["brown", "black"] }] }).success).toBe(true);
    expect(schema.safeParse({ ranges: [{ id: "hair.nonexistent", plausible: ["brown"] }] }).success).toBe(false);
  });
});

describe("groundAttributeValues", () => {
  it("keeps valid values with source creation", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.color", value: "auburn" }], sink);
    expect(values).toEqual([{ id: "hair.color", value: "auburn", source: "creation" }]);
    expect(sink.items).toEqual([]);
  });

  it("drops invalid enum values with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.color", value: "chartreuse" }], sink);
    expect(values).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_value" && d.severity === "warn")).toBe(true);
  });

  it("drops unknown attribute ids with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.nonexistent", value: "auburn" }], sink);
    expect(values).toEqual([]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_value")).toBe(true);
  });

  it("salvages near-miss enum tokens by normalization", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues([{ id: "hair.length", value: "Shoulder Length" }], sink);
    expect(values).toEqual([{ id: "hair.length", value: "shoulder_length", source: "creation" }]);
    expect(sink.items).toEqual([]);
  });

  it("drops duplicate ids, keeping the first", () => {
    const sink = new DiagnosticCollector();
    const values = groundAttributeValues(
      [
        { id: "hair.color", value: "auburn" },
        { id: "hair.color", value: "black" },
      ],
      sink,
    );
    expect(values).toEqual([{ id: "hair.color", value: "auburn", source: "creation" }]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.duplicate_id")).toBe(true);
  });
});

describe("groundAttributeRanges", () => {
  it("keeps in-vocabulary subsets keyed by id", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["brown", "dark_brown", "black"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["brown", "dark_brown", "black"]);
    expect(sink.items).toEqual([]);
  });

  it("drops out-of-vocabulary members with a diagnostic, keeping the rest", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["brown", "chartreuse"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["brown"]);
    expect(
      sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member" && d.severity === "warn"),
    ).toBe(true);
  });

  it("drops a range emptied by grounding entirely", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["chartreuse", "polka_dot"] }], sink);
    expect(ranges.has("hair.color")).toBe(false);
    expect(sink.items.filter((d) => d.code === "forge.character.attributes.invalid_range_member")).toHaveLength(2);
  });

  it("drops a range on an unknown attribute id with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.nonexistent", plausible: ["brown"] }], sink);
    expect(ranges.size).toBe(0);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member")).toBe(true);
  });

  it("drops a range on a non-enum attribute with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.style", plausible: ["loose braid"] }], sink);
    expect(ranges.size).toBe(0);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.invalid_range_member")).toBe(true);
  });

  it("salvages near-miss member tokens by normalization", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges([{ id: "hair.color", plausible: ["Dark Brown", "black"] }], sink);
    expect(ranges.get("hair.color")).toEqual(["dark_brown", "black"]);
    expect(sink.items).toEqual([]);
  });

  it("keeps the first range for a duplicated id", () => {
    const sink = new DiagnosticCollector();
    const ranges = groundAttributeRanges(
      [
        { id: "hair.color", plausible: ["brown"] },
        { id: "hair.color", plausible: ["blonde"] },
      ],
      sink,
    );
    expect(ranges.get("hair.color")).toEqual(["brown"]);
    expect(sink.items.some((d) => d.code === "forge.character.attributes.duplicate_id")).toBe(true);
  });
});

describe("fillCoreVisualDefaults", () => {
  const coreIds = attributeRegistry.definitions.filter((d) => d.coreVisual).map((d) => d.id);

  it("flags a stable core set in the registry", () => {
    expect(coreIds).toContain("hair.color");
    expect(coreIds).toContain("eyes.color");
    expect(coreIds).toContain("skin.tone");
    expect(coreIds).toContain("build.height");
    expect(coreIds).toContain("build.frame");
    expect(coreIds).toContain("identity.apparent_age");
  });

  it("fills every unset core attribute with a registry-valid value, deterministically", () => {
    const sink = new DiagnosticCollector();
    const a = fillCoreVisualDefaults([], "a quiet librarian with a secret", sink);
    const b = fillCoreVisualDefaults([], "a quiet librarian with a secret");
    expect(a).toEqual(b);
    for (const id of coreIds) expect(a.map((v) => v.id)).toContain(id);
    for (const value of a) {
      expect(attributeRegistry.parseValue(value.id, value.value).ok).toBe(true);
      expect(value.source).toBe("creation");
    }
    expect(sink.items.some((d) => d.code === "forge.character.attributes.core_defaults" && d.severity === "info")).toBe(true);
  });

  it("never overrides a model-provided value", () => {
    const grounded = groundAttributeValues([{ id: "hair.color", value: "black" }]);
    const filled = fillCoreVisualDefaults(grounded, "seed text");
    expect(filled.filter((v) => v.id === "hair.color")).toEqual(grounded);
  });

  it("varies defaults across different concepts", () => {
    const seeds = Array.from({ length: 12 }, (_, i) => `concept ${i}: a different person entirely`);
    const hairColors = new Set(
      seeds.map((s) => fillCoreVisualDefaults([], s).find((v) => v.id === "hair.color")?.value),
    );
    expect(hairColors.size).toBeGreaterThan(1);
  });

  it("does nothing when all core attributes are present", () => {
    const sink = new DiagnosticCollector();
    const full = fillCoreVisualDefaults([], "seed");
    const again = fillCoreVisualDefaults(full, "other seed", sink);
    expect(again).toEqual(full);
    expect(sink.items).toEqual([]);
  });

  it("draws the seeded pick from the attribute's surviving range", () => {
    const range = ["brown", "dark_brown", "black"];
    const filled = fillCoreVisualDefaults([], "a Latina engineer", undefined, new Map([["hair.color", range]]));
    const hair = filled.find((v) => v.id === "hair.color");
    expect(range).toContain(hair?.value);
  });

  it("same seed text yields the same pick within a range", () => {
    const ranges = new Map([["hair.color", ["brown", "dark_brown", "black"]]]);
    const a = fillCoreVisualDefaults([], "a Latina engineer", undefined, ranges);
    const b = fillCoreVisualDefaults([], "a Latina engineer", undefined, ranges);
    expect(a).toEqual(b);
  });

  it("a missing range falls through to the full vocabulary with a diagnostic", () => {
    const sink = new DiagnosticCollector();
    const ranges = new Map([["hair.color", ["brown", "dark_brown", "black"]]]);
    const filled = fillCoreVisualDefaults([], "an unremarkable stranger", sink, ranges);
    const eyes = filled.find((v) => v.id === "eyes.color");
    expect(eyes).toBeDefined();
    expect(attributeRegistry.parseValue("eyes.color", eyes?.value).ok).toBe(true);
    const fallThrough = sink.items.find((d) => d.code === "forge.character.attributes.unconstrained_default");
    expect(fallThrough?.severity).toBe("info");
    const unconstrainedIds = fallThrough?.context?.ids as string[];
    expect(unconstrainedIds).toContain("eyes.color");
    expect(unconstrainedIds).not.toContain("hair.color");
  });

  it("a definite value beats a range for the same id", () => {
    const grounded = groundAttributeValues([{ id: "hair.color", value: "black" }]);
    const ranges = new Map([["hair.color", ["auburn", "red"]]]);
    const filled = fillCoreVisualDefaults(grounded, "seed text", undefined, ranges);
    expect(filled.filter((v) => v.id === "hair.color")).toEqual([
      { id: "hair.color", value: "black", source: "creation" },
    ]);
  });
});

describe("groundOutfitItems", () => {
  it("drops unknown coverage locations with a diagnostic and keeps the garment", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      {
        outfit: [
          {
            name: "Test coat",
            description: "",
            layer: 3,
            coverage: ["torso", "tail_fin"],
            opacity: "opaque",
            sensory: {},
            tags: [],
          },
        ],
      },
      sink,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.coverage).toEqual(["torso"]);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.invalid_coverage")).toBe(true);
  });

  it("drops a garment that fails item validation with a diagnostic instead of throwing", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      {
        outfit: [
          // An empty name slips past the OutfitSection type but fails itemDefinitionSchema.
          { name: "", description: "", layer: 1, coverage: ["torso"], opacity: "opaque", sensory: {}, tags: [] },
          { name: "Wool scarf", description: "", layer: 2, coverage: ["neck"], opacity: "opaque", sensory: {}, tags: [] },
        ],
      },
      sink,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Wool scarf");
    expect(sink.items.some((d) => d.code === "forge.character.outfit.invalid_item" && d.severity === "warn")).toBe(true);
  });
});

describe("outfit category templates", () => {
  it("an empty coverage falls back to the category template, with the template layer", () => {
    const items = groundOutfitItems({
      outfit: [{ name: "Scrubs top", description: "", category: "top", coverage: [], opacity: "opaque", sensory: {}, tags: [] }],
    });
    expect(items[0]?.coverage).toEqual(["shoulders", "chest", "back", "waist", "upper_arms"]);
    expect(items[0]?.layer).toBe(1);
    expect(items[0]?.category).toBe("top");
  });

  it("explicit coverage and layer win over the template", () => {
    const items = groundOutfitItems({
      outfit: [
        { name: "Tank top", description: "", category: "top", coverage: ["torso"], layer: 1, opacity: "opaque", sensory: {}, tags: [] },
      ],
    });
    expect(items[0]?.coverage).toEqual(["torso"]);
  });

  it("an unknown category is ignored with an info diagnostic", () => {
    const sink = new DiagnosticCollector();
    const items = groundOutfitItems(
      { outfit: [{ name: "Cloak", description: "", category: "tuxedo", coverage: ["torso"], opacity: "opaque", sensory: {}, tags: [] }] },
      sink,
    );
    expect(items[0]?.category).toBeUndefined();
    expect(sink.items.some((d) => d.code === "forge.character.outfit.unknown_category" && d.severity === "info")).toBe(true);
  });
});

describe("outfit library matching", () => {
  const items: ItemDefinition[] = groundOutfitItems(demoCharacterOutfitSection());

  it("matched names reference the library id; unmatched become suggested drafts", async () => {
    const lookup: LibraryLookup = async (_userId, names) =>
      names.filter((n) => n.toLowerCase().includes("sweater")).map((n) => ({ id: "item_1", name: n }));
    const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(items, "user_1", lookup);
    expect(defaultOutfit).toEqual(["item_1"]);
    expect(suggested).toHaveLength(items.length - 1);
    expect(suggested.every((i) => i.tags.includes("suggested"))).toBe(true);
    expect(suggested.some((i) => i.name.toLowerCase().includes("sweater"))).toBe(false);
  });

  it("a failed lookup degrades to all-suggested with a diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const lookup: LibraryLookup = async () => {
      throw new Error("connection refused");
    };
    const { defaultOutfit, suggested } = await matchOutfitAgainstLibrary(items, "user_1", lookup, sink);
    expect(defaultOutfit).toEqual([]);
    expect(suggested).toHaveLength(items.length);
    expect(sink.items.some((d) => d.code === "forge.character.outfit.library_lookup_failed")).toBe(true);
  });
});

describe("demo-mode forge (AI_FAKE=1 in test setup)", () => {
  it("is deterministic: same input, identical draft", async () => {
    const input = { prompt: "a weary harbor-master in her forties", userId: "user_1", findItems: noLibrary };
    const a = await forgeCharacter(input);
    const b = await forgeCharacter(input);
    expect(a).toEqual(b);
  });

  it("produces a schema-valid draft with registry-valid creation attributes", async () => {
    const draft = await forgeCharacter({ prompt: "a weary harbor-master", userId: "user_1", findItems: noLibrary });
    expect(characterDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.name.length).toBeGreaterThan(0);
    expect(draft.profile.bio.length).toBeGreaterThan(0);
    expect(draft.profile.attributes.length).toBeGreaterThan(0);
    for (const value of draft.profile.attributes) {
      expect(value.source).toBe("creation");
      expect(attributeRegistry.parseValue(value.id, value.value).ok).toBe(true);
    }
    expect(draft.suggestedItems.length).toBeGreaterThan(0);
    expect(draft.suggestedItems.every((i) => i.tags.includes("suggested"))).toBe(true);
  });

  it("demo attribute fallback never emits diagnostics through grounding", () => {
    const sink = new DiagnosticCollector();
    const section = demoCharacterAttributeSection();
    groundAttributeValues(section.attributes, sink);
    groundAttributeRanges(section.ranges, sink);
    expect(sink.items).toEqual([]);
  });

  it("each section regenerates independently as a patch", async () => {
    const context = { prompt: "a harbor-master", userId: "user_1", findItems: noLibrary };
    const profile = await forgeCharacterSection("profile", context);
    expect(profile.name).toBeDefined();
    expect(profile.profile?.attributes).toBeUndefined();

    const attributes = await forgeCharacterSection("attributes", context);
    expect(attributes.name).toBeUndefined();
    expect(attributes.profile?.attributes?.length).toBeGreaterThan(0);

    const outfit = await forgeCharacterSection("outfit", context);
    expect(outfit.suggestedItems?.length).toBeGreaterThan(0);
    expect(outfit.profile?.defaultOutfit).toEqual([]);
  });

  it("records the degraded diagnostic from generateChecked", async () => {
    const sink = new DiagnosticCollector();
    await forgeCharacterSection("profile", { prompt: "x", userId: "user_1", sink, findItems: noLibrary });
    expect(sink.items.some((d) => d.code === "forge.character.profile.degraded")).toBe(true);
  });
});
