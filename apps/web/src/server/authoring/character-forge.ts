import { inferSpeciesFromText } from "@/contracts";
import { emptyCharacterDraft, type CharacterDraft } from "./drafts";
import { forgeAttributesSection } from "./character-forge/attributes";
import { forgeOutfitSection } from "./character-forge/outfit";
import { forgeProfileSection } from "./character-forge/profile";
import {
  characterForgeSections,
  type CharacterForgeContext,
  type CharacterForgeSection,
  type CharacterSectionPatch,
  type ForgeCharacterInput,
} from "./character-forge/types";

/**
 * Character forge: three independent sections run in parallel and contribute
 * patches in stable profile, attributes, outfit order. The forge returns a
 * draft; it never saves.
 */

export {
  buildAttributeSectionSchema,
  characterAttributeDefinitions,
  conformAttributesToBody,
  describeConstraint,
  fillSpeciesRequiredDefaults,
  fillVisualDefaults,
  groundAttributeRanges,
  groundAttributeValues,
} from "./character-forge/attributes";
export type { AttributeSection, RawAttributeEntry, RawAttributeRange } from "./character-forge/attributes";
export {
  demoCharacterAttributeSection,
  demoCharacterOutfitSection,
  demoCharacterProfileSection,
} from "./character-forge/demo";
export {
  groundOutfitItems,
  matchOutfitAgainstLibrary,
  partitionOutfitReuse,
} from "./character-forge/outfit";
export type { OutfitItem, OutfitReusePartition, OutfitSection } from "./character-forge/outfit";
export {
  groundDrives,
  groundMicroExemplars,
  groundPlayerRelationship,
  groundSchedule,
  groundSocialCards,
  groundVoiceAnchors,
} from "./character-forge/profile";
export { characterForgeSections, characterForgeSectionSchema } from "./character-forge/types";
export type {
  CharacterForgeContext,
  CharacterForgeSection,
  CharacterSectionPatch,
  ForgeCharacterInput,
} from "./character-forge/types";

export function applyCharacterSectionPatch(draft: CharacterDraft, patch: CharacterSectionPatch): CharacterDraft {
  return {
    name: patch.name ?? draft.name,
    tags: patch.tags ?? draft.tags,
    suggestedItems: patch.suggestedItems ?? draft.suggestedItems,
    profile: { ...draft.profile, ...(patch.profile ?? {}) },
  };
}

export async function forgeCharacter(input: ForgeCharacterInput): Promise<CharacterDraft> {
  const context: CharacterForgeContext = { ...input, inferredSpecies: inferSpeciesFromText(input.prompt)?.species };
  const patches = await Promise.all(characterForgeSections.map((section) => forgeCharacterSection(section, context)));
  let draft = emptyCharacterDraft();
  for (const patch of patches) draft = applyCharacterSectionPatch(draft, patch);
  return draft;
}

export async function forgeCharacterSection(
  section: CharacterForgeSection,
  context: CharacterForgeContext,
): Promise<CharacterSectionPatch> {
  switch (section) {
    case "profile":
      return forgeProfileSection(context);
    case "attributes":
      return forgeAttributesSection(context);
    case "outfit":
      return forgeOutfitSection(context);
  }
}
