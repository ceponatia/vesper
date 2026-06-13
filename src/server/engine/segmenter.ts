import type { TurnChunkEvent } from "@/contracts/turns/stream";

/**
 * Speaker-tagged narrative parsing (docs/prompts.md §Dialogue tagging).
 * The narrator emits NPC dialogue lines as `[Name] "…"`; this module splits
 * raw text into per-speaker segments (null speaker = narrator prose) both
 * after the fact and incrementally during streaming. Unknown bracketed names
 * fail closed to narrator prose. Ported from the proven old-app segmenter.
 */

export interface SpeakerSegment {
  /** null → narrator prose */
  speaker: string | null;
  content: string;
}

const TAG_RE = /^\[([^\]\n]{1,64})\]\s?(.*)$/;

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
export function parseSegments(text: string, knownNames: string[]): SpeakerSegment[] {
  const known = buildKnownMap(knownNames);
  const segments: SpeakerSegment[] = [];
  let cur: { speaker: string | null; lines: string[] } | null = null;
  let pendingBlanks = 0;

  const flushCur = () => {
    if (!cur) return;
    const lines = trimBlankEdges(cur.lines);
    if (lines.length) segments.push({ speaker: cur.speaker, content: lines.join("\n") });
    cur = null;
  };

  for (const line of text.split("\n")) {
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
