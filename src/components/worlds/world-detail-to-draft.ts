import type { WorldDetail, WorldDraft } from "@/lib/client/api";

/**
 * Map a saved world (API detail shape) into the editable draft shape so
 * /worlds/:id/edit reuses the forge review UI (docs/authoring.md). Row ids are
 * preserved so the server can diff on save; the link rows are flattened onto
 * each location as undirected name links.
 */
export function worldDetailToDraft(detail: WorldDetail): WorldDraft {
  const locationNameById = new Map(detail.locations.map((loc) => [loc.id, loc.name]));

  const linksFor = (locationId: string): string[] => {
    const names = new Set<string>();
    for (const link of detail.links) {
      if (link.fromWorldLocationId === locationId) {
        const name = locationNameById.get(link.toWorldLocationId);
        if (name) names.add(name);
      } else if (link.toWorldLocationId === locationId) {
        const name = locationNameById.get(link.fromWorldLocationId);
        if (name) names.add(name);
      }
    }
    return [...names];
  };

  const castNameById = new Map(detail.cast.map((member) => [member.id, member.name]));

  return {
    name: detail.name,
    description: detail.description,
    style: detail.style,
    lore: detail.lore,
    playerStartLocationName: detail.playerStartWorldLocationId
      ? locationNameById.get(detail.playerStartWorldLocationId)
      : undefined,
    locations: detail.locations.map((loc) => ({
      id: loc.id,
      locationId: loc.locationId ?? undefined,
      name: loc.name,
      description: loc.description,
      ambient: loc.ambient,
      scale: loc.scale,
      // area is world-placement data, so it only ever rides in overrides
      area: loc.overrides.area,
      tags: loc.tags,
      links: linksFor(loc.id),
    })),
    loreChunks: detail.loreChunks.map((chunk) => ({
      id: chunk.id,
      title: chunk.title,
      body: chunk.body,
      category: chunk.category,
      tier: chunk.tier,
      visibility: chunk.visibility,
      unlockTags: chunk.unlockTags,
      locationTags: chunk.locationTags,
      manuallyUnlocked: chunk.manuallyUnlocked,
    })),
    castSuggestions: detail.cast.map((member) => ({
      id: member.id,
      existingCharacterId: member.characterId ?? undefined,
      name: member.name,
      conceptNote: "",
      role: member.role,
      tier: member.tier,
      startLocationName: member.startWorldLocationId
        ? locationNameById.get(member.startWorldLocationId)
        : undefined,
      relationships: member.relationships,
    })),
    itemPlacements: detail.items.map((item) => ({
      id: item.id,
      itemName: item.name,
      definition: {
        kind: item.kind,
        name: item.name,
        description: "",
        coverage: [],
        opacity: "opaque",
        sensory: {},
        fields: {},
        tags: [],
      },
      locationName: item.worldLocationId ? locationNameById.get(item.worldLocationId) : undefined,
      castName: item.castId ? castNameById.get(item.castId) : undefined,
      worn: item.worn,
      quantity: item.quantity,
    })),
  };
}
