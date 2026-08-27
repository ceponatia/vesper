/**
 * Deterministic player-message span parser.
 *
 * Pure, IO-free, regex-first (in the spirit of `engine/chat-intent.ts`): it segments a
 * player message into ordered spans by its optional sigil grammar, turning the hardest
 * problem in the perception partition (semantic interiority / channel detection) into a
 * cheap parse WHEN the player opts into the sigils. A message with no sigils yields a
 * single narration span, so the prompt-only partition still carries the read.
 *
 * The sigil grammar:
 * - `"..."`      → speech (the one required convention: dialogue goes in quotes)
 * - `*...*`      → thought (default), comms when `Name:`/`to Name:`-shaped, or styled
 *                  emphasis for a short mid-sentence span (the emphasis guard)
 * - `_..._`      → styled (italics only — no semantics)
 * - `((...))`    → ooc (out-of-character direction to the storyteller; DOUBLE parens
 *                  only — a single `(...)` stays plain narration so prose asides never
 *                  misfire)
 * - unmarked     → narration
 *
 * `written` stays reserved in the kind union (an in-world note/sign/letter) but nothing
 * produces it yet — the backtick sigil is deferred (owner ruling 2026-07-09), so shipping
 * it later is a data/prompt change, not a contract change. The OUTERMOST sigil wins for
 * nested content: `*She said "no" — I can't believe it*` is one thought span, quotes and
 * all.
 *
 * This module is the SINGLE parser implementation — the tail-note renderer, the
 * transcript renderer, and the archivist fact-channel hint all consume
 * these spans; none re-implements the grammar.
 */

/** The channel a span belongs to. `written` is reserved (backtick sigil deferred). */
export type MessageSpanKind =
  | "speech"
  | "narration"
  | "thought"
  | "comms"
  | "ooc"
  | "written"
  | "styled";

export interface MessageSpan {
  kind: MessageSpanKind;
  /** The span's text with its sigils stripped and trimmed (for comms, the message body only). */
  text: string;
  /**
   * Comms only: who is sending. The named sender in `*Name: …*`, or the player persona
   * (context.playerName) in the explicit-recipient `*to Name: …*` form.
   */
  sender?: string;
  /**
   * Comms only: who receives. The explicit recipient in `*to Name: …*`, or the sole other
   * party in a 1-on-1 (resolved from context.knownNames) for the sender-named form.
   */
  recipient?: string;
}

export interface MessageSpanContext {
  /** The player persona's name — the default sender for the `*to Name: …*` comms form. */
  playerName?: string;
  /**
   * Known character/roster names. In a 1-on-1 the sole name resolves the recipient of a
   * bare `*Name: …*` comms span. The parser accepts this rather than hardcoding a name.
   */
  knownNames?: readonly string[];
}

/**
 * The fact-store channel a span establishes knowledge through (the forward-compatible
 * `channel` vocabulary, per the forward-compatible-schema preference): `perceived` facts
 * render as established knowledge to the narrator, `private` ones drop from the narrator
 * prompt, `ooc` never enters in-world memory. Exhaustive over every span kind.
 */
export function spanChannel(kind: MessageSpanKind): "perceived" | "private" | "ooc" {
  switch (kind) {
    case "speech":
    case "narration":
    case "comms":
    case "written":
    case "styled":
      return "perceived";
    case "thought":
      return "private";
    case "ooc":
      return "ooc";
  }
}

/** The narrator's texted-reply output grammar: round-trips through `parseMessageSpans` as a comms span. */
export function formatCommsReply(sender: string, text: string): string {
  return `*${sender.trim()}: ${text.trim()}*`;
}

/** One run of a span's body text: literal, or `_…_`-emphasized (styling only — no semantics). */
export interface EmphasisRun {
  text: string;
  em: boolean;
}

/**
 * Tokenize `_…_` emphasis INSIDE a span's body text. The outermost-sigil rule keeps a
 * quoted speech span atomic, so an underscore pair nested in dialogue ("it's _perfect_!")
 * never becomes a `styled` span — it reaches the renderer raw. This tokenizer is the
 * presentation-side complement: renderers pass each span body through it so `_…_` reads
 * as italics anywhere (speech, thoughts, comms, OOC), while the span grammar and the
 * prompt/fact side (which reads underscores as ordinary words) stay untouched. Unmatched,
 * empty, or whitespace-only pairs stay literal, so degenerate text never drops characters.
 */
