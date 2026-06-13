import { describe, expect, it } from "vitest";
import { worldDetailSchema } from "@/lib/client/api";
import { worldDetailToDraft } from "./world-detail-to-draft";

const detail = worldDetailSchema.parse({
  id: "w1",
  name: "Harborfall",
  description: "A drowned port.",
  locations: [
    { id: "loc1", name: "Quay", description: "Wet stone.", scale: "open", overrides: { area: "harbor" } },
    { id: "loc2", name: "Market" },
    { id: "loc3", name: "Lighthouse" },
  ],
  playerStartWorldLocationId: "loc2",
  links: [
    { id: "lnk1", fromWorldLocationId: "loc1", toWorldLocationId: "loc2" },
    { id: "lnk2", fromWorldLocationId: "loc3", toWorldLocationId: "loc1" },
    { id: "lnk3", fromWorldLocationId: "loc1", toWorldLocationId: "ghost" },
  ],
  cast: [
    {
      id: "cast1",
      characterId: "c9",
      name: "Maya",
      role: "companion",
      tier: "major",
      startWorldLocationId: "loc3",
      relationships: [
        { toward: "player", stage: "friendly" },
        { toward: "Tomas", stage: "close" },
      ],
    },
    { id: "cast2", characterId: "c10", name: "Tomas", role: "npc", tier: "minor" },
  ],
  items: [
    { id: "wi1", itemId: "i1", name: "Lantern", kind: "object", worldLocationId: "loc1" },
    { id: "wi2", itemId: "i2", name: "Oil coat", kind: "clothing", castId: "cast1", worn: true },
  ],
  loreChunks: [
    {
      id: "lore1",
      title: "The Flood",
      body: "It rose in a night.",
      tier: "always",
      visibility: "secret",
      unlockTags: ["flood"],
      manuallyUnlocked: true,
    },
  ],
});

describe("worldDetailToDraft", () => {
  const draft = worldDetailToDraft(detail);

  it("preserves row ids for diffing on save", () => {
    expect(draft.locations[0]?.id).toBe("loc1");
    expect(draft.loreChunks[0]?.id).toBe("lore1");
    expect(draft.castSuggestions[0]?.id).toBe("cast1");
    expect(draft.itemPlacements[0]?.id).toBe("wi1");
  });

  it("preserves the detail's location order (authored map order rides world_locations.sort)", () => {
    expect(draft.locations.map((l) => l.name)).toEqual(["Quay", "Market", "Lighthouse"]);
  });

  it("flattens link rows into undirected name links, dropping dangling ends", () => {
    expect(draft.locations[0]?.links.sort()).toEqual(["Lighthouse", "Market"]);
    expect(draft.locations[1]?.links).toEqual(["Quay"]);
    expect(draft.locations[2]?.links).toEqual(["Quay"]);
  });

  it("maps cast to suggestions with the library reference", () => {
    expect(draft.castSuggestions[0]).toMatchObject({
      existingCharacterId: "c9",
      name: "Maya",
      role: "companion",
      tier: "major",
      startLocationName: "Lighthouse",
    });
  });

  it("round-trips authored relationships (and defaults them when absent)", () => {
    expect(draft.castSuggestions[0]?.relationships).toEqual([
      { toward: "player", stage: "friendly" },
      { toward: "Tomas", stage: "close" },
    ]);
    expect(draft.castSuggestions[1]?.relationships).toEqual([]);
  });

  it("maps scale, overrides.area and the player start to draft fields", () => {
    expect(draft.locations[0]).toMatchObject({ scale: "open", area: "harbor" });
    expect(draft.locations[1]?.scale).toBe("room"); // defaulted, never absent
    expect(draft.locations[1]?.area).toBeUndefined();
    expect(draft.playerStartLocationName).toBe("Market");
  });

  it("maps item placements to location/cast names", () => {
    expect(draft.itemPlacements[0]).toMatchObject({ itemName: "Lantern", locationName: "Quay", worn: false });
    expect(draft.itemPlacements[1]).toMatchObject({ itemName: "Oil coat", castName: "Maya", worn: true });
    expect(draft.itemPlacements[1]?.definition.kind).toBe("clothing");
  });

  it("keeps lore chunk fields including manual unlock", () => {
    expect(draft.loreChunks[0]).toMatchObject({
      title: "The Flood",
      tier: "always",
      visibility: "secret",
      manuallyUnlocked: true,
    });
  });
});
