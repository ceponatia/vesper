/**
 * Strip narrator-output artifacts that leak from the model's internal
 * scaffolding into the visible reply. Two families:
 *
 * 1. **AionLabs "uncensored response" wrapper tags.** `aion-labs/aion-2.0`
 *    (the session default narrator and a selectable chat narrator —
 *    lib/narrative-models.ts) wraps its answer in an internal
 *    `<uncensored_response>…</uncensored_response>` template and leaks the
 *    markers into the visible text — most often the closing tag at the very
 *    end of a reply, in several misspelled / negated forms we've observed:
 *
 *      </unsensored_response>   </uncensored_response>   </censored_response>
 *
 * 2. **Trailing meta-commentary notes.** The same
 *    model family sometimes appends a self-review paragraph addressed to the
 *    machinery — observed live 2026-07-12:
 *
 *      Note for the parser: This response accepts Brian's offer of…
 *
 *    A paragraph like that never belongs in fiction. When a line STARTS with
 *    such a marker ("Note for/to the parser/system/engine/narrator", "Parser
 *    note"), everything from that line to the end of the stream is cut —
 *    these notes are trailing self-commentary, and anything the model says
 *    after addressing the machinery isn't story.
 *
 * Left in place either artifact would (a) show in the chat feed / narration,
 * and (b) get persisted and fed straight back as message history (the chat
 * route saves the accumulated stream verbatim, and the pipeline saves
 * `turns.narration`), which teaches the model in-context that replies end
 * that way — a self-reinforcing loop that makes it emit the artifact MORE the
 * longer a conversation runs.
 *
 * So both narrator lanes (engine/character-chat.ts + engine/pipeline.ts) run
 * their model stream through {@link stripNarratorArtifactStream}. Stripping the
 * stream cleans BOTH surfaces at once: the live deltas the client renders AND the
 * accumulated text that gets persisted (the persisted value is just the sum of
 * the streamed deltas), so the artifact never reaches storage or history.
 */

// Matches every observed variant — opening or closing, with or without the
// leading slash. The stem is deliberately permissive (`un`? + `s`|`c` +
// `ensored_response`) so `unsensored` / `uncensored` / `censored` (and the stray
// `sensored`) all match; these tags never legitimately appear in prose, so a
// broad match is exactly right. The leading `\s*` swallows whitespace glued
// directly to a tag (the model puts the closing tag on its own line), so removing
// it doesn't leave a dangling blank line. New per-instance, so the global
// `lastIndex` of `.replace` is never shared across calls.
const artifactTag = (): RegExp => /\s*<\/?(?:un)?[sc]ensored_response\s*>/gi;

/** The full tag variants (closing `>` included), used to detect a partial tag at a stream boundary. */
const TAG_VARIANTS = ["uncensored_response>", "unsensored_response>", "censored_response>", "sensored_response>"] as const;

/** Longest full tag (`</unsensored_response>` = 22) plus headroom — caps how much a partial tag can hold back. */
const MAX_TAG_LEN = 24;

/**
 * Meta-note markers, matched case-insensitively at a LINE start (after
 * optional markdown decoration). Line-start + the full phrase keeps prose like
 * "she left a note for the parson" safe; fiction never opens a line addressing
 * the machinery.
 */
const META_NOTE_MARKERS = [
  "note for the parser",
  "note to the parser",
  "note for the system",
  "note to the system",
  "note for the engine",
  "note to the engine",
  "note for the narrator",
  "note to the narrator",
  "parser note",
] as const;