export function parseEmphasisRuns(text: string): EmphasisRun[] {
  const runs: EmphasisRun[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf) runs.push({ text: buf, em: false });
    buf = "";
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === "_") {
      const close = text.indexOf("_", i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close);
        if (inner.trim()) {
          flush();
          runs.push({ text: inner, em: true });
        } else {
          buf += text.slice(i, close + 1);
        }
        i = close + 1;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return runs;
}

/** True when nothing but whitespace precedes the open sigil on its line (start-of-string or a newline). */
function isLineEdgeBefore(text: string, openIdx: number): boolean {
  for (let k = openIdx - 1; k >= 0; k -= 1) {
    const c = text[k];
    if (c === "\n") return true;
    if (c === " " || c === "\t" || c === "\r") continue;
    return false;
  }
  return true;
}

/** True when nothing but whitespace follows the close sigil on its line (end-of-string or a newline). */
function isLineEdgeAfter(text: string, closeIdx: number): boolean {
  for (let k = closeIdx + 1; k < text.length; k += 1) {
    const c = text[k];
    if (c === "\n") return true;
    if (c === " " || c === "\t" || c === "\r") continue;
    return false;
  }
  return true;
}

// The explicit-recipient comms form: `to Name: message` (sender defaults to the player
// persona). The recipient allows a short multi-word name but never crosses sentence
// punctuation, so `to be honest, I'm nervous` (no early colon) is NOT a comms span.
const COMMS_TO_RE = /^to\s+([A-Za-z][A-Za-z0-9'’.\- ]{0,30}?)\s*:\s*(.+)$/is;
// The sender-named comms form: `Name: message` — a single name token immediately before
// the colon (so a thought with an internal colon, e.g. `I remember what she said: …`, does
// not match, and neither does a time like `8:30`).
const COMMS_NAMED_RE = /^([A-Za-z][A-Za-z0-9'’.\-]{0,30})\s*:\s*(.+)$/s;

/** Resolve the recipient of a sender-named comms span: the sole known name that is not the sender. */
function resolveRecipient(sender: string, ctx: MessageSpanContext): string | undefined {
  const names = (ctx.knownNames ?? []).map((n) => n.trim()).filter(Boolean);
  const others = names.filter((n) => n.toLowerCase() !== sender.toLowerCase());
  return others.length === 1 ? others[0] : undefined;
}

/** Detect a comms shape inside an asterisk span; null when it is not name-colon-shaped. */
function detectComms(inner: string, ctx: MessageSpanContext): MessageSpan | null {
  const toMatch = COMMS_TO_RE.exec(inner);
  const toRecipient = toMatch?.[1];
  const toBody = toMatch?.[2];
  if (toRecipient !== undefined && toBody !== undefined) {
    return {
      kind: "comms",
      text: toBody.trim(),
      sender: ctx.playerName?.trim() || undefined,
      recipient: toRecipient.trim(),
    };
  }
  const namedMatch = COMMS_NAMED_RE.exec(inner);
  const namedSender = namedMatch?.[1];
  const namedBody = namedMatch?.[2];
  if (namedSender !== undefined && namedBody !== undefined) {
    const sender = namedSender.trim();
    return { kind: "comms", text: namedBody.trim(), sender, recipient: resolveRecipient(sender, ctx) };
  }
  return null;
}

/**
 * Classify an asterisk span: comms when name-colon-shaped, otherwise thought vs. styled
 * emphasis via the emphasis guard — a span reads as a thought only when it is multi-word
 * (≥3 words) or stands alone on its line; a short mid-sentence span (`you *really* think`)
 * is style-only.
 */
function classifyAsterisk(inner: string, standalone: boolean, ctx: MessageSpanContext): MessageSpan {
  const comms = detectComms(inner, ctx);
  if (comms) return comms;
  const words = inner.split(/\s+/).filter(Boolean);
  const isThought = standalone || words.length >= 3;
  return { kind: isThought ? "thought" : "styled", text: inner };
}

/**
 * A span plus where its text sits in the ORIGINAL input.
 *
 * `[start, end)` bounds the span's trimmed body, so for narration and the
 * simple sigil spans `input.slice(start, end) === text` — the property the
 * NPC reply-scene evidence grounding gate rests on (a grounded quote's offsets
 * must be reply offsets, not span-relative ones). The one exception is a comms
 * span, whose `text` is the parsed message BODY while the offsets bound the
 * whole inner sigil region (sender prefix included): comms never grounds
 * physical evidence, so its offsets are informational only.
 */
export interface MessageSpanWithOffsets extends MessageSpan {
  start: number;
  end: number;
}

/** One walker product: the span exactly as `parseMessageSpans` has always built it, plus its range. */
interface SpanEntry {
  span: MessageSpan;
  start: number;
  end: number;
}

/** The trimmed body of `text[rawStart, rawEnd)` and where that body actually sits. */
function trimmedRange(text: string, rawStart: number, rawEnd: number): { body: string; start: number; end: number } {
  const raw = text.slice(rawStart, rawEnd);
  const body = raw.trim();
  const leading = raw.length - raw.trimStart().length;
  return { body, start: rawStart + leading, end: rawStart + leading + body.length };
}

/**
 * The single walker behind both parse entry points. `parseMessageSpans` existed
 * first and its output is CONTRACT (three renderers and two detectors consume
 * it), so the walker builds exactly the spans it always built and the offsets
 * ride beside them — offset support must never be able to change what a span
 * says, only add where it came from.
 */
function walkMessageSpans(text: string, context: MessageSpanContext): SpanEntry[] {
  const entries: SpanEntry[] = [];
  let buf = "";
  // Where the current narration buffer began. The buffer only ever accumulates
  // CONTIGUOUS input (each append starts where the previous one ended), so one
  // start index plus the buffer length always bounds its raw text.
  let bufStart = 0;
  const append = (piece: string, at: number): void => {
    if (buf.length === 0) bufStart = at;
    buf += piece;
  };
  const flush = (): void => {
    if (buf.length === 0) return;
    const { body, start, end } = trimmedRange(text, bufStart, bufStart + buf.length);
    if (body) entries.push({ span: { kind: "narration", text: body }, start, end });
    buf = "";
  };
  const pushSigil = (span: MessageSpan, innerStart: number, innerEnd: number): void => {
    const { start, end } = trimmedRange(text, innerStart, innerEnd);
    entries.push({ span, start, end });
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // OOC — double parens only (a single `(` stays narration).
    if (ch === "(" && text[i + 1] === "(") {
      const close = text.indexOf("))", i + 2);
      if (close !== -1) {
        const inner = text.slice(i + 2, close).trim();
        if (inner) {
          flush();
          pushSigil({ kind: "ooc", text: inner }, i + 2, close);
        } else {
          append(text.slice(i, close + 2), i);
        }
        i = close + 2;
        continue;
      }
    }

    // Speech — the outermost `"..."` wins over any sigils nested inside it.
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close).trim();
        if (inner) {
          flush();
          pushSigil({ kind: "speech", text: inner }, i + 1, close);
        } else {
          append(text.slice(i, close + 1), i);
        }
        i = close + 1;
        continue;
      }
    }

    // Thought / comms / styled emphasis.
    if (ch === "*") {
      const close = text.indexOf("*", i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close).trim();
        if (inner) {
          const standalone = isLineEdgeBefore(text, i) && isLineEdgeAfter(text, close);
          flush();
          pushSigil(classifyAsterisk(inner, standalone, context), i + 1, close);
        } else {
          append(text.slice(i, close + 1), i);
        }
        i = close + 1;
        continue;
      }
    }

    // Italic styling only.
    if (ch === "_") {
      const close = text.indexOf("_", i + 1);
      if (close !== -1) {
        const inner = text.slice(i + 1, close).trim();
        if (inner) {
          flush();
          pushSigil({ kind: "styled", text: inner }, i + 1, close);
        } else {
          append(text.slice(i, close + 1), i);
        }
        i = close + 1;
        continue;
      }
    }

    append(ch ?? "", i);
    i += 1;
  }
  flush();
  return entries;
}

/**
 * Segment a player message into ordered spans. Unmatched or empty sigils fall back to
 * literal narration text, so degenerate input never throws and never drops characters.
 */
export function parseMessageSpans(input: string | null | undefined, context: MessageSpanContext = {}): MessageSpan[] {
  return walkMessageSpans(input ?? "", context).map((entry) => entry.span);
}

/**
 * `parseMessageSpans` plus each span's `[start, end)` range in the input — the
 * SAME walker, so span classification can never diverge between the offset-free
 * consumers and the evidence-grounding one.
 */
export function parseMessageSpansWithOffsets(
  input: string | null | undefined,
  context: MessageSpanContext = {},
): MessageSpanWithOffsets[] {
  return walkMessageSpans(input ?? "", context).map((entry) => ({
    ...entry.span,
    start: entry.start,
    end: entry.end,
  }));
}
