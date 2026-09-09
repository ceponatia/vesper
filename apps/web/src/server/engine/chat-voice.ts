import { z } from "zod";

/**
 * Voice-exemplar ring (character-fidelity slice 8): the rolling summary is
 * events-only (prompts/chat-summary.ts — deliberately "NOT dialogue"), so a
 * character's VOICE is lost past the ~40-exchange summary horizon. This ≤5-entry
 * ring on the chat state row keeps a few distinctly in-voice lines the character
 * actually said — the archivist picks ≤1 per exchange — rendered as a "How you
 * sound" few-shot block near generation. Pure shape + append helper (the
 * callback/selfie ring pattern); it rolls back with the pre-exchange snapshot for
 * free, and being per-character state it composes naturally in the ensemble.
 */

/** Ring cap — a few recent in-voice lines, not a transcript. */
export const CHAT_VOICE_EXEMPLAR_CAP = 5;
/** Cap on a single stored line so a runaway reply can't bloat the row. */
export const CHAT_VOICE_EXEMPLAR_LINE_MAX = 240;

/** One recorded in-voice line + the chat-clock minute it landed. */
export const voiceExemplarSchema = z.object({
  line: z.string().catch(""),
  atClockMinutes: z.number().catch(0),
  /** The assistant message the line was copied from; null on entries written before provenance existed. */
  sourceMessageId: z.string().nullable().catch(null).default(null),
});
export type VoiceExemplar = z.infer<typeof voiceExemplarSchema>;
export const voiceExemplarsSchema = z.array(voiceExemplarSchema);

/**
 * Append a picked line — trimmed + length-capped — keeping the newest
 * CHAT_VOICE_EXEMPLAR_CAP entries. A blank/whitespace line is a no-op (the
 * archivist emits "" for "nothing distinctly in-voice this exchange"). PURE.
 * `sourceMessageId` is the assistant message the line was copied from, so an
 * edit/delete of that message can find and drop the exemplar it produced
 * (`removeVoiceExemplarsForMessage` below).
 */
export function appendVoiceExemplar(
  history: readonly VoiceExemplar[],
  line: string,
  atClockMinutes: number,
  sourceMessageId: string | null,
): VoiceExemplar[] {
  const trimmed = line.trim().slice(0, CHAT_VOICE_EXEMPLAR_LINE_MAX);
  if (!trimmed) return [...history];
  return [...history, { line: trimmed, atClockMinutes, sourceMessageId }].slice(-CHAT_VOICE_EXEMPLAR_CAP);
}

/** Whitespace-collapsed, case-insensitive form used to compare a stored line against message content. */
function normalizeForMatch(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Drop every exemplar attributable to one message: provenance match by id, or — for entries
 * lacking provenance — the line occurring verbatim (whitespace-collapsed, case-insensitive)
 * in the message's old content. PURE. `removed` counts dropped entries.
 *
 * An entry WITH provenance is judged by id only — a provenanced line from a DIFFERENT
 * message is kept even if its text happens to occur in this message's content, so a
 * repeated line said twice doesn't cross-cancel its other occurrence.
 */
export function removeVoiceExemplarsForMessage(
  history: readonly VoiceExemplar[],
  message: { id: string; content: string },
): { kept: VoiceExemplar[]; removed: number } {
  const normalizedContent = normalizeForMatch(message.content);
  const kept: VoiceExemplar[] = [];
  let removed = 0;
  for (const entry of history) {
    // An empty normalized line (a malformed/degraded row) is never evidence of a
    // match — an empty string is a substring of everything, which would otherwise
    // drop every blank legacy entry regardless of this message's content.
    const normalizedLine = normalizeForMatch(entry.line);
    const matches =
      entry.sourceMessageId !== null
        ? entry.sourceMessageId === message.id
        : normalizedLine.length > 0 && normalizedContent.includes(normalizedLine);
    if (matches) removed += 1;
    else kept.push(entry);
  }
  return { kept, removed };
}
