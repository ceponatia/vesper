import { z } from "zod";
import {
  diag,
  isIntimateAttributeCategory,
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
 * Portrait → attributes: a vision
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
  // characterAttributeDefinitions gates feature categories on the realized body
  // and admits the render-visual intimate size (breasts.size) so a concept can
  // state it; the portrait excludes everything intimate — the avatar pipeline
  // never renders it — and the personality-tab categories (not visible in a
  // still image).
  return characterAttributeDefinitions({ prompt: "", userId: "", draft }).filter(
    (d) =>
      !isIntimateAttributeCategory(d.category) &&
      !isPersonalityAttributeCategory(d.category) &&
      realizedBody.isAttributeApplicable(d),
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

/** One portrait-vs-sheet disagreement — the review dialog's row (followups ruling 2). */
export interface PortraitConflict {
  id: string;
  current: AttributeValue["value"];
  proposed: AttributeValue["value"];
}

export interface PortraitAttributesResult {
  draft: CharacterDraft;
  /** Disagreements with existing values — NOT applied; the review dialog offers them. */
  conflicts: PortraitConflict[];
  /** The unset ids the reading filled (source "creation"). */
  filled: AttributeValue[];
}

/**
 * Read the portrait and fill in unset appearance attributes. Existing values
 * (any provenance) are never changed by the run itself; a disagreement comes
 * back as a STRUCTURED conflict (plus a `portrait_conflict` diagnostic) so the
 * client's "Review portrait changes" dialog can offer each as current →
 * proposed with per-row accept (followups ruling 2). Degrades to a no-op
 * result — never a failed request, and never invented demo content: a
 * fabricated "reading" of an image nobody looked at would be worse than
 * nothing.
 */
export async function derivePortraitAttributes(input: PortraitAttributesInput): Promise<PortraitAttributesResult> {
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
 * unset id lands (`filled`); a reading that disagrees with ANY existing value
 * (manual or creation) is returned as a structured conflict — and reported —
 * never applied here.
 */
export function mergePortraitReadings(
  draft: CharacterDraft,
  readings: readonly AttributeValue[],
  sink?: DiagnosticSink,
): PortraitAttributesResult {
  const existing = new Map(draft.profile.attributes.map((a) => [a.id, a]));
  const additions: AttributeValue[] = [];
  const conflicts: PortraitConflict[] = [];
  for (const read of readings) {
    const current = existing.get(read.id);
    if (!current) {
      additions.push(read);
      continue;
    }
    if (JSON.stringify(current.value) !== JSON.stringify(read.value)) {
      conflicts.push({ id: read.id, current: current.value, proposed: read.value });
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
  const next =
    additions.length === 0
      ? draft
      : { ...draft, profile: { ...draft.profile, attributes: [...draft.profile.attributes, ...additions] } };
  return { draft: next, conflicts, filled: additions };
}

function formatValue(value: AttributeValue["value"]): string {
  return Array.isArray(value) ? value.join("+") : String(value);
}
