import { z } from "zod";

/**
 * Rolling chat-summary fold: the structured output of the `chat_summary`
 * background job. Deliberately tiny (docs/resilience.md §3) — one prose field.
 * Length and "did it actually fold" are enforced server-side, never trusted to
 * the model.
 */

/** Hard cap on the stored summary (~400 words) — clamped in processing, not by the schema. */
export const CHAT_SUMMARY_MAX_CHARS = 2400;

export const chatSummaryFoldSchema = z.object({
  /** The rewritten running summary: narrative recap + an "Established:" ledger. */
  summary: z.string().default(""),
});

export type ChatSummaryFold = z.infer<typeof chatSummaryFoldSchema>;

/**
 * Degraded default, defined next to the schema (docs/resilience.md §1/§3): keep
 * the PRIOR summary unchanged. Processing treats this as "do not advance the
 * watermark" — the folded messages simply stay verbatim and we retry next cycle,
 * so a failed fold can never replace a good summary or lose the seam.
 */
export function degradedChatSummaryFold(priorSummary: string): ChatSummaryFold {
  return { summary: priorSummary.trim() };
}
