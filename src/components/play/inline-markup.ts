/**
 * Tiny inline-markup tokenizer for narrator prose (docs/ui.md): `*italic*`
 * and `**bold**` only, no markdown library. Pure; unmatched or empty markers
 * stay literal text so malformed prose never breaks rendering.
 */

export type InlineTokenKind = "text" | "em" | "strong";

export interface InlineToken {
  kind: InlineTokenKind;
  text: string;
}

const MARKUP = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;

export function parseInlineMarkup(source: string): InlineToken[] {
  if (source === "") return [];
  const tokens: InlineToken[] = [];
  let cursor = 0;
  MARKUP.lastIndex = 0;
  for (let match = MARKUP.exec(source); match !== null; match = MARKUP.exec(source)) {
    if (match.index > cursor) tokens.push({ kind: "text", text: source.slice(cursor, match.index) });
    const bold = match[1];
    const italic = match[2];
    if (bold !== undefined) tokens.push({ kind: "strong", text: bold });
    else if (italic !== undefined) tokens.push({ kind: "em", text: italic });
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) tokens.push({ kind: "text", text: source.slice(cursor) });
  return tokens;
}
