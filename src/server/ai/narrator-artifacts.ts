/**
 * Strip the AionLabs "uncensored response" wrapper tags that leak into narrator
 * output. `aion-labs/aion-2.0` (the session default narrator and a selectable
 * chat narrator — lib/narrative-models.ts) wraps its answer in an internal
 * `<uncensored_response>…</uncensored_response>` template and leaks the markers
 * into the visible text — most often the closing tag at the very end of a reply,
 * in several misspelled / negated forms we've observed:
 *
 *   </unsensored_response>   </uncensored_response>   </censored_response>
 *
 * Left in place the tag would (a) show in the chat feed / narration, and (b) get
 * persisted and fed straight back as message history (the chat route saves the
 * accumulated stream verbatim, and the pipeline saves `turns.narration`), which
 * teaches the model in-context that replies end that way — a self-reinforcing
 * loop that makes it emit the tag MORE the longer a conversation runs.
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

/** One-shot strip for a complete string (non-streamed text, tests). */
export function stripNarratorArtifacts(text: string): string {
  return text.replace(artifactTag(), "");
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
 * tag split across delta boundaries (`</uncen` + `sored_response>`). Ordinary text
 * streams through with at most a token of latency on a `<`; only a trailing run
 * that could be the start of a tag is buffered, and it's flushed at stream end.
 */
export async function* stripNarratorArtifactStream(stream: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer = (buffer + chunk).replace(artifactTag(), "");
    const hold = pendingTagTailLength(buffer);
    if (hold < buffer.length) {
      yield buffer.slice(0, buffer.length - hold);
      buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
    }
    // hold === buffer.length ⇒ the whole buffer is a potential partial tag; keep buffering.
  }
  if (buffer) {
    const flushed = buffer.replace(artifactTag(), "");
    if (flushed) yield flushed;
  }
}
