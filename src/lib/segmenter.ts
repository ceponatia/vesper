import type { TurnChunkEvent } from "@/contracts/turns/stream";

/**
 * Speaker-tagged narrative parsing (docs/prompts.md §Dialogue tagging). Pure —
 * lives in `lib` so both the server turn pipeline and the client chat renderer
 * (which never imports `server/*`) can share it.
 *
 * The narrator emits NPC dialogue lines as `[Name] "…"`; this module splits raw
 * text into per-speaker segments (null speaker = narrator prose) both after the
 * fact and incrementally during streaming. Unknown bracketed names fail closed to
 * narrator prose. Ported from the proven old-app segmenter.
 *
 * The chat lane relaxes the required tag (docs/prompts.md §Dialogue tagging): in a
 * one-on-one the renderer opts into `attributeStandaloneQuotes`, so an untagged
 * whole-line quote attributes to the sole known name exactly as if tagged. The
 * session lane never sets it — a quote embedded in narration stays narrator prose
 * (flavor NPCs live in prose, by design).
 */

export interface SpeakerSegment {
  /** null → narrator prose */
  speaker: string | null;
  content: string;
}

export interface SegmenterOptions {
  /**
   * Attribute an untagged whole-line quoted utterance to the sole known name — but
   * ONLY when `knownNames.length === 1` (a one-on-one, where attribution is
   * unambiguous). A line that starts with an opening quote and whose first close
   * quote is its final character is treated exactly like a `[Name]`-tagged line;
   * a quote with prose outside it (`her voice drifts: "…"`, `"…" she said`) stays
   * narrator prose. Default off — the session lane keeps required-tag behavior.
   */
  attributeStandaloneQuotes?: boolean;
}

const TAG_RE = /^\[([^\]\n]{1,64})\]\s?(.*)$/;

/**
 * Opening→closing quote pairs recognized for standalone-quote attribution: the
 * straight double quote and the narrator's typographic pair. Single quotes are
 * deliberately excluded (apostrophes / nested quotes / flavor asides), and
 * character dialogue is double-quoted by the prompt.
 */
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "“": "”" };

/**
 * How many lines the standalone quote opening at line `L` spans, or null when it is
 * not a clean whole-utterance quote. A quote is clean when its close is the final
 * non-whitespace character of its (single- or multi-line) block, so a trailing beat
 * (`"…" she said`) and an embedded quote (prose before the open) are both rejected.
 */
function quoteBlockLen(lines: string[], L: number, close: string): number | null {
  const first = (lines[L] ?? "").trim();
  const closeOnFirst = first.indexOf(close, 1);
  if (closeOnFirst !== -1) {
    // Single line: the close must end the line and enclose non-empty content.
    return closeOnFirst === first.length - 1 && closeOnFirst > 1 ? 1 : null;
  }
  // Multi-line: the quote continues over contiguous non-blank lines until a close.
  for (let k = L + 1; k < lines.length; k++) {
    const t = (lines[k] ?? "").trim();
    if (t === "") return null; // a paragraph break before the close → not one utterance
    const idx = t.indexOf(close);
    if (idx !== -1) return idx === t.length - 1 ? k - L + 1 : null;
  }
  return null; // never closed (an open quote / streaming partial tail) → stays prose
}

/**
 * Line indices that begin a standalone-quote block to attribute to the sole name.
 * A quote-opening line can never be a `[tag]` (tags open with `[`), so no tag check
 * is needed. Only the block's FIRST line is marked; a multi-line quote's remaining
 * lines ride the existing soft-wrap continuation.
 */
function standaloneQuoteStarts(lines: string[]): Set<number> {
  const starts = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const open = (lines[i] ?? "").trim()[0];
    const close = open !== undefined ? QUOTE_PAIRS[open] : undefined;
    const len = close !== undefined ? quoteBlockLen(lines, i, close) : null;
    if (len !== null) {
      starts.add(i);
      i += len;
    } else {
      i++;
    }
  }
  return starts;
}

