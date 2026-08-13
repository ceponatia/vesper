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
});
export type VoiceExemplar = z.infer<typeof voiceExemplarSchema>;
export const voiceExemplarsSchema = z.array(voiceExemplarSchema);

/**
 * Append a picked line — trimmed + length-capped — keeping the newest
 * CHAT_VOICE_EXEMPLAR_CAP entries. A blank/whitespace line is a no-op (the
 * archivist emits "" for "nothing distinctly in-voice this exchange"). PURE.
 */
export function appendVoiceExemplar(
  history: readonly VoiceExemplar[],
  line: string,
  atClockMinutes: number,
): VoiceExemplar[] {
  const trimmed = line.trim().slice(0, CHAT_VOICE_EXEMPLAR_LINE_MAX);
  if (!trimmed) return [...history];
  return [...history, { line: trimmed, atClockMinutes }].slice(-CHAT_VOICE_EXEMPLAR_CAP);
}
