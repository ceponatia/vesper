import { describe, expect, it } from "vitest";
import {
  attributeRegistry,
  bodyLocationRegistry,
  characterProfileSchema,
  FEATURE_ATTRIBUTE_CATEGORIES,
  INTIMATE_ATTRIBUTE_CATEGORIES,
  itemDefinitionSchema,
  loreChunkCategorySchema,
  loreChunkTierSchema,
  loreChunkVisibilitySchema,
  worldLoreSchema,
  worldStyleSchema,
} from "@/contracts";
import { harborHouse, SEED_TAG } from "./harbor-house";

/**
 * Pure fixture validation: everything db-seed.ts inserts must already satisfy
 * the contracts registries, so a vocabulary change that breaks the seed fails
 * here instead of at seed time.
 */

const locationKeys = new Set(harborHouse.locations.map((l) => l.key));
const locationNames = new Set(harborHouse.locations.map((l) => l.name));
const itemByKey = new Map(harborHouse.items.map((i) => [i.key, i]));
const characterKeys = new Set(harborHouse.characters.map((c) => c.key));
const castCharacterKeys = new Set(harborHouse.cast.map((c) => c.characterKey));

// Registry attributes the fixture intentionally omits from the "covers
// everything" check: identity.species_presentation (both characters are human),
// intimate-anatomy attributes, and additive feature attributes — those are gated
// per character by the body-config/species feature list (not part of the
// universal vocabulary every character carries).
const OMITTED_ATTRIBUTE_IDS = new Set(["identity.species_presentation"]);
const isIntimateAttribute = (id: string): boolean => {
  const def = attributeRegistry.byId(id);
  return def ? (INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category) : false;
};
const isFeatureAttribute = (id: string): boolean => {
  const def = attributeRegistry.byId(id);
  return def ? (FEATURE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category) : false;
};

