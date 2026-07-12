/**
 * Pure segment→display mapping for chat narrator/character replies (dialogue-attribution,
 * 2026-07-09). No React, no IO — kept here so the split + label decisions are unit-testable
 * in a plain `.ts` test (the repo's env is node-only); `chat-message.tsx` is the thin view.
 *
 * The chat lane renders a reply as a "story being told": one bubble carrying in-bubble
 * per-speaker segments (never separate bubbles). This module splits the raw reply into those
 * segments via the shared `@/lib/segmenter` (with standalone-quote attribution ON, since chat
 * is one-on-one) and decides which segments show a speaker label. Segment CONTENT still renders
 * through `MessageContent`/`message-markup` so the sigil grammar (thoughts, comms, OOC) keeps
 * working — this module never re-implements either the segmenter or the span grammar.
 */

import { parseSegments } from "@/lib/segmenter";
import { parseMessageSpans } from "@/lib/message-spans";

export interface ChatReplySegment {
  /** The attributed speaker (the character), or null for narrator prose. */
  speaker: string | null;
  content: string;
  /** Whether to render the small speaker label above this segment. */
  showLabel: boolean;
}

/**
 * A segment whose entire content is a single `*Name: …*` comms span already gets the
 * Name-labeled italic (texted) treatment from `message-markup`; a speaker label above it
 * would double-label the attribution, so we suppress it and let the comms styling carry it.
 */
function isSolelyComms(content: string, knownNames: readonly string[]): boolean {
  const spans = parseMessageSpans(content, { knownNames: knownNames.length ? [...knownNames] : undefined });
  return spans.length === 1 && spans[0]?.kind === "comms";
}

/**
 * Split a narrator/character reply into display segments. `[Name]` tags attribute to any
 * roster member in `knownNames` (matched by full name or an unambiguous first name — segmenter
 * §buildKnownMap), and in a one-on-one reply with no tags at all a standalone whole-line quote
 * attributes to the sole member too; in a tagged reply an untagged quote is someone else — a side
 * NPC's own quoted paragraph — and stays narrator prose (segmenter §hasKnownTag, owner report
 * 2026-07-11). Pass the WHOLE roster, not just the primary: a group reply tags every member, so a
 * non-primary speaker's tag would otherwise leak as literal `[Name]` (owner report 2026-07-12).
 * The tag itself never appears in the content. A speaker segment shows its label unless it is
 * solely a comms line (which carries its own attribution).
 */
export function chatReplySegments(content: string, knownNames: readonly string[]): ChatReplySegment[] {
  const known = knownNames.filter((n) => n.trim().length > 0);
  const segments = parseSegments(content, known, { attributeStandaloneQuotes: true });
  return segments.map((seg) => ({
    speaker: seg.speaker,
    content: seg.content,
    showLabel: seg.speaker !== null && !isSolelyComms(seg.content, known),
  }));
}