function buildKnownMap(knownNames: string[]): Map<string, string> {
  return new Map(knownNames.map((name) => [name.trim().toLowerCase(), name]));
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Line-oriented parse. Rules:
 * - `[Name] text` at line start, where Name matches a known name
 *   case-insensitively, starts (or continues) that speaker's segment.
 * - Untagged non-blank lines directly after a tagged line (no blank line
 *   between) continue the speaker's segment (soft wrap).
 * - A blank line ends a speaker segment; consecutive same-speaker tags merge
 *   into one segment with a paragraph break. Narrator prose merges across
 *   blank lines (paragraphs stay in one narrator segment).
 * - Everything else (including unknown bracketed names) is narrator prose.
 */
export function parseSegments(
  text: string,
  knownNames: string[],
  options: SegmenterOptions = {},
): SpeakerSegment[] {
  const known = buildKnownMap(knownNames);
  const lines = text.split("\n");
  // Standalone-quote attribution is a one-on-one affordance: only with exactly one
  // known name is the sole speaker unambiguous.
  const soleName = options.attributeStandaloneQuotes && knownNames.length === 1 ? (knownNames[0] ?? null) : null;
  const quoteStarts = soleName !== null ? standaloneQuoteStarts(lines) : null;

  const segments: SpeakerSegment[] = [];
  let cur: { speaker: string | null; lines: string[] } | null = null;
  let pendingBlanks = 0;

  const flushCur = () => {
    if (!cur) return;
    const trimmed = trimBlankEdges(cur.lines);
    if (trimmed.length) segments.push({ speaker: cur.speaker, content: trimmed.join("\n") });
    cur = null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    const m = TAG_RE.exec(line);
    const tagName = m?.[1];
    const canonical = tagName !== undefined ? known.get(tagName.trim().toLowerCase()) : undefined;

    if (m && canonical !== undefined) {
      if (cur && cur.speaker === canonical) {
        if (pendingBlanks > 0 && cur.lines.length) cur.lines.push("");
      } else {
        flushCur();
        cur = { speaker: canonical, lines: [] };
      }
      cur.lines.push(m[2] ?? "");
      pendingBlanks = 0;
      continue;
    }

    if (line.trim() === "") {
      pendingBlanks++;
      continue;
    }

    // Untagged whole-line quote → attribute to the sole name, exactly like a tag
    // (the block's continuation lines ride the soft-wrap rule below). The full line
    // is the content: there is no tag prefix to strip.
    if (soleName !== null && quoteStarts?.has(idx)) {
      if (cur && cur.speaker === soleName) {
        if (pendingBlanks > 0 && cur.lines.length) cur.lines.push("");
      } else {
        flushCur();
        cur = { speaker: soleName, lines: [] };
      }
      cur.lines.push(line);
      pendingBlanks = 0;
      continue;
    }

    // Untagged non-blank line.
    if (cur && cur.speaker !== null && pendingBlanks === 0) {
      // Soft-wrap continuation of the speaker's tagged line.
      cur.lines.push(line);
    } else {
      if (cur && cur.speaker === null) {
        for (let i = 0; i < pendingBlanks; i++) cur.lines.push("");
      } else {
        flushCur();
        cur = { speaker: null, lines: [] };
      }
      cur.lines.push(line);
    }
    pendingBlanks = 0;
  }

  flushCur();
  return segments;
}

export interface StreamingSegmenter {
  /** Feed a raw model chunk; returns delta events safe to display now. */
  push(chunk: string): TurnChunkEvent[];
  /** Flush any held-back text once the stream ends. */
  finish(): TurnChunkEvent[];
}

/**
 * Incremental segmenter for streamed chunks. Re-parses the accumulated safe
 * prefix on each push and emits append-only TurnChunkEvent deltas. The only
 * text held back from display is a trailing partial line that could still
 * become a speaker tag (starts with `[`, no `]` yet, short enough to still
 * match a known name).
 */
export function createSegmenter(knownNames: string[]): StreamingSegmenter {
  const maxTagLen = knownNames.reduce((max, name) => Math.max(max, name.length), 0) + 3;
  let raw = "";
  let emitted: SpeakerSegment[] = [];

  function safeText(): string {
    const lastNl = raw.lastIndexOf("\n");
    const partial = raw.slice(lastNl + 1);
    const couldBeTag = partial.startsWith("[") && !partial.includes("]") && partial.length <= maxTagLen;
    return couldBeTag ? raw.slice(0, lastNl + 1) : raw;
  }

  function diffAgainstEmitted(next: SpeakerSegment[]): TurnChunkEvent[] {
    const events: TurnChunkEvent[] = [];
    for (let i = 0; i < next.length; i++) {
      const seg = next[i];
      if (!seg) continue;
      const prev = emitted[i];
      const grown = prev ? seg.content.slice(prev.content.length) : seg.content;
      if (grown) {
        events.push({ segmentIndex: i, speaker: seg.speaker, content: grown });
      }
    }
    emitted = next;
    return events;
  }

  return {
    push(chunk: string): TurnChunkEvent[] {
      raw += chunk;
      return diffAgainstEmitted(parseSegments(safeText(), knownNames));
    },
    finish(): TurnChunkEvent[] {
      return diffAgainstEmitted(parseSegments(raw, knownNames));
    },
  };
}
