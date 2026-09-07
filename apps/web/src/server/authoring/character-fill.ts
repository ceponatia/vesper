import {
  DEFAULT_SPECIES_ID,
  diag,
  formatScheduleRhythm,
  hasVoiceAnchors,
  heritageFor,
  inferHeritageFromText,
  inferSpeciesFromText,
  speciesById,
  type AttributeValue,
  type DiagnosticSink,
} from "@/contracts";
import { characterSections, mergeFillScope, type CharacterSheetScope } from "@/lib/character-scopes";
import { isPlaceholderName, isPlayerRelationshipUnset, isSpeciesUnset, mergeFillDraft } from "@/lib/character-fill";
import {
  applyCharacterSectionPatch,
  forgeCharacterSection,
  type CharacterForgeContext,
  type CharacterForgeSection,
} from "./character-forge";
import type { CharacterDraft } from "./drafts";
import type { ClothingCandidateLookup, LibraryLookup } from "./library";

/**
 * Sheet fill: the in-sheet Forge. Runs the
 * existing forge section legs with the authored sheet rendered as a fixed
 * concept, then applies the fill-merge policy (lib/character-fill.ts) so
 * nothing the player entered ever changes — the merge is the guarantee, the
 * prompt directive just keeps the model from wasting effort restating it.
 */

const FILL_DIRECTIVE = [
  "This is a partially-authored character sheet. Every detail listed above is",
  "authored and FIXED — do not restate, alter, or contradict any of it.",
  "Generate only what is missing, consistent with the authored material.",
].join(" ");

function formatSheetValue(value: AttributeValue["value"]): string {
  return Array.isArray(value) ? value.join("+") : String(value);
}

/**
 * Render the authored sheet as compact concept lines — the shared source
 * material for the fill's fixed-concept prompt and the per-scope re-draft
 * prompts (character-redraft.ts). Empty for a blank sheet.
 */
