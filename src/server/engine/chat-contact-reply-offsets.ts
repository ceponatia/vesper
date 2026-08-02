import { npcSceneNarrationSentences, type NpcSceneReplySpan } from "@/contracts";
import {
  detectChatNpcContactEnding,
  type ChatNpcContactEnding,
  type ChatNpcEndingCharacter,
} from "./chat-contact-reply";

/**
 * Source offsets for the FROZEN floor's detected ending
 * (romantic-contact-affordances.spec.actor-control.md §"Authority model": "Its
 * result gains source offsets for ordering, but its accepted language does not
 * grow").
 *
 * `chat-contact-reply.ts` is frozen: it reports WHAT ended, not where the
 * sentence sat, and its lexicon must not be duplicated into a second file that
 * could drift. So this wrapper re-derives the matched sentence by replaying
 * the floor's own exported detector over the reply's narration sentences ONE
 * SENTENCE AT A TIME:
 *
 * - the sentence enumeration is `npcSceneNarrationSentences` — the same
 *   curly-quote normalization, the same span parser, the same sentence
 *   boundary the floor scans by, with absolute offsets preserved;
 * - the per-sentence verdict is `detectChatNpcContactEnding` itself, so the
 *   eligibility gates and the withdraw/separate patterns are the floor's own
 *   bytes, not a copy.
 *
 * The floor returns its FIRST match in reading order, so the first sentence
 * with ANY isolated detection is the sentence the full-reply scan matched. If
 * that sentence's detection differs from the ending the caller claims the
 * floor produced, the inputs are inconsistent (a different roster, an edited
 * reply) and the honest answer is `null` — the planner then keeps the floor
 * entry unordered rather than pinning it to a sentence it did not come from.
 *
 * Pure: no IO, no clock, no model call. Same reply + roster + ending ⇒ same
 * span.
 */
export function locateChatNpcEndingSentenceSpan(input: {
  /** The COMPLETED assistant reply, exactly as persisted. */
  readonly reply: string;
  /** PRESENT roster members, exactly as the floor's detection received them. */
  readonly characters: readonly ChatNpcEndingCharacter[];
  /** The ending the floor detected over the full reply. */
  readonly ending: ChatNpcContactEnding;
}): NpcSceneReplySpan | null {
  for (const sentence of npcSceneNarrationSentences(input.reply)) {
    const detected = detectChatNpcContactEnding({ reply: sentence.text, characters: input.characters });
    if (detected === null) continue;
    return detected.subjectId === input.ending.subjectId && detected.reason === input.ending.reason
      ? { start: sentence.start, end: sentence.end }
      : null;
  }
  return null;
}
