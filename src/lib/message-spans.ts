/**
 * Deterministic player-message span parser (player-input-perception.plan.md slice 4).
 *
 * Pure, IO-free, regex-first (in the spirit of `engine/chat-intent.ts`): it segments a
 * player message into ordered spans by its optional sigil grammar, turning the hardest
 * problem in the perception partition (semantic interiority / channel detection) into a
 * cheap parse WHEN the player opts into the sigils. A message with no sigils yields a
 * single narration span, so the prompt-only partition (slice 1) still carries the read.
 *
 * The sigil grammar (§Markup lane):
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
 * This module is the SINGLE parser implementation — the tail-note renderer (slice 4), the
 * transcript renderer (slice 5), and the archivist fact-channel hint (slice 6) all consume
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
 * The fact-store channel a span establishes knowledge through (slice 6's forward-compatible
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

/** The narrator's texted-reply output grammar (slice 4): round-trips through `parseMessageSpans` as a comms span. */
export function formatCommsReply(sender: string, text: string): string {
  return `*${sender.trim()}: ${text.trim()}*`;
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
 * Segment a player message into ordered spans. Unmatched or empty sigils fall back to
 * literal narration text, so degenerate input never throws and never drops characters.
 */
export function parseMessageSpans(input: string | null | undefined, context: MessageSpanContext = {}): MessageSpan[] {
  const text = input ?? "";
  const spans: MessageSpan[] = [];
  let buf = "";
  const flush = (): void => {
    const t = buf.trim();
    if (t) spans.push({ kind: "narration", text: t });
    buf = "";
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
          spans.push({ kind: "ooc", text: inner });
        } else {
          buf += text.slice(i, close + 2);
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
          spans.push({ kind: "speech", text: inner });
        } else {
          buf += text.slice(i, close + 1);
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
          spans.push(classifyAsterisk(inner, standalone, context));
        } else {
          buf += text.slice(i, close + 1);
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
          spans.push({ kind: "styled", text: inner });
        } else {
          buf += text.slice(i, close + 1);
        }
        i = close + 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return spans;
}