export function renderSheetLines(draft: CharacterDraft): string[] {
  const p = draft.profile;
  const lines: string[] = [];
  if (p.creationBrief?.trim()) lines.push(`Original creation brief: ${p.creationBrief.trim()}`);
  if (!isPlaceholderName(draft.name)) lines.push(`Name: ${draft.name.trim()}`);
  const species = speciesById(p.speciesId);
  if (species && species.id !== DEFAULT_SPECIES_ID) {
    const heritage = p.heritageId ? heritageFor(species.id, p.heritageId) : undefined;
    lines.push(`Species: ${heritage ? `${species.label} (${heritage.label} heritage)` : species.label}`);
  }
  if (p.age.trim()) lines.push(`Age: ${p.age.trim()}`);
  if (p.bio.trim()) lines.push(`Bio: ${p.bio.trim()}`);
  if (p.personality.trim()) lines.push(`Personality: ${p.personality.trim()}`);
  if (p.voice?.trim()) lines.push(`Voice: ${p.voice.trim()}`);
  if (p.intimacy?.trim()) lines.push(`Intimate disposition: ${p.intimacy.trim()}`);
  if (p.microExemplars.length > 0) {
    lines.push(
      `Voice examples: ${p.microExemplars
        .map((m) => `${m.line.trim()}${m.situation.trim() ? ` (${m.situation.trim()})` : ""}`)
        .join(" | ")}`,
    );
  }
  if (hasVoiceAnchors(p.voiceAnchors)) {
    const va = p.voiceAnchors;
    const parts = [
      va.petPhrases.length > 0 ? `phrases: ${va.petPhrases.join(", ")}` : "",
      va.cadence.trim() ? `cadence: ${va.cadence.trim()}` : "",
      va.neverSays.length > 0 ? `never: ${va.neverSays.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`Voice anchors: ${parts.join("; ")}`);
  }
  if (p.aliases.length > 0) lines.push(`Aliases: ${p.aliases.join(", ")}`);
  if (draft.tags.length > 0) lines.push(`Library tags: ${draft.tags.join(", ")}`);
  if (p.tags.length > 0) lines.push(`Disposition tags: ${p.tags.join(", ")}`);
  if (p.preferences.length > 0) {
    lines.push(`Preferences: ${p.preferences.map((pref) => `${pref.valence}s ${pref.target} (${pref.intensity}/10)`).join("; ")}`);
  }
  if (p.drives.length > 0) {
    lines.push(
      `Drives: ${p.drives
        .map((d) => {
          const gate =
            d.secrecy === "secret"
              ? ` — reveal at ${d.revealBand ? `${d.revealBand.axis} "${d.revealBand.band}"` : 'familiarity "familiar"'}`
              : "";
          return `[${d.secrecy}${gate}] wants ${d.want}${d.why.trim() ? ` (${d.why.trim()})` : ""}`;
        })
        .join("; ")}`,
    );
  }
  if (p.traits.length > 0) lines.push(`Traits: ${p.traits.map((t) => `${t.id}=${t.value}`).join(", ")}`);
  if (p.schedule.length > 0) lines.push(`Daily rhythm: ${formatScheduleRhythm(p.schedule)}`);
  if (!isPlayerRelationshipUnset(p)) {
    const r = p.playerRelationship;
    const mask =
      r.presented?.lean === "masks_warmth" ? "; acts colder than she feels" : r.presented?.lean === "masks_dislike" ? "; acts warmer than she feels" : "";
    lines.push(
      `Starting relationship with the player: familiarity ${r.familiarity}, regard ${r.regard}${r.kind.trim() ? `, ${r.kind.trim()}` : ""}${r.history.trim() ? ` — ${r.history.trim()}` : ""}${mask}`,
    );
  }
  if (p.socialCards.length > 0) {
    lines.push(`Personal social cards: ${p.socialCards.map((c) => c.label).join("; ")}`);
  }
  if (p.attributes.length > 0) {
    lines.push(`Attributes: ${p.attributes.map((a) => `${a.id}=${formatSheetValue(a.value)}`).join(", ")}`);
  }
  if (p.outfits.some((o) => o.items.length > 0)) {
    const garments = p.outfits.reduce((n, o) => n + o.items.length, 0);
    lines.push(`Outfits: already authored (${p.outfits.length} preset${p.outfits.length === 1 ? "" : "s"}, ${garments} garments) — fixed.`);
  }
  return lines;
}

/**
 * The fill's concept text: the authored sheet followed by the fixed-content
 * directive. An empty sheet degrades to an invent-freely concept so a blank
 * character still forges.
 */
export function renderSheetConcept(draft: CharacterDraft): string {
  const lines = renderSheetLines(draft);
  if (lines.length === 0) {
    return "An original character. Nothing is authored yet — invent a compelling, grounded character freely.";
  }
  return [...lines, "", FILL_DIRECTIVE].join("\n");
}

/**
 * Adopt an inferred species while the body cluster is still at the blank-create
 * default ("a succubus barmaid" in the bio fills the species — that IS the
 * feature on an untouched sheet). Any authored body intent freezes the cluster;
 * mirrors the create-mode inference + the editor's species cascade.
 */
export function adoptInferredSpecies(draft: CharacterDraft, sink?: DiagnosticSink): CharacterDraft {
  if (!isSpeciesUnset(draft.profile)) return draft;
  const sheetText = [draft.name, draft.profile.bio, draft.profile.personality].join("\n");
  const species = inferSpeciesFromText(sheetText)?.species;
  if (!species || species.id === DEFAULT_SPECIES_ID) return draft;
  const heritage = inferHeritageFromText(species.id, sheetText);
  const groups = [...(species.defaultFeatureGroups ?? []), ...(heritage?.defaultFeatureGroups ?? [])];
  sink?.push(
    diag("info", "forge.character.fill.species_adopted", `adopted species "${species.id}" inferred from the sheet`, {
      context: { speciesId: species.id, heritageId: heritage?.id },
    }),
  );
  return {
    ...draft,
    profile: {
      ...draft.profile,
      speciesId: species.id,
      heritageId: heritage?.id,
      bodyPlanId: species.bodyPlanId,
      bodyFeatures: groups.length > 0 ? [...new Set(groups)] : undefined,
    },
  };
}

/**
 * The legs worth running for this sheet. Profile and attributes always run
 * (their merges are additive per field/id); the outfit leg is skipped entirely
 * when any garment is authored — an outfit is a coherent set, and the fill
 * would discard the result anyway (no spend on a leg we won't use).
 */
export function fillSectionsToRun(draft: CharacterDraft): CharacterForgeSection[] {
  const outfitAuthored = draft.profile.outfits.some((o) => o.items.length > 0) || draft.suggestedItems.length > 0;
  return outfitAuthored ? ["profile", "attributes"] : ["profile", "attributes", "outfit"];
}

export interface FillCharacterInput {
  draft: CharacterDraft;
  scope?: CharacterSheetScope;
  userId: string;
  sink?: DiagnosticSink;
  findItems?: LibraryLookup;
  listCandidates?: ClothingCandidateLookup;
  useFallbacks?: boolean;
}

/** Complete a partially-authored sheet: adopt species, run the legs, fill-merge. */
export async function forgeCharacterFill(input: FillCharacterInput): Promise<CharacterDraft> {
  const base = input.scope ? input.draft : adoptInferredSpecies(input.draft, input.sink);
  const context: CharacterForgeContext = {
    prompt: renderSheetConcept(base),
    scope: input.scope,
    userId: input.userId,
    sink: input.sink,
    draft: base,
    findItems: input.findItems,
    listCandidates: input.listCandidates,
    useFallbacks: input.useFallbacks,
  };
  const sections = input.scope ? characterSections[input.scope].legs : fillSectionsToRun(base);
  const patches = await Promise.all(sections.map((section) => forgeCharacterSection(section, context)));
  let generated = base;
  for (const patch of patches) generated = applyCharacterSectionPatch(generated, patch);
  return input.scope ? mergeFillScope(base, generated, input.scope) : mergeFillDraft(base, generated);
}
