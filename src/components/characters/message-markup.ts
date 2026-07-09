/**
 * Pure render model for the chat transcript span renderer + the composer's OOC
 * affordance (player-input-perception.plan.md slice 5). No React, no IO — the
 * span→display decisions live here so they are unit-testable in a plain `.ts` test
 * (the repo's test env is node-only, no jsdom); `message-content.tsx` is the thin
 * view that maps a variant onto Tailwind classes.
 *
 * The sigil grammar itself is owned by `@/lib/message-spans` (`parseMessageSpans`) —
 * this module NEVER re-implements it (jscpd gate + the plan's single-parser rule). It
 * only decides how each parsed span should look and reconstructs the inter-span
 * spacing the parser trims away.
 */

import { parseMessageSpans, type MessageSpanContext } from "@/lib/message-spans";

/** How a span renders. The parser's seven kinds collapse onto four display variants. */
export type SpanVariant = "plain" | "italic" | "comms" | "ooc";

export interface RenderPiece {
  variant: SpanVariant;
  /** The visible body text. Speech keeps its quotes; every other sigil is already stripped by the parser. */
  text: string;
  /** Comms only: the `Name:` label shown (non-italic) before the italic body. Absent when the sender is unknown. */
  prefix?: string;
  /** Whether a single separating space precedes this piece (the parser trims inter-span whitespace, so we rebuild it). */
  space: boolean;
}

/**
 * Chars that must NOT carry a leading space when a piece begins with one (a clause
 * that resumes after an inline thought/emphasis: `…here` + `, and shrink back.`). Every
 * other boundary gets a single space, which reconstructs the common speech→narration
 * and narration→thought joins faithfully.
 */
const NO_LEADING_SPACE = ",.!?;:)]}%…”’";

/** Map one parsed span onto its display variant + visible text (exhaustive over every span kind). */
function pieceFor(span: ReturnType<typeof parseMessageSpans>[number]): Omit<RenderPiece, "space"> {
  switch (span.kind) {
    case "speech":
      return { variant: "plain", text: `"${span.text}"` };
    case "narration":
    case "written":
      // `written` is reserved but unproduced today — fall through to plain text.
      return { variant: "plain", text: span.text };
    case "thought":
    case "styled":
      return { variant: "italic", text: span.text };
    case "comms":
      return { variant: "comms", text: span.text, prefix: span.sender ? `${span.sender}:` : undefined };
    case "ooc":
      return { variant: "ooc", text: span.text };
  }
}

/** True when a space should precede this piece — i.e. it doesn't open with resume-punctuation. */
function needsLeadingSpace(base: Omit<RenderPiece, "space">): boolean {
  const first = (base.prefix ?? base.text)[0];
  return first !== undefined && !NO_LEADING_SPACE.includes(first);
}

/** Parse one paragraph into ordered, spacing-aware render pieces. */
function buildParagraph(chunk: string, context: MessageSpanContext): RenderPiece[] {
  const pieces: RenderPiece[] = [];
  for (const span of parseMessageSpans(chunk, context)) {
    const base = pieceFor(span);
    pieces.push({ ...base, space: pieces.length > 0 && needsLeadingSpace(base) });
  }
  return pieces;
}

/**
 * The full render model for a message: paragraphs (split on blank lines, so multi-
 * paragraph narrator prose keeps its breaks) each holding a run of render pieces.
 * A blank/degenerate message yields no paragraphs (the caller renders nothing).
 */
export function messageRenderModel(content: string, context: MessageSpanContext = {}): RenderPiece[][] {
  const paragraphs: RenderPiece[][] = [];
  for (const chunk of (content ?? "").split(/\n\s*\n/)) {
    const pieces = buildParagraph(chunk, context);
    if (pieces.length > 0) paragraphs.push(pieces);
  }
  return paragraphs;
}

/**
 * Composer affordance: is the caret sitting inside an open `((…))` OOC block? A cheap
 * bracket-balance probe rather than the sigil grammar — `parseMessageSpans` is offset-
 * free (it can't answer "is my caret inside this span") and only recognizes CLOSED
 * blocks, whereas a block being typed is frequently still open. True when the most
 * recent `((` before the caret has no matching `))` before it.
 */
export function caretInOocBlock(text: string, caret: number): boolean {
  const before = text.slice(0, Math.max(0, caret));
  const lastOpen = before.lastIndexOf("((");
  if (lastOpen === -1) return false;
  return before.lastIndexOf("))") < lastOpen;
}