describe("harbor house characters", () => {
  it("every attribute value validates against the registry", () => {
    for (const character of harborHouse.characters) {
      for (const attr of character.attributes) {
        const result = attributeRegistry.parseValue(attr.id, attr.value);
        expect(result.ok, `${character.key} ${attr.id}: ${result.ok ? "" : result.issues.join("; ")}`).toBe(true);
      }
    }
  });

  it("covers the full registry vocabulary (minus documented omissions) without duplicates", () => {
    const allIds = attributeRegistry.definitions
      .map((d) => d.id)
      .filter((id) => !OMITTED_ATTRIBUTE_IDS.has(id) && !isIntimateAttribute(id) && !isFeatureAttribute(id));
    for (const character of harborHouse.characters) {
      const ids = character.attributes.map((a) => a.id);
      expect(new Set(ids).size, `${character.key} has duplicate attribute ids`).toBe(ids.length);
      const have = new Set<string>(ids);
      const missing = allIds.filter((id) => !have.has(id));
      expect(missing, `${character.key} missing: ${missing.join(", ")}`).toEqual([]);
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

  it("has a wardrobe spread: 10-15 clothing pieces, all layers, a sheer item, containers", () => {
    const clothing = harborHouse.items.filter((i) => i.kind === "clothing");
    expect(clothing.length).toBeGreaterThanOrEqual(10);
    expect(clothing.length).toBeLessThanOrEqual(15);
    const layers = new Set(clothing.map((i) => i.extras?.layer));
    for (const layer of [0, 1, 2, 3] as const) expect(layers.has(layer), `no layer-${layer} clothing`).toBe(true);
    expect(clothing.some((i) => i.extras?.opacity === "sheer")).toBe(true);
    expect(harborHouse.items.filter((i) => i.kind === "container").length).toBeGreaterThanOrEqual(2);
    expect(harborHouse.items.filter((i) => i.kind === "object").length).toBeGreaterThanOrEqual(3);
  });
});

describe("harbor house world graph", () => {
  it("has the six apartment locations and a connected link graph", () => {
    expect(harborHouse.locations).toHaveLength(6);
    for (const link of harborHouse.links) {
      expect(locationKeys.has(link.from), `link from unknown "${link.from}"`).toBe(true);
      expect(locationKeys.has(link.to), `link to unknown "${link.to}"`).toBe(true);
    }
    // Undirected connectivity (engine traverses links both ways).
    const adjacency = new Map<string, string[]>();
    for (const link of harborHouse.links) {
      adjacency.set(link.from, [...(adjacency.get(link.from) ?? []), link.to]);
      adjacency.set(link.to, [...(adjacency.get(link.to) ?? []), link.from]);
    }
    const [start] = harborHouse.locations;
    const seen = new Set<string>([start!.key]);
    const queue = [start!.key];
    while (queue.length > 0) {
      const next = queue.pop()!;
      for (const neighbor of adjacency.get(next) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    expect(seen.size, "location graph is not connected").toBe(harborHouse.locations.length);
  });

  it("cast entries resolve and include a companion", () => {
    expect(harborHouse.cast.length).toBeGreaterThanOrEqual(2);
    for (const entry of harborHouse.cast) {
      expect(characterKeys.has(entry.characterKey)).toBe(true);
      expect(locationKeys.has(entry.startLocationKey)).toBe(true);
    }
    expect(harborHouse.cast.some((c) => c.role === "companion")).toBe(true);
  });

  it("placements set exactly one target and resolve all keys", () => {
    for (const placement of harborHouse.placements) {
      expect(itemByKey.has(placement.itemKey), `placement of unknown item "${placement.itemKey}"`).toBe(true);
      const targets = [placement.locationKey, placement.castKey, placement.containerKey].filter((v) => v !== undefined);
      expect(targets, `${placement.itemKey} must have exactly one placement target`).toHaveLength(1);
      if (placement.locationKey) expect(locationKeys.has(placement.locationKey)).toBe(true);
      if (placement.castKey) expect(castCharacterKeys.has(placement.castKey)).toBe(true);
      if (placement.containerKey) {
        expect(itemByKey.get(placement.containerKey)?.kind, `${placement.itemKey} container target must be a container`).toBe("container");
        // the container itself must be placed somewhere
        expect(harborHouse.placements.some((p) => p.itemKey === placement.containerKey)).toBe(true);
      }
    }
    // every container placed in a room has at least one item inside
    for (const placement of harborHouse.placements) {
      if (itemByKey.get(placement.itemKey)?.kind !== "container") continue;
      expect(
        harborHouse.placements.some((p) => p.containerKey === placement.itemKey),
        `container "${placement.itemKey}" is empty`,
      ).toBe(true);
    }
  });
});

describe("harbor house style and lore", () => {
  it("style parses with directives and three norms", () => {
    const style = worldStyleSchema.parse(harborHouse.style);
    expect(style.directives.length).toBeGreaterThanOrEqual(3);
    expect(style.norms).toHaveLength(3);
  });

  it("world lore parses with factions and two plot anchors", () => {
    const charIdByKey = new Map(harborHouse.characters.map((c) => [c.key, `id-${c.key}`]));
    const lore = worldLoreSchema.parse({
      synopsis: harborHouse.synopsis,
      factions: harborHouse.factions.map((f) => ({
        ...f,
        memberCharacterIds: f.memberCharacterKeys.map((k) => charIdByKey.get(k) ?? k),
      })),
      plotAnchors: harborHouse.plotAnchors,
    });
    expect(lore.synopsis.length).toBeGreaterThan(80);
    expect(lore.plotAnchors).toHaveLength(2);
    expect(lore.plotAnchors.some((a) => a.priority === "active")).toBe(true);
  });

  it("lore chunks span tiers with two reachable secrets", () => {
    expect(harborHouse.loreChunks.length).toBeGreaterThanOrEqual(10);
    for (const chunk of harborHouse.loreChunks) {
      loreChunkTierSchema.parse(chunk.tier);
      loreChunkVisibilitySchema.parse(chunk.visibility);
      loreChunkCategorySchema.parse(chunk.category);
      for (const key of chunk.characterKeys ?? []) {
        expect(characterKeys.has(key), `lore "${chunk.title}" references unknown character "${key}"`).toBe(true);
      }
      // location tags are matched against the lowercased session-location name
      for (const tag of chunk.locationTags ?? []) {
        expect(tag).toBe(tag.toLowerCase());
        expect(
          [...locationNames].some((name) => name.toLowerCase() === tag),
          `lore "${chunk.title}" location tag "${tag}" matches no location name`,
        ).toBe(true);
      }
      // unlock tags are exact-match lowercase keys against fact tags
      for (const tag of chunk.unlockTags ?? []) expect(tag).toBe(tag.toLowerCase());
    }
    expect(harborHouse.loreChunks.filter((c) => c.tier === "always").length).toBeGreaterThanOrEqual(2);
    expect(harborHouse.loreChunks.filter((c) => c.tier === "scene").length).toBeGreaterThanOrEqual(2);
    expect(harborHouse.loreChunks.filter((c) => c.tier === "retrieval").length).toBeGreaterThanOrEqual(2);
    const secrets = harborHouse.loreChunks.filter((c) => c.visibility === "secret");
    expect(secrets).toHaveLength(2);
    for (const secret of secrets) {
      expect(secret.unlockTags?.length ?? 0, `secret "${secret.title}" needs unlock tags`).toBeGreaterThan(0);
    }
    const sorts = harborHouse.loreChunks.map((c) => c.sort);
    expect(new Set(sorts).size).toBe(sorts.length);
  });
});
