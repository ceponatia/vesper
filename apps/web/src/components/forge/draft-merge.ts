import type { CharacterDraft, CharacterForgeSection } from "@/lib/client/api";

/**
 * Per-section draft merging for forge regeneration
 * (docs/authoring/character-forge.md): a
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
        profile: { ...current.profile, outfits: incoming.profile.outfits },
        suggestedItems: incoming.suggestedItems,
      };
  }
}
