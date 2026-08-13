/**
 * De-bracket a name the narrator wrapped in `[…]` where a speaker tag can never
 * go (owner report 2026-08-02, Fly: the character addressed the player as
 * `"Nice to see you, [Brian]."`).
 *
 * Square brackets are notation with exactly ONE meaning in a reply: the
 * line-opening `[Name] "…"` speaker tag the renderer strips and turns into a
 * speaker label (lib/segmenter.ts). Anywhere else — mid-sentence, and above all
 * INSIDE quoted dialogue — a bracketed name is not notation at all: the
 * segmenter only ever reads a tag at the START of a line, so the brackets
 * survive parsing and the player literally reads "[Brian]" in the bubble.
 *
 * Models drift into this because the prompt teaches them a name-in-brackets
 * grammar; the rule wording (engine/prompts/charter.ts §attributionTagRule) now
 * scopes brackets explicitly, and this module is the runtime backstop for the
 * replies that ignore it. Like the other two narrator filters
 * (narrator-artifacts.ts, narrator-repeats.ts) it wraps the model STREAM, so it
 * cleans the live deltas AND the accumulated text the route persists — a
 * bracketed name never reaches the DB or comes back as history, which would
 * otherwise teach the model in-context to keep writing them.
 *
 * The vocabulary is split in two because the two positions differ:
 * - `speakers` (the chat roster) may legitimately open a line as a tag, so a
 *   line-opening `[Name]` for one of them is left exactly as written.
 * - `plain` (the player, supporting cast) is never a tag anywhere — the
 *   renderer's tag vocabulary is the roster alone, so a line-opening
 *   `[Brian]` would leak literally too. Those are de-bracketed in every position.
 *
 * Only KNOWN names are touched. An unrecognized bracketed span (`[thunder]`, a
 * stray markdown link) is left alone: it may be prose the author meant, and
 * guessing is how a filter starts eating story.
 */

/** Longest bracketed span the segmenter will read as a tag (its TAG_RE bound). */
const MAX_TAG_INNER = 64;

/** A complete bracketed span on one line — the segmenter's tag shape, minus nesting. */
const BRACKET_SPAN = new RegExp(`\\[([^\\[\\]\\n]{1,${MAX_TAG_INNER}})\\]`, "g");

/** The same shape anchored at a line start — the one position a tag is legitimate. */
const LEADING_TAG = new RegExp(`^\\[([^\\[\\]\\n]{1,${MAX_TAG_INNER}})\\]`);

export interface SpeakerTagVocabulary {
  /** Names the renderer accepts as a line-opening tag (the chat roster, primary first). */
  speakers: readonly string[];
  /** Names that are never a tag in any position — the player, supporting cast. */
  plain?: readonly string[];
}

/** Match key: trimmed + lowercased, exactly as the segmenter keys its tag vocabulary. */
const key = (name: string): string => name.trim().toLowerCase();

interface TagSets {
  /** Keys allowed to open a line as a tag. */
  speakers: Set<string>;
  /** Every known key — de-bracketed wherever a tag cannot go. */
  all: Set<string>;
}

/**
 * Full names plus their first-name aliases — the narrator shortens
 * `[Sabrina Carpenter]` to `[Sabrina]` (segmenter §buildKnownMap). Unlike the
 * segmenter this adds the alias unconditionally: a first name shared by two
 * characters is ambiguous for ATTRIBUTION, but de-bracketing it is right either
 * way, since neither reading puts brackets in the middle of a sentence.
 */
function addName(name: string, ...sets: Set<string>[]): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const first = trimmed.split(/\s+/)[0] ?? "";
  for (const set of sets) {
    set.add(key(trimmed));
    if (first) set.add(key(first));
  }
}

function buildTagSets(vocab: SpeakerTagVocabulary): TagSets {
  const speakers = new Set<string>();
  const all = new Set<string>();
  for (const name of vocab.speakers) addName(name, speakers, all);
  for (const name of vocab.plain ?? []) addName(name, all);
  return { speakers, all };
}

/** De-bracket every known name on one line, sparing a legitimate leading speaker tag. */
function cleanLine(line: string, sets: TagSets, atLineStart: boolean): string {
  let kept = 0;
  if (atLineStart) {
    const tag = LEADING_TAG.exec(line);
    if (tag && sets.speakers.has(key(tag[1] ?? ""))) kept = tag[0].length;
  }
  const rest = line.slice(kept).replace(BRACKET_SPAN, (span, inner: string) => {
    return sets.all.has(key(inner)) ? inner.trim() : span;
  });
  return line.slice(0, kept) + rest;
}

/** Clean a run of text whose first line may start mid-line (`atLineStart` says). */
function cleanText(text: string, sets: TagSets, atLineStart: boolean): string {
  return text
    .split("\n")
    .map((line, i) => cleanLine(line, sets, i === 0 ? atLineStart : true))
    .join("\n");
}

/** One-shot clean for a complete string (non-streamed text, tests). */
export function stripMisplacedSpeakerTags(text: string, vocab: SpeakerTagVocabulary): string {
  const sets = buildTagSets(vocab);
  if (sets.all.size === 0) return text;
  return cleanText(text, sets, true);
}

/**
 * Length of the trailing run that could still grow into a bracketed span, or 0.
 * An unclosed `[` with no line break after it is held until the `]` arrives (or
 * until it is too long to be a name), so a span split across deltas — `[Bri` +
 * `an]` — is still recognized. Everything before it streams on immediately.
 */
function pendingSpanTailLength(buffer: string): number {
  const open = buffer.lastIndexOf("[");
  if (open < 0) return 0;
  const tail = buffer.slice(open);
  // Closed, or the line ended without closing ⇒ nothing left to decide.
  if (tail.includes("]") || tail.includes("\n")) return 0;
  // Too long to be a tag ⇒ the regex would not match it anyway; release it.
  if (tail.length > MAX_TAG_INNER + 1) return 0;
  return tail.length;
}

/**
 * Wrap a narrator token stream, de-bracketing known names outside the one
 * position a speaker tag belongs. Prose flows token-by-token; only an unclosed
 * `[…` run is held, and it flushes at stream end.
 */
export async function* stripMisplacedSpeakerTagStream(
  stream: AsyncIterable<string>,
  vocab: SpeakerTagVocabulary,
): AsyncGenerator<string> {
  const sets = buildTagSets(vocab);
  if (sets.all.size === 0) {
    yield* stream;
    return;
  }
  let buffer = "";
  let atLineStart = true; // stream start counts as a line start
  for await (const chunk of stream) {
    buffer += chunk;
    const hold = pendingSpanTailLength(buffer);
    if (hold >= buffer.length) continue; // the whole buffer is a possible partial span
    const ready = buffer.slice(0, buffer.length - hold);
    buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
    const out = cleanText(ready, sets, atLineStart);
    atLineStart = ready.endsWith("\n");
    if (out) yield out;
  }
  if (buffer) {
    const out = cleanText(buffer, sets, atLineStart);
    if (out) yield out;
  }
}