/** Markdown/decoration prefix tolerated before a marker: `**Note…`, `(Note…`, `> Note…`. */
const META_DECOR = /^[\s*_[(#>-]+/;

/** Longest marker (21) plus headroom — caps how long a normalized line-tail can hold back the stream. */
const MAX_META_LEN = 24;

/** Normalize a line for marker comparison: strip leading decoration, lowercase, collapse whitespace runs. */
function normalizeMetaLine(line: string): string {
  return line.replace(META_DECOR, "").toLowerCase().replace(/\s+/g, " ");
}

/**
 * Index at which a meta-note begins in `text`, or -1. Only line starts are
 * considered (`atTextStart` says whether index 0 is one); a hit folds any
 * immediately-preceding whitespace in, so the cut leaves no dangling blank
 * line before the removed note.
 */
function metaNoteCutIndex(text: string, atTextStart: boolean): number {
  let lineStart = 0;
  while (lineStart <= text.length) {
    const isLineStart = lineStart === 0 ? atTextStart : true; // subsequent iterations always follow a "\n"
    if (isLineStart) {
      const normalized = normalizeMetaLine(text.slice(lineStart));
      if (META_NOTE_MARKERS.some((m) => normalized.startsWith(m))) {
        let start = lineStart;
        while (start > 0 && /\s/.test(text[start - 1] ?? "")) start--;
        return start;
      }
    }
    const next = text.indexOf("\n", lineStart);
    if (next < 0) break;
    lineStart = next + 1;
  }
  return -1;
}

/**
 * Length of the trailing run of `buffer` that could still grow into a
 * meta-note marker, or 0. The last line (which is a line start per
 * `atBufferLineStart` / a preceding "\n") is held while its normalized text is
 * a strict prefix of some marker — released the moment it diverges, so
 * ordinary prose ("Note for the record, …") streams on after one boundary.
 * Preceding whitespace folds into the hold like the tag variant, so a note
 * that completes later vanishes together with its leading blank line.
 */
function pendingMetaTailLength(buffer: string, atBufferLineStart: boolean): number {
  const lastBreak = buffer.lastIndexOf("\n");
  const lineStart = lastBreak >= 0 ? lastBreak + 1 : 0;
  if (lineStart === 0 && !atBufferLineStart) return 0;
  const tail = buffer.slice(lineStart);
  if (tail === "") {
    // Buffer ends at a fresh line: hold the trailing whitespace run so a note
    // starting in the next chunk vanishes together with its leading blank line
    // (parity with the one-shot strip). Flushed untouched at stream end.
    let start = buffer.length;
    while (start > 0 && /\s/.test(buffer[start - 1] ?? "")) start--;
    return buffer.length - start;
  }
  const normalized = normalizeMetaLine(tail);
  if (normalized.length >= MAX_META_LEN) return 0;
  // "" (all decoration so far) could still become "**Note for the parser"; hold it.
  const isPrefix = normalized === "" || META_NOTE_MARKERS.some((m) => m.startsWith(normalized));
  if (!isPrefix) return 0;
  let start = lineStart;
  while (start > 0 && /\s/.test(buffer[start - 1] ?? "")) start--;
  return buffer.length - start;
}

/** One-shot strip for a complete string (non-streamed text, tests). */
export function stripNarratorArtifacts(text: string): string {
  const untagged = text.replace(artifactTag(), "");
  const cut = metaNoteCutIndex(untagged, true);
  return cut >= 0 ? untagged.slice(0, cut) : untagged;
}

/**
 * Length of the trailing run of `buffer` that could still grow into an artifact
 * tag (so it must be held back rather than emitted), or 0 if nothing is pending.
 * A pending run is an unclosed `<…` (no `>` yet, no whitespace — our tags contain
 * neither) whose text after the optional `</` is a prefix of some TAG_VARIANT;
 * any immediately-preceding whitespace is folded in so a `\n` that turns out to
 * sit right before a stripped tag vanishes with it instead of leaving a blank line.
 */
function pendingTagTailLength(buffer: string): number {
  const lt = buffer.lastIndexOf("<");
  if (lt < 0) return 0;
  const tail = buffer.slice(lt);
  // A `>` or whitespace means this `<…>` is a complete element or plain text, not
  // a still-forming tag (a real tag would already be gone via the regex); release it.
  if (tail.includes(">") || /\s/.test(tail) || tail.length >= MAX_TAG_LEN) return 0;
  const afterBracket = (tail.startsWith("</") ? tail.slice(2) : tail.slice(1)).toLowerCase();
  // "<" / "</" alone (afterBracket === "") is a possible tag start; otherwise it
  // must be a prefix of one of the variants to be worth holding.
  if (afterBracket && !TAG_VARIANTS.some((v) => v.startsWith(afterBracket))) return 0;
  let start = lt;
  while (start > 0 && /\s/.test(buffer[start - 1] ?? "")) start--;
  return buffer.length - start;
}

/**
 * Wrap a narrator token stream, removing artifact tags as they pass — including a
 * tag split across delta boundaries (`</uncen` + `sored_response>`) — and cutting
 * a trailing meta-note ("Note for the parser: …") from its line start through the
 * end of the stream. Ordinary text streams through with at most a token of
 * latency on a `<` or a line opening with "Note…"; only a trailing run that could
 * be the start of an artifact is buffered, and it's flushed at stream end.
 */
export async function* stripNarratorArtifactStream(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  let lastEmitted = "\n"; // stream start counts as a line start
  let suppressing = false;
  for await (const chunk of stream) {
    if (suppressing) continue; // a meta-note runs to end of stream; keep draining
    buffer = (buffer + chunk).replace(artifactTag(), "");
    const atLineStart = lastEmitted === "\n";
    const cut = metaNoteCutIndex(buffer, atLineStart);
    if (cut >= 0) {
      const head = buffer.slice(0, cut);
      if (head) yield head;
      buffer = "";
      suppressing = true;
      continue;
    }
    const hold = Math.max(pendingTagTailLength(buffer), pendingMetaTailLength(buffer, atLineStart));
    if (hold < buffer.length) {
      const emit = buffer.slice(0, buffer.length - hold);
      yield emit;
      lastEmitted = emit[emit.length - 1] ?? lastEmitted;
      buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
    }
    // hold === buffer.length ⇒ the whole buffer is a potential partial artifact; keep buffering.
  }
  if (!suppressing && buffer) {
    const flushed = buffer.replace(artifactTag(), "");
    const cut = metaNoteCutIndex(flushed, lastEmitted === "\n");
    const out = cut >= 0 ? flushed.slice(0, cut) : flushed;
    if (out) yield out;
  }
}
