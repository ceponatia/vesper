import { z } from "zod";
import {
  diag,
  isPersonalityAttributeCategory,
  realizeBody,
  type AttributeDefinition,
  type AttributeValue,
  type DiagnosticSink,
} from "@/contracts";
import { generateChecked, visionModelId, type GenerateImagePart } from "@/server/ai";
import {
  characterAttributeDefinitions,
  describeConstraint,
  groundAttributeValues,
  type RawAttributeEntry,
} from "./character-forge";
import type { CharacterDraft } from "./drafts";

/**
 * Portrait → attributes (character-sheet-forge.plan.md slice 3): a vision
 * model reads the character's generated portrait and proposes appearance
 * attributes — the codebase's first image-understanding capability. Strictly
 * appearance: personality-tab categories (voice/presentation/movement) can't
 * be seen in a still image and are excluded, as is everything intimate (the
 * avatar pipeline never renders it). Fill-blanks only: an id the sheet already
 * has keeps its value; a disagreement is REPORTED as a conflict diagnostic,
 * never applied.
 */

const PORTRAIT_SYSTEM = [
  "You extract a character's visible physical attributes from a portrait image into a fixed vocabulary.",
  "Use only the listed attribute ids and allowed values.",
  "Emit ONLY what the image clearly shows — omit anything uncertain, occluded, or out of frame.",
  "Never infer personality, backstory, or anything not literally visible.",
].join("\n");

function realizedBodyFor(draft: CharacterDraft) {
  const p = draft.profile;
  return realizeBody({
    speciesId: p.speciesId,
    heritageId: p.heritageId,
    bodyPlanId: p.bodyPlanId,
    intimateRegions: p.intimateRegions,
    bodyFeatures: p.bodyFeatures,
  });
}

/** The attribute definitions a portrait may speak to, for THIS draft's realized body. */
export function portraitAttributeDefinitions(
  draft: CharacterDraft,
  realizedBody = realizedBodyFor(draft),
): readonly AttributeDefinition[] {
  // characterAttributeDefinitions already excludes intimate categories and
  // gates feature categories on the realized body; the portrait additionally
  // excludes the personality-tab categories (not visible in a still image).
  return characterAttributeDefinitions({ prompt: "", userId: "", draft }).filter(
    (d) => !isPersonalityAttributeCategory(d.category) && realizedBody.isAttributeApplicable(d),
  );
}

interface PortraitSection {
  attributes: RawAttributeEntry[];
}

function buildPortraitSchema(definitions: readonly AttributeDefinition[]): z.ZodType<PortraitSection> {
  const ids = definitions.map((d) => d.id as string);
  const idSchema = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string().min(1);
  return z.object({
    attributes: z
      .array(
        z.object({
          id: idSchema,
          value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]),
        }),
      )
      .default([]),
  });
}

function portraitPrompt(definitions: readonly AttributeDefinition[]): string {
  const vocabulary = definitions.map((def) => `- ${def.id} (${describeConstraint(def)}): ${def.description}`).join("\n");
  return [
    "This is the character's portrait. Read the visible physical attributes off the image.",
    "",
    "Attribute vocabulary:",
    vocabulary,
    "",
    "Emit a definite value for every attribute the image clearly shows; omit the rest.",
  ].join("\n");
}

export interface PortraitAttributesInput {
  draft: CharacterDraft;
  image: GenerateImagePart;
  sink?: DiagnosticSink;
}

/**
 * Read the portrait and fill in unset appearance attributes. Existing values
 * (any provenance) are never changed; a portrait reading that disagrees with
 * one lands as a `portrait_conflict` diagnostic for the player to act on.
 * Degrades to a no-op draft (with the generateChecked diagnostic) — never a
 * failed request, and never invented demo content: a fabricated "reading" of
 * an image nobody looked at would be worse than nothing.
 */
export async function derivePortraitAttributes(input: PortraitAttributesInput): Promise<CharacterDraft> {
  const { draft, sink } = input;
  const realizedBody = realizedBodyFor(draft);
  const definitions = portraitAttributeDefinitions(draft, realizedBody);
  const { value } = await generateChecked({
    schema: buildPortraitSchema(definitions),
    system: PORTRAIT_SYSTEM,
    prompt: portraitPrompt(definitions),
    images: [input.image],
    modelId: visionModelId(),
    code: "forge.character.portrait",
    sink,
  });
  const section = value ?? { attributes: [] };
  // The realized body also gates grounding, so a reading outside the resolved
  // species' narrowed value set drops instead of violating a species rule.
  const grounded = groundAttributeValues(section.attributes, sink, "forge.character.portrait", realizedBody);
  return mergePortraitReadings(draft, grounded, sink);
}

/**
 * Pure fill-blanks merge for grounded portrait readings: a reading for an
 * unset id lands; a reading that disagrees with ANY existing value (manual or
 * creation) becomes a `portrait_conflict` diagnostic and is not applied.
 */
export function mergePortraitReadings(
  draft: CharacterDraft,
  readings: readonly AttributeValue[],
  sink?: DiagnosticSink,
): CharacterDraft {
  const existing = new Map(draft.profile.attributes.map((a) => [a.id, a]));
  const additions: AttributeValue[] = [];
  for (const read of readings) {
    const current = existing.get(read.id);
    if (!current) {
      additions.push(read);
      continue;
    }
    if (JSON.stringify(current.value) !== JSON.stringify(read.value)) {
      sink?.push(
        diag(
          "info",
          "forge.character.portrait.portrait_conflict",
          `portrait shows ${read.id} = ${formatValue(read.value)}; the sheet has ${formatValue(current.value)} (kept)`,
          { context: { id: read.id, portrait: read.value, sheet: current.value } },
        ),
      );
    }
  }
  if (additions.length === 0) return draft;
  return { ...draft, profile: { ...draft.profile, attributes: [...draft.profile.attributes, ...additions] } };
}

function formatValue(value: AttributeValue["value"]): string {
  return Array.isArray(value) ? value.join("+") : String(value);
}
