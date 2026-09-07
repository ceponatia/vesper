import {
  heritageFor,
  inferHeritageFromText,
  inferSpeciesFromText,
  realizeBody,
  speciesById,
  type HeritageDefinition,
  type RealizedBody,
  type SpeciesDefinition,
} from "@/contracts";
import type { CharacterForgeContext } from "./types";

export function speciesForForgeContext(context: CharacterForgeContext): SpeciesDefinition | undefined {
  if (context.draft) return speciesById(context.draft.profile.speciesId) ?? context.inferredSpecies;
  return context.inferredSpecies ?? inferSpeciesFromText(context.prompt)?.species;
}

/**
 * The heritage/subtype within the resolved species — the draft's stored
 * `heritageId` when editing, else inferred from the prompt ("a drow ranger" →
 * dark_elf), then the species default when inference is silent. Scoped to the
 * resolved species so a selected overlay can never belong to a different one.
 */
export function heritageForForgeContext(context: CharacterForgeContext): HeritageDefinition | undefined {
  const species = speciesForForgeContext(context);
  if (!species) return undefined;
  const draftId = context.draft?.profile.heritageId;
  if (draftId) return heritageFor(species.id, draftId);
  return inferHeritageFromText(species.id, context.prompt) ?? heritageFor(species.id, undefined);
}

/**
 * The realized body the forge grounds against. A prompt that names no species
 * realizes the default one — the body's anatomy gating (chest build vs breast
 * size) has to hold for a plain human concept too, and the default species
 * carries no rules or feature groups, so nothing else moves. `intimateRegions`
 * overrides the draft's stored body-config: the attribute section passes the
 * config its own grounded values SEED (gender's `activatesGroups`), so
 * anatomy-gated fills land on the body the draft will actually carry rather
 * than the empty config a fresh forge starts from.
 */
export function realizedBodyForForgeContext(context: CharacterForgeContext, intimateRegions?: readonly string[]): RealizedBody {
  const species = speciesForForgeContext(context);
  return realizeBody({
    speciesId: species?.id,
    heritageId: heritageForForgeContext(context)?.id,
    bodyPlanId: context.draft?.profile.bodyPlanId ?? species?.bodyPlanId,
    intimateRegions: intimateRegions ?? context.draft?.profile.intimateRegions,
    bodyFeatures: context.draft?.profile.bodyFeatures,
  });
}

/**
 * The species/heritage line shared by the profile and attribute prompts: the
 * label (with the heritage in parens) plus the combined generic appearance.
 * Empty `label`-only when nothing extra is authored.
 */
export function speciesForgeDescriptor(
  species: SpeciesDefinition,
  heritage: HeritageDefinition | undefined,
): { label: string; look: string } {
  const label = heritage ? `${species.label} (${heritage.label} heritage)` : species.label;
  const look = [species.appearance, heritage?.appearance ?? ""].map((p) => p.trim()).filter(Boolean).join(" ");
  return { label, look: look ? ` ${look}` : "" };
}
