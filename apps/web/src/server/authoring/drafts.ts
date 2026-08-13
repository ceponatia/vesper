import { z } from "zod";
import { characterProfileSchema, emptyCharacterProfile, itemDefinitionSchema } from "@/contracts";

/**
 * Forge drafts (docs/authoring.md): plain JSON the AI fills and the human
 * edits. Every field is defaulted so a partial draft is always schema-valid —
 * a failed forge section simply leaves its slice at the default.
 */

export const characterDraftSchema = z.object({
  name: z.string().default(""),
  profile: characterProfileSchema.default(() => emptyCharacterProfile()),
  tags: z.array(z.string()).default([]),
  /** Unmatched outfit suggestions, tagged "suggested"; saved as new library items. */
  suggestedItems: z.array(itemDefinitionSchema).default([]),
});

export type CharacterDraft = z.infer<typeof characterDraftSchema>;

export function emptyCharacterDraft(): CharacterDraft {
  return characterDraftSchema.parse({});
}
