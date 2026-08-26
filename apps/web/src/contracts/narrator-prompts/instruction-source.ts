import { z } from "zod";
import { narratorPromptLanguageSchema, type NarratorPromptLanguage } from "./template";

/**
 * The ONE typed answer to "whose instructions is the narrator following this
 * exchange?" (narrator-prompt-lab.plan.md §Narrator instruction source).
 *
 * Resolved **after the exchange lock is taken** and before any narrator prompt is
 * built, then reused unchanged by every attempt in that exchange — the first
 * call, every hidden retry, the audit, settlement and provenance. A save landing
 * in another browser tab while the reply streams cannot reach the reply being
 * written, because nothing downstream ever re-reads the template.
 *
 * Both narrator lanes consume this same value. Resolving it once, above the
 * legacy/successor fork, is what stops the two lanes from growing independent
 * selectors that disagree.
 */

export const narratorInstructionSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("production"),
    /** Identifies the production instruction text that was assembled. */
    instructionHash: z.string(),
  }),
  z.object({
    kind: z.literal("test"),
    templateId: z.string(),
    templateName: z.string(),
    revisionId: z.string(),
    revision: z.number().int().positive(),
    body: z.string(),
    bodyHash: z.string(),
    templateLanguage: narratorPromptLanguageSchema,
  }),
]);

export type NarratorInstructionSource = z.infer<typeof narratorInstructionSourceSchema>;

/** The source every lane falls back to: no selection, or a selection that failed to resolve. */
export function productionInstructionSource(instructionHash = ""): NarratorInstructionSource {
  return { kind: "production", instructionHash };
}

export function isTestInstructionSource(
  source: NarratorInstructionSource | undefined,
): source is Extract<NarratorInstructionSource, { kind: "test" }> {
  return source?.kind === "test";
}

/**
 * Why a selected template did not become a test source. Every one of these
 * degrades to production instructions and emits a diagnostic — a Prompt Lab
 * experiment must never be able to dead-end a conversation.
 */
export const narratorInstructionFallbackReasons = [
  /** The chat selects a template id that no longer resolves for this owner. */
  "template_missing",
  /** The template was soft-deleted between selection and this exchange. */
  "template_deleted",
  /** `current_revision_id` did not resolve, or the stored row failed to parse. */
  "revision_missing",
  /** The stored `template_language` is not one this build knows how to render. */
  "unknown_language",
] as const;
export type NarratorInstructionFallbackReason = (typeof narratorInstructionFallbackReasons)[number];

export const NARRATOR_INSTRUCTION_FALLBACK_CODE = "narrator_prompt_override_unavailable";

/** The badge/label a lane shows for an active override, e.g. `Player Agency Minimal v4`. */
export function narratorInstructionLabel(source: NarratorInstructionSource): string {
  return source.kind === "test" ? `${source.templateName} v${source.revision}` : "Vesper production prompt";
}

export type { NarratorPromptLanguage };
