import { parseMessageSpans, type MessageSpanKind } from "@/lib/message-spans";

/**
 * Shared, pure evidence primitives for the chat lane's regex-first pre-turn reads.
 *
 * This module deliberately stops below detector policy. A sensory premise, scene
 * movement, visual-attention cue, and durable contact do not have the same error
 * cost, so consumers choose which flags disqualify their own candidates instead
 * of inheriting one universal "eligible sentence" rule.
 */

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+|\n+/u;

/** The input channels a detector is willing to treat as evidence. */
export type ChatEvidenceKind = Extract<MessageSpanKind, "narration" | "speech" | "comms" | "styled">;

export interface ChatEvidenceSentence {
  readonly kind: ChatEvidenceKind;
  readonly text: string;
}

/** Normalize authored apostrophes before applying contraction-sensitive gates. */
export function normalizeChatEvidenceText(text: string): string {
  return text.replace(/[’‘]/gu, "'");
}

/**
 * Parse the message once through the shared markup grammar, then return ordered
 * sentences from only the channels this detector accepts. Thoughts and OOC are
 * never evidence; callers must opt into speech/comms/styled explicitly.
 */
export function chatEvidenceSentences(
  input: string | null | undefined,
  kinds: readonly ChatEvidenceKind[] = ["narration"],
): readonly ChatEvidenceSentence[] {
  const allowed = new Set<ChatEvidenceKind>(kinds);
  const sentences: ChatEvidenceSentence[] = [];
  for (const span of parseMessageSpans(normalizeChatEvidenceText(input ?? ""))) {
    if (
      span.kind !== "narration" &&
      span.kind !== "speech" &&
      span.kind !== "comms" &&
      span.kind !== "styled"
    ) {
      continue;
    }
    if (!allowed.has(span.kind)) continue;
    const kind = span.kind;
    for (const sentence of span.text.split(SENTENCE_SPLIT_RE)) {
      const text = sentence.trim();
      if (text) sentences.push({ kind, text });
    }
  }
  return sentences;
}

/**
 * Complete auxiliary-contraction family, with or without an apostrophe. Explicit
 * stems avoid the unsafe `\w+n't` shape, which would classify ordinary words such
 * as "paint" as negation.
 */
const NEGATION_RE =
  /\b(?:(?:ai|are|can|could|did|does|do|had|has|have|is|might|must|need|sha|should|was|were|wo|would)n'?t|cannot|not|never|no longer|without)\b/iu;

/** Does this sentence explicitly deny the event under consideration? */
export function hasChatEvidenceNegation(sentence: string): boolean {
  return NEGATION_RE.test(normalizeChatEvidenceText(sentence));
}

/** Markers that make an asserted current event hypothetical, intended, or merely near. */
const IRREALIS_RE =
  /\b(?:if|would|could|should|might|may|maybe|perhaps|imagine|suppose|pretend|wish|almost|nearly|want to|wanted to|going to|about to|tr(?:y|ies|ied|ying) to|as if|as though)\b/iu;

export function hasChatEvidenceIrrealis(sentence: string): boolean {
  return IRREALIS_RE.test(normalizeChatEvidenceText(sentence));
}

/**
 * Candidate-scoped history veto. Plain past remains valid RP narration; only a
 * perfect auxiliary immediately governing this candidate, or `used to`, marks it
 * as prior/background action.
 */
export function chatEvidenceCandidateIsHistorical(sentence: string, candidateIndex: number): boolean {
  const text = normalizeChatEvidenceText(sentence);
  const start = Math.max(0, candidateIndex - 80);
  const before = text.slice(start, candidateIndex);
  return (
    /(?:\b(?:have|has|had)\b|['’](?:ve|d))\s+(?:[\p{L}\p{N}'-]+\s+){0,3}$/iu.test(before) ||
    /\bused to\s+(?:[\p{L}\p{N}'-]+\s+){0,2}$/iu.test(before)
  );
}

export interface ChatEvidenceCandidateFlags {
  readonly question: boolean;
  readonly negated: boolean;
  readonly irrealis: boolean;
  readonly historical: boolean;
}

/** The raw flags; each detector decides which ones disqualify its candidate. */
export function chatEvidenceCandidateFlags(sentence: string, candidateIndex: number): ChatEvidenceCandidateFlags {
  return {
    question: sentence.includes("?"),
    negated: hasChatEvidenceNegation(sentence),
    irrealis: hasChatEvidenceIrrealis(sentence),
    historical: chatEvidenceCandidateIsHistorical(sentence, candidateIndex),
  };
}
