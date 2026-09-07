import { z } from "zod";
import { attributeRegistry, traitRegistry } from "@/contracts";
import { characterEditorTabs } from "@/lib/character-scopes";
import { characterDraftSchema, emptyCharacterDraft, type CharacterDraft } from "@/lib/client/api";
import { characterReviewStateSchema, describeProposalValue, emptyCharacterReview } from "./character-proposals";

export const characterCreationStateSchema = z.object({
  id: z.string(),
  savedCharacterId: z.string().nullable().default(null),
  draft: characterDraftSchema,
  prompt: z.string(),
  tab: z.enum(characterEditorTabs).catch("profile"),
  review: characterReviewStateSchema,
});
export type CharacterCreationState = z.infer<typeof characterCreationStateSchema>;
export const emptyCharacterCreation = (): CharacterCreationState => ({ id: crypto.randomUUID(), savedCharacterId: null, draft: emptyCharacterDraft(), prompt: "", tab: "profile", review: emptyCharacterReview() });

/** Capture the original concept before any rewriting can remove it. This also
 * covers manually authored and legacy saved characters with no prompt history. */
export function withCreationBrief(draft: CharacterDraft, prompt = ""): CharacterDraft {
  if (draft.profile.creationBrief.trim()) return draft;
  const { attributes, traits, ...profile } = draft.profile;
  const attributeNotes = attributes.map((row) => `${attributeRegistry.byId(row.id)?.label ?? row.id}: ${describeProposalValue(row.value)}`).join("; ");
  const traitNotes = traits.map((row) => `${traitRegistry.byId(row.id)?.label ?? row.id}: ${row.value}`).join("; ");
  const brief = prompt.trim() || `Original authored details\nName: ${draft.name}\n${describeProposalValue({ ...profile, creationBrief: undefined })}\nAttributes: ${attributeNotes}\nTraits: ${traitNotes}\nSuggested outfit: ${describeProposalValue(draft.suggestedItems)}`;
  return { ...draft, profile: { ...draft.profile, creationBrief: brief } };
}

/** Initial Forge can use the editable preview as review, but only for a truly
 * untouched draft. Brief capture itself is not an authored field change. */
export function isPristineCharacterDraft(draft: CharacterDraft): boolean {
  return JSON.stringify({ ...draft, profile: { ...draft.profile, creationBrief: "" } }) === JSON.stringify(emptyCharacterDraft());
}
