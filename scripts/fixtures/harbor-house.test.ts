import { describe, expect, it } from "vitest";
import {
  attributeRegistry,
  bodyLocationRegistry,
  characterProfileSchema,
  itemDefinitionSchema,
} from "@/contracts";
import { harborHouse, SEED_TAG } from "./harbor-house";

/**
 * Pure fixture validation: the library content db-seed.ts inserts (characters,
 * items, locations) must already satisfy the contracts registries, so a
 * vocabulary change that breaks the seed fails here instead of at seed time.
 */

const locationNames = new Set(harborHouse.locations.map((l) => l.name));
const itemByKey = new Map(harborHouse.items.map((i) => [i.key, i]));

describe("harbor house characters", () => {
  // Coverage is automatic, not enumerated: every value a fixture sets is checked
  // against the registry, so new attribute vocabulary is exercised the moment a
  // character uses it — no per-field list to maintain here. (Attribute
  // *definitions* are separately validated by the registry-invariants test, so
  // a new field in the contracts is caught even when no fixture uses it yet.)
  // We intentionally do NOT require every character to populate every attribute:
  // that exhaustiveness check forced fixture churn on every vocabulary change.
  it("every attribute value validates against the registry, with no duplicate ids", () => {
    for (const character of harborHouse.characters) {
      const ids = character.attributes.map((a) => a.id);
      expect(new Set(ids).size, `${character.key} has duplicate attribute ids`).toBe(ids.length);
      for (const attr of character.attributes) {
        const result = attributeRegistry.parseValue(attr.id, attr.value);
        expect(result.ok, `${character.key} ${attr.id}: ${result.ok ? "" : result.issues.join("; ")}`).toBe(true);
      }
    }
  });

  it("profiles parse with schedules and outfits resolved", () => {
    for (const character of harborHouse.characters) {
      const profile = characterProfileSchema.parse({
        bio: character.bio,
        personality: character.personality,
        voice: character.voice,
        attributes: character.attributes,
        aliases: character.aliases,
        defaultOutfit: character.defaultOutfitKeys,
        schedule: character.schedule,
      });
      expect(profile.bio.length).toBeGreaterThan(40);
      expect(profile.personality.length).toBeGreaterThan(40);
      expect(profile.aliases.length).toBeGreaterThan(0);
      expect(profile.schedule.length).toBeGreaterThan(0);
      for (const entry of character.schedule) {
        expect(locationNames.has(entry.locationName), `${character.key} schedule: unknown location "${entry.locationName}"`).toBe(true);
      }
      for (const key of character.defaultOutfitKeys) {
        const item = itemByKey.get(key);
        expect(item, `${character.key} outfit references unknown item "${key}"`).toBeDefined();
        expect(item?.kind).toBe("clothing");
      }
    }
  });
});

describe("harbor house items", () => {
  it("composed item definitions parse and clothing coverage uses real body locations", () => {
    for (const item of harborHouse.items) {
      const definition = itemDefinitionSchema.parse({
        kind: item.kind,
        name: item.name,
        description: item.description,
        tags: [...(item.tags ?? []), SEED_TAG],
        ...item.extras,
      });
      if (item.kind === "clothing") {
        expect(definition.coverage.length, `${item.key} clothing needs coverage`).toBeGreaterThan(0);
        expect(definition.layer, `${item.key} clothing needs a layer`).toBeDefined();
        for (const loc of definition.coverage) {
          expect(bodyLocationRegistry.byId(loc), `${item.key} covers unknown body location "${loc}"`).toBeDefined();
        }
      }
    }
  });

  it("has a wardrobe spread: all layers, a sheer item, containers", () => {
    // Assert the qualitative spread the wardrobe system needs (every layer, a sheer
    // piece, containers/objects), not a brittle exact count — adding a garment to the
    // seed shouldn't fail the suite. A modest floor still guards against an empty set.
    const clothing = harborHouse.items.filter((i) => i.kind === "clothing");
    expect(clothing.length).toBeGreaterThanOrEqual(8);
    const layers = new Set(clothing.map((i) => i.extras?.layer));
    for (const layer of [0, 1, 2, 3] as const) expect(layers.has(layer), `no layer-${layer} clothing`).toBe(true);
    expect(clothing.some((i) => i.extras?.opacity === "sheer")).toBe(true);
    expect(harborHouse.items.filter((i) => i.kind === "container").length).toBeGreaterThanOrEqual(2);
    expect(harborHouse.items.filter((i) => i.kind === "object").length).toBeGreaterThanOrEqual(3);
  });
});

describe("harbor house locations", () => {
  it("has the six apartment locations", () => {
    expect(harborHouse.locations).toHaveLength(6);
    expect(new Set(harborHouse.locations.map((l) => l.key)).size).toBe(harborHouse.locations.length);
  });
});
