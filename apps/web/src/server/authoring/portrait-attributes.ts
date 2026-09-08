import { createHash } from "node:crypto";
import { z } from "zod";
import {
  diag,
  isIntimateAttributeCategory,
  isPersonalityAttributeCategory,
  realizeBody,
  visualExtractionImageRegionSchema,
  type AttributeDefinition,
  type AttributeValue,
  type DiagnosticSink,
} from "@/contracts";
import {
  portraitExtractionEvidenceSchema,
  portraitVisibilitySchema,
  type PortraitExtractionEvidence,
  type PortraitFieldEvidence,
} from "@/lib/portrait-extraction";
import { generateChecked, visionModelId, type GenerateImagePart } from "@/server/ai";
import { characterAttributeDefinitions, describeConstraint, groundAttributeValues } from "./character-forge/attributes";
import type { CharacterDraft } from "./drafts";

export const PORTRAIT_ATTRIBUTE_PROMPT_VERSION = "portrait-attributes/v2";
export const PORTRAIT_DEFAULT_CONFIDENCE = 7_000;

export function portraitObservationCanPropose(
  definition: AttributeDefinition | undefined,
  visibility: "clear" | "partial" | "occluded" | "out_of_frame" | "uncertain",
  evidenceRegion: z.infer<typeof visualExtractionImageRegionSchema> | null,
): boolean {
  return definition?.category !== "teeth" || (visibility === "clear" && evidenceRegion !== null);
}

const PORTRAIT_SYSTEM = [
  "You compare a character portrait with a fixed vocabulary of visible physical attributes.",
  "Use only the listed attribute ids and allowed values. Never infer heritage, ancestry, natal sex, personality, backstory, or other facts that pixels cannot establish.",
  "For each observation, report confidence from 0 to 10000, visibility, a short literal description of the visual evidence, and its normalized image rectangle from 0 to 10000.",
  "A tentative value may be reported when visibility is partial or uncertain; it will require explicit human selection. Use null when no value is defensible.",
  "Mark occluded or out-of-frame details honestly. Do not convert absence of evidence into a normal/default value.",
  "Teeth may receive a value only when an open mouth visibly exposes the relevant teeth. A closed mouth, covered mouth, or distant face must use null.",
].join("\n");

function realizedBodyFor(draft: CharacterDraft) {
  const profile = draft.profile;
  return realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });
}

/** The attribute definitions a portrait may speak to for this realized body. */
export function portraitAttributeDefinitions(
  draft: CharacterDraft,
  realizedBody = realizedBodyFor(draft),
): readonly AttributeDefinition[] {
  return characterAttributeDefinitions({ prompt: "", userId: "", draft }).filter(
    (definition) =>
      !isIntimateAttributeCategory(definition.category) &&
      !isPersonalityAttributeCategory(definition.category) &&
      definition.id !== "identity.heritage" &&
      definition.id !== "identity.gender" &&
      definition.id !== "identity.natal_sex" &&
      realizedBody.isAttributeApplicable(definition),
  );
}

/** Hash only the character facts that define this extraction's vocabulary or
 * comparison. Biography, tags and other unrelated edits do not stale it. */
export function portraitAuthoringFingerprint(draft: CharacterDraft): string {
  const eligible = new Set(portraitAttributeDefinitions(draft).map((definition) => definition.id));
  const profile = draft.profile;
  return createHash("sha256").update(JSON.stringify({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: [...profile.intimateRegions].sort(),
    bodyFeatures: [...profile.bodyFeatures].sort(),
    attributes: profile.attributes
      .filter((attribute) => eligible.has(attribute.id))
      .map((attribute) => ({ id: attribute.id, value: attribute.value }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  })).digest("hex");
}

interface PortraitSection {
  attributes: {
    id: string;
    value: string | string[] | number | boolean | null;
    confidence: number;
    visibility: "clear" | "partial" | "occluded" | "out_of_frame" | "uncertain";
    evidence: string;
    evidenceRegion: z.infer<typeof visualExtractionImageRegionSchema> | null;
  }[];
}

function buildPortraitSchema(definitions: readonly AttributeDefinition[]): z.ZodType<PortraitSection> {
  const ids = definitions.map((definition) => definition.id as string);
  const idSchema = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string().min(1);
  const value = z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]);
  return z.object({
    attributes: z.array(z.object({
      id: idSchema,
      value: value.nullable(),
      confidence: z.number().int().min(0).max(10_000),
      visibility: portraitVisibilitySchema,
      evidence: z.string().trim().min(1).max(500),
      evidenceRegion: visualExtractionImageRegionSchema.nullable().default(null),
    })).default([]),
  });
}

