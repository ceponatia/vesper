import { z } from "zod";
import { isPersonalityAttributeId } from "@/contracts";
import { mergeFillDraft, type FillableDraft } from "./character-fill";

/** The editor, generation request, merge and section summary share this ownership. */
export const characterSheetScopes = ["profile", "attributes", "personality", "disposition", "outfit", "relationships"] as const;
export const characterSheetScopeSchema = z.enum(characterSheetScopes);
export type CharacterSheetScope = z.infer<typeof characterSheetScopeSchema>;
export const characterEditorTabs = [...characterSheetScopes, "portrait", "chat"] as const;
export type CharacterEditorTab = (typeof characterEditorTabs)[number];

type ProfileField = keyof FillableDraft["profile"];
interface CharacterSectionDefinition {
  label: string;
  fields: readonly ProfileField[];
  legs: readonly ("profile" | "attributes" | "outfit")[];
  profileOutput: readonly string[];
  attributes?: "body" | "expression";
  suggestedItems?: boolean;
}
export const characterSections = {
  profile: {
    label: "Profile", fields: ["bio", "schedule"], legs: ["profile"], profileOutput: ["bio", "schedule"],
  },
  attributes: {
    label: "Appearance", fields: ["intimateRegions"], legs: ["attributes"], profileOutput: [], attributes: "body",
  },
  personality: {
    label: "Voice & manner", fields: ["voice", "microExemplars", "voiceAnchors"], legs: ["profile", "attributes"],
    profileOutput: ["voice", "microExemplars", "voiceAnchors"], attributes: "expression",
  },
  disposition: {
    label: "Personality", fields: ["personality", "intimacy", "tags", "preferences", "traits", "drives", "socialCards"],
    legs: ["profile"], profileOutput: ["personality", "intimacy", "dispositionTags", "preferences", "traits", "drives", "cards"],
  },
  outfit: { label: "Outfit", fields: ["outfits"], legs: ["outfit"], profileOutput: [], suggestedItems: true },
  relationships: {
    label: "Relationships", fields: ["playerRelationship"], legs: ["profile"], profileOutput: ["playerRelationship"],
  },
} as const satisfies Record<CharacterSheetScope, CharacterSectionDefinition>;

export function sectionOwnsAttribute(scope: CharacterSheetScope, id: string): boolean {
  const section: CharacterSectionDefinition = characterSections[scope];
  if (!section.attributes) return false;
  return isPersonalityAttributeId(id) === (section.attributes === "expression");
}

/** Count authored details rather than claiming an optional section is objectively complete. */
export function characterSectionDetailCount(draft: FillableDraft, scope: CharacterSheetScope): number {
  const section: CharacterSectionDefinition = characterSections[scope];
  const count = (value: unknown): number => {
    if (typeof value === "string") return value.trim() ? 1 : 0;
    if (Array.isArray(value)) return value.length;
    return 0;
  };
  const detailCount = section.fields.reduce((total, field) => {
    if (field === "voiceAnchors") {
      const v = draft.profile.voiceAnchors;
      return total + count(v.cadence) + count(v.petPhrases) + count(v.neverSays);
    }
    if (field === "playerRelationship") {
      const r = draft.profile.playerRelationship;
      return total + Number(r.familiarity !== "strangers" || r.regard !== "neutral" || !!r.kind.trim()
        || !!r.history.trim() || !!r.note.trim() || !!r.presented || r.looming);
    }
    if (field === "outfits") return total + draft.profile.outfits.reduce((n, outfit) => n + outfit.items.length, 0);
    return total + count(draft.profile[field]);
  }, 0);
  return detailCount + draft.profile.attributes.filter((a) => sectionOwnsAttribute(scope, a.id)).length
    + (section.suggestedItems ? draft.suggestedItems.length : 0);
}

/** Rewrite only the visible section. Identity and the creation brief are never rewritten. */
export function mergeRedraftScope<T extends FillableDraft>(base: T, incoming: FillableDraft, scope: CharacterSheetScope): T {
  const section: CharacterSectionDefinition = characterSections[scope];
  const profile = { ...base.profile };
  for (const field of section.fields) {
    // Established anatomy remains a constraint on generation, even for a rewrite.
    if (field === "intimateRegions" && base.profile.intimateRegions.length > 0) continue;
    Object.assign(profile, { [field]: incoming.profile[field] });
  }
  if (section.attributes) {
    profile.attributes = [
      ...base.profile.attributes.filter((a) => !sectionOwnsAttribute(scope, a.id)),
      ...incoming.profile.attributes.filter((a) => sectionOwnsAttribute(scope, a.id)),
    ];
  }
  return { ...base, profile, ...(section.suggestedItems ? { suggestedItems: incoming.suggestedItems } : {}) };
}

/** Fill obeys the same section boundary, then preserves every authored field/id. */
export function mergeFillScope<T extends FillableDraft>(base: T, incoming: FillableDraft, scope: CharacterSheetScope): T {
  return mergeFillDraft(base, mergeRedraftScope(base, incoming, scope));
}
