import type { DiagnosticSink } from "@/contracts";
import { mergeRedraftScope, type CharacterSheetScope } from "@/lib/character-scopes";
import {
  applyCharacterSectionPatch,
  forgeCharacterSection,
  type CharacterForgeContext,
  type CharacterForgeSection,
} from "./character-forge";
import { renderSheetLines } from "./character-fill";
import type { CharacterDraft } from "./drafts";
import type { ClothingCandidateLookup, LibraryLookup } from "./library";

/**
 * Per-tab Re-draft (character-sheet-forge.plan.md): rewrite ONE tab's fields
 * from the whole sheet, formatted for the narrator — personality prose moves
 * out of the bio, attributes derive from what the other tabs say. Reuses the
 * forge legs with a scope-specific directive; the scope merge
 * (lib/character-scopes.ts) is the guarantee that only the target tab changes
 * and that player-set (`manual`) attribute/trait values survive, conflicts
 * reported rather than applied.
 */

/** The LLM leg that produces each scope's fields. */
const SCOPE_LEG: Record<CharacterSheetScope, CharacterForgeSection> = {
  profile: "profile",
  disposition: "profile",
  attributes: "attributes",
  personality: "attributes",
  outfit: "outfit",
};

const REDRAFT_DIRECTIVES: Record<CharacterSheetScope, string> = {
  profile: [
    "You are RE-DRAFTING this character's basic profile — bio, personality sketch, voice notes, real age, aliases, library tags —",
    "from the whole sheet above. Rewrite those fields cleanly for the game's narrator: the bio holds background and situation",
    "(no personality analysis, no physical description), the personality sketch holds temperament, quirks, humor, and flaws",
    "(no backstory), voice notes describe how they sound and speak. Move misplaced material into its correct field.",
    "Preserve every authored fact and the core concept; do not invent major new facts.",
  ].join(" "),
  disposition: [
    "You are RE-DRAFTING this character's social disposition — dispositionTags, preferences, and trait scalars — by reading",
    "them off the authored personality, bio, and the rest of the sheet above. Emit the complete disposition as it should now",
    "stand; it replaces the current one.",
  ].join(" "),
  attributes: [
    "You are RE-DRAFTING this character's physical appearance attributes from the whole sheet above (bio, personality,",
    "species). Emit the complete attribute picture as it should now stand — definite values where the sheet supports them,",
    "ranges for unsettled [CORE] attributes.",
  ].join(" "),
  personality: [
    "You are RE-DRAFTING this character's expression-and-bearing attributes — the voice.*, presentation.*, and movement.*",
    "categories ONLY — from the whole sheet above. Emit values only in those categories; every other category is off-limits.",
  ].join(" "),
  outfit: [
    "You are RE-DRAFTING this character's default outfit from the whole sheet above. Design the outfit as it should now",
    "stand; it replaces the current one.",
  ].join(" "),
};

/** Scopes whose target fields carry provenance — their manual values get a FIXED line. */
function manualFixedLine(draft: CharacterDraft, scope: CharacterSheetScope): string | undefined {
  const values =
    scope === "disposition"
      ? draft.profile.traits.filter((t) => t.source === "manual").map((t) => `${t.id}=${t.value}`)
      : scope === "attributes" || scope === "personality"
        ? draft.profile.attributes
            .filter((a) => a.source === "manual")
            .map((a) => `${a.id}=${Array.isArray(a.value) ? a.value.join("+") : String(a.value)}`)
        : [];
  if (values.length === 0) return undefined;
  return `Player-set values (FIXED — keep or omit them, never change them): ${values.join(", ")}`;
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
  const fixed = manualFixedLine(draft, scope);
  const prompt = [...renderSheetLines(draft), "", REDRAFT_DIRECTIVES[scope], ...(fixed ? [fixed] : [])].join("\n");
  const context: CharacterForgeContext = {
    prompt,
    userId: input.userId,
    sink: input.sink,
    draft,
    findItems: input.findItems,
    listCandidates: input.listCandidates,
    useFallbacks: input.useFallbacks,
  };
  const patch = await forgeCharacterSection(SCOPE_LEG[scope], context);
  const incoming = applyCharacterSectionPatch(draft, patch);
  return mergeRedraftScope(draft, incoming, scope, input.sink);
}
