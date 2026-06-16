import type {
  CharacterDraft,
  CharacterForgeSection,
  WorldDraft,
  WorldForgeSection,
} from "@/lib/client/api";

/**
 * Per-section draft merging for forge regeneration (docs/authoring.md): a
 * section re-run replaces only its own slice of the draft, whether the server
 * returned a full draft or just the section's contribution. Field→section
 * mapping mirrors server/authoring's section patches.
 */

export function mergeCharacterSection(
  current: CharacterDraft,
  incoming: CharacterDraft,
  section: CharacterForgeSection,
): CharacterDraft {
  switch (section) {
    case "profile":
      return {
        ...current,
        name: incoming.name || current.name,
        tags: incoming.tags,
        profile: {
          ...current.profile,
          bio: incoming.profile.bio,
          personality: incoming.profile.personality,
          voice: incoming.profile.voice,
          aliases: incoming.profile.aliases,
          speciesId: incoming.profile.speciesId,
          heritageId: incoming.profile.heritageId,
          bodyPlanId: incoming.profile.bodyPlanId,
          bodyFeatures: incoming.profile.bodyFeatures,
        },
      };
    case "attributes":
      return {
        ...current,
        profile: { ...current.profile, attributes: incoming.profile.attributes },
      };
    case "outfit":
      return {
        ...current,
        profile: { ...current.profile, defaultOutfit: incoming.profile.defaultOutfit },
        suggestedItems: incoming.suggestedItems,
      };
  }
}

export function mergeWorldSection(current: WorldDraft, incoming: WorldDraft, section: WorldForgeSection): WorldDraft {
  switch (section) {
    case "premise":
      return {
        ...current,
        name: incoming.name || current.name,
        description: incoming.description,
        style: incoming.style,
        lore: incoming.lore,
      };
    case "locations":
      // The locations agent also picks the player start (a location name);
      // like the server patch, an unset incoming value never clears it.
      return {
        ...current,
        locations: incoming.locations,
        playerStartLocationName: incoming.playerStartLocationName ?? current.playerStartLocationName,
      };
    case "lore":
      return { ...current, loreChunks: incoming.loreChunks };
    case "cast":
      return { ...current, castSuggestions: incoming.castSuggestions };
    case "items":
      return { ...current, itemPlacements: incoming.itemPlacements };
  }
}