function portraitPrompt(definitions: readonly AttributeDefinition[]): string {
  const vocabulary = definitions.map((definition) => `- ${definition.id} (${describeConstraint(definition)}): ${definition.description}`).join("\n");
  return [
    "Inspect the supplied portrait and compare only what is visibly supported.",
    "",
    "Attribute vocabulary:",
    vocabulary,
    "",
    "Return one observation per attribute the image helps assess, including null-valued occluded, out-of-frame, or uncertain observations. Omit attributes the image provides no evidence about at all.",
  ].join("\n");
}

export interface PortraitSourceEvidence {
  imageId: string;
  contentHash: string;
  authoringRevision: number;
  authoringFingerprint: string;
}

export interface PortraitAttributesInput {
  draft: CharacterDraft;
  image: GenerateImagePart;
  source: PortraitSourceEvidence;
  sink?: DiagnosticSink;
}

export interface PortraitConflict {
  id: string;
  current: AttributeValue["value"];
  proposed: AttributeValue["value"];
}

export interface PortraitAttributesResult {
  draft: CharacterDraft;
  conflicts: PortraitConflict[];
  filled: AttributeValue[];
  evidence: PortraitExtractionEvidence;
}

function evidenceEnvelope(input: {
  outcome: PortraitExtractionEvidence["outcome"];
  readFailure: PortraitExtractionEvidence["readFailure"];
  source: PortraitSourceEvidence;
  modelId: string;
  provider: string | null;
  startedAt: Date;
  finishedAt: Date;
  providerLatencyMs: number | null;
  fields: PortraitFieldEvidence[];
}): PortraitExtractionEvidence {
  return portraitExtractionEvidenceSchema.parse({
    outcome: input.outcome,
    readFailure: input.readFailure,
    source: input.source,
    model: { id: input.modelId, promptVersion: PORTRAIT_ATTRIBUTE_PROMPT_VERSION, provider: input.provider },
    timing: {
      startedAt: input.startedAt.toISOString(),
      finishedAt: input.finishedAt.toISOString(),
      durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
      providerLatencyMs: input.providerLatencyMs,
    },
    fields: input.fields,
    decision: null,
  });
}

export function failedPortraitAttributes(input: {
  draft: CharacterDraft;
  source: PortraitSourceEvidence;
  failure: "provider_or_parse" | "insufficient_visible_evidence" | "source_unavailable" | "source_changed";
  fields?: PortraitFieldEvidence[];
  sink?: DiagnosticSink;
}): PortraitAttributesResult {
  const now = new Date();
  input.sink?.push(diag("error", `forge.character.portrait.${input.failure}`, "The portrait could not be read with enough evidence. Retry after checking the saved portrait."));
  return {
    draft: input.draft,
    conflicts: [],
    filled: [],
    evidence: evidenceEnvelope({
      outcome: "read_failed",
      readFailure: input.failure,
      source: input.source,
      modelId: visionModelId(),
      provider: null,
      startedAt: now,
      finishedAt: now,
      providerLatencyMs: null,
      fields: input.fields ?? [],
    }),
  };
}

/** Pure classification and merge. Weak observations remain reviewable but start
 * on Keep current; only strong matching evidence can produce supported_match. */
