import type { DiagnosticSink } from "@/contracts";
import { characterSections, mergeRedraftScope, type CharacterSheetScope } from "@/lib/character-scopes";
import {
  applyCharacterSectionPatch,
  forgeCharacterSection,
  type CharacterForgeContext,
} from "./character-forge";
import { renderSheetLines } from "./character-fill";
import type { CharacterDraft } from "./drafts";
import type { ClothingCandidateLookup, LibraryLookup } from "./library";

/** Scoped rewrite requests only the registry-owned fields; merge enforces the boundary. */
function rewriteDirective(scope: CharacterSheetScope): string {
  const section = characterSections[scope];
  return [
    `Rewrite the ${section.label} section from the character sheet and original creation brief above.`,
    `Return only this section's fields: ${section.fields.join(", ")}${"attributes" in section ? ", " + section.attributes + " attributes" : ""}.`,
    "Preserve the character's core facts, species, body, name, age and authored identity; do not invent a new character.",
    "Existing values in this section may be revised. Unrelated sections must remain unchanged.",
  ].join(" ");
}

export interface RedraftCharacterInput {
  draft: CharacterDraft;
  scope: CharacterSheetScope;
  userId: string;
  sink?: DiagnosticSink;
  findItems?: LibraryLookup;
  listCandidates?: ClothingCandidateLookup;
  useFallbacks?: boolean;
}

/** Re-draft one scope of the sheet; returns the full draft with only that scope rewritten. */
export async function redraftCharacterScope(input: RedraftCharacterInput): Promise<CharacterDraft> {
  const { draft, scope } = input;
  const prompt = [...renderSheetLines(draft), "", rewriteDirective(scope)].join("\n");
  const context: CharacterForgeContext = {
    prompt,
    scope,
    userId: input.userId,
    sink: input.sink,
    draft,
    findItems: input.findItems,
    listCandidates: input.listCandidates,
    useFallbacks: input.useFallbacks,
  };
  const patches = await Promise.all(characterSections[scope].legs.map((leg) => forgeCharacterSection(leg, context)));
  let incoming = draft;
  for (const patch of patches) incoming = applyCharacterSectionPatch(incoming, patch);
  return mergeRedraftScope(draft, incoming, scope);
}
