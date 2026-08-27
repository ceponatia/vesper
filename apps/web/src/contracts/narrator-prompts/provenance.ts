import { z } from "zod";
import { narratorPromptLanguageSchema } from "./template";

/**
 * What produced this take.
 *
 * Prompt experimentation is worthless if the app cannot later answer "which
 * prompt wrote this?". Every generated assistant take carries a compact record:
 * the lane, the effective narrator model, production-vs-test, the exact template
 * revision when test, and hashes identifying the instruction body and the
 * assembled system prompt.
 *
 * Deliberately NOT the full assembled prompt. The immutable revision already
 * holds the custom body; copying a whole runtime prompt onto every message would
 * bloat the transcript for a fact two hashes already establish.
 *
 * Every field beyond `lane`/`modelId`/`promptSource` is optional, and the whole
 * record is optional on a take — historical takes predate it and must keep
 * loading. Parse with `parseOr`, never `.parse`.
 */

export const narratorRunLanes = ["legacy_chat", "successor"] as const;
export type NarratorRunLane = (typeof narratorRunLanes)[number];

export const narratorRunProvenanceSchema = z.object({
  lane: z.enum(narratorRunLanes),
  modelId: z.string(),
  promptSource: z.enum(["production", "test"]),

  templateId: z.string().optional(),
  templateName: z.string().optional(),
  revisionId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  templateLanguage: narratorPromptLanguageSchema.optional(),

  /** Identifies the instruction body — the custom revision, or the production text. */
  instructionHash: z.string().optional(),
  /** Identifies the whole assembled system prompt, so two takes can be told apart. */
  assembledSystemHash: z.string().optional(),
  /** Characters contributed per authority layer — how much of the prompt actually moved. */
  authorityWeights: z.record(z.string(), z.number()).optional(),

  mode: z.literal("instruction_override_v1").optional(),

  attempts: z.number().int().positive().optional(),
  finishReason: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
});

export type NarratorRunProvenance = z.infer<typeof narratorRunProvenanceSchema>;

/** Compact label for the take browser, e.g. `aion-2.0 · Player Agency Minimal v4`. */
export function narratorProvenanceLabel(provenance: NarratorRunProvenance): string {
  const prompt =
    provenance.promptSource === "test" && provenance.templateName
      ? `${provenance.templateName} v${provenance.revision ?? "?"}`
      : "production prompt";
  return provenance.modelId ? `${provenance.modelId} · ${prompt}` : prompt;
}