export function mergePortraitReadings(
  draft: CharacterDraft,
  fields: readonly PortraitFieldEvidence[],
  sink?: DiagnosticSink,
): Pick<PortraitAttributesResult, "draft" | "conflicts" | "filled"> & { outcome: "proposals" | "supported_match" | "read_failed" } {
  const existing = new Map(draft.profile.attributes.map((attribute) => [attribute.id, attribute]));
  const additions: AttributeValue[] = [];
  const conflicts: PortraitConflict[] = [];
  let supportedMatches = 0;
  for (const field of fields) {
    if (field.value === null) continue;
    const read = { id: field.id as AttributeValue["id"], value: field.value, source: "creation" as const };
    const current = existing.get(read.id);
    if (!current) additions.push(read);
    else if (JSON.stringify(current.value) !== JSON.stringify(read.value)) {
      conflicts.push({ id: read.id, current: current.value, proposed: read.value });
      sink?.push(diag("info", "forge.character.portrait.portrait_conflict", `Portrait evidence for ${read.id} differs from the sheet and requires review.`, {
        context: { id: read.id, portrait: read.value, sheet: current.value },
      }));
    } else if (field.defaultSelected) supportedMatches += 1;
  }
  const next = additions.length === 0 ? draft : {
    ...draft,
    profile: { ...draft.profile, attributes: [...draft.profile.attributes, ...additions] },
  };
  const outcome = additions.length > 0 || conflicts.length > 0
    ? "proposals" as const
    : supportedMatches > 0 ? "supported_match" as const : "read_failed" as const;
  return { draft: next, conflicts, filled: additions, outcome };
}

export async function derivePortraitAttributes(input: PortraitAttributesInput): Promise<PortraitAttributesResult> {
  const { draft, sink } = input;
  const definitions = portraitAttributeDefinitions(draft);
  const startedAt = new Date();
  const modelId = visionModelId();
  const generated = await generateChecked({
    schema: buildPortraitSchema(definitions),
    system: PORTRAIT_SYSTEM,
    prompt: portraitPrompt(definitions),
    images: [input.image],
    modelId,
    code: "forge.character.portrait",
    sink,
  });
  const finishedAt = new Date();
  if (generated.degraded || !generated.value) {
    return {
      draft,
      conflicts: [],
      filled: [],
      evidence: evidenceEnvelope({
        outcome: "read_failed",
        readFailure: "provider_or_parse",
        source: input.source,
        modelId,
        provider: generated.provider ?? null,
        startedAt,
        finishedAt,
        providerLatencyMs: generated.latencyMs ?? null,
        fields: [],
      }),
    };
  }

  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const seen = new Set<string>();
  const fields: PortraitFieldEvidence[] = [];
  const realizedBody = realizedBodyFor(draft);
  for (const raw of generated.value.attributes) {
    if (seen.has(raw.id)) {
      sink?.push(diag("info", "forge.character.portrait.duplicate_id", `Dropped duplicate portrait observation for ${raw.id}.`));
      continue;
    }
    seen.add(raw.id);
    const definition = definitionById.get(raw.id);
    const directTeethSupport = portraitObservationCanPropose(definition, raw.visibility, raw.evidenceRegion);
    const grounded = raw.value === null || !directTeethSupport
      ? null
      : groundAttributeValues([{ id: raw.id, value: raw.value }], sink, "forge.character.portrait", realizedBody)[0] ?? null;
    if (!directTeethSupport && raw.value !== null) {
      sink?.push(diag("info", "forge.character.portrait.unsupported_conditional", `Omitted ${raw.id} because the portrait does not visibly support that conditional detail.`, { context: { id: raw.id } }));
    }
    const defaultSelected = grounded !== null && raw.visibility === "clear" && raw.confidence >= PORTRAIT_DEFAULT_CONFIDENCE && raw.evidenceRegion !== null;
    fields.push({
      id: raw.id,
      value: grounded?.value ?? null,
      confidence: raw.confidence,
      visibility: raw.visibility,
      evidence: raw.evidence,
      evidenceRegion: raw.evidenceRegion,
      defaultSelected,
    });
  }

  const merged = mergePortraitReadings(draft, fields, sink);
  const readFailure = merged.outcome === "read_failed" ? "insufficient_visible_evidence" as const : null;
  if (readFailure) sink?.push(diag("warn", "forge.character.portrait.insufficient_visible_evidence", "The portrait read succeeded but did not produce enough visible evidence for a proposal or supported match."));
  return {
    draft: merged.draft,
    conflicts: merged.conflicts,
    filled: merged.filled,
    evidence: evidenceEnvelope({
      outcome: merged.outcome,
      readFailure,
      source: input.source,
      modelId,
      provider: generated.provider ?? null,
      startedAt,
      finishedAt,
      providerLatencyMs: generated.latencyMs ?? null,
      fields,
    }),
  };
}
