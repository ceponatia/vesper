import { z } from "zod";
import { factDraftSchema } from "../facts/taxonomy";

/**
 * NPC inner note (docs/memory.md §Authored interior facts): a player-authored
 * injection of memory, feeling, or belief for one NPC — never dialogue. The
 * extraction schema is deliberately small (docs/resilience.md §3); quantities
 * and subject binding are clamped server-side, never trusted to the model.
 */

/** Cap enforced at the route boundary and mirrored by the composer textarea. */
export const INNER_NOTE_MAX_CHARS = 2000;

export const innerNoteExtractionSchema = z.object({
  /** 1–4 durable interior facts bound to the NPC (count clamped in processing). */
  facts: z.array(factDraftSchema).default([]),
  /** One or two sentences of next-turn behavioral guidance. */
  guidance: z.string().default(""),
});

export type InnerNoteExtraction = z.infer<typeof innerNoteExtractionSchema>;

/**
 * Degraded default, defined next to the schema (docs/resilience.md §1/§3):
 * the note itself, verbatim, as one knowledge fact plus guidance — the
 * feature keeps working with the model down (and in demo mode).
 */
export function degradedInnerNoteExtraction(subjectName: string, note: string): InnerNoteExtraction {
  const text = note.trim();
  return {
    facts: [
      {
        kind: "knowledge",
        subjectName,
        subjectKind: "character",
        text,
        tags: [],
        confidence: 0.9,
      },
    ],
    guidance: text,
  };
}
