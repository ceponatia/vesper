/**
 * Collapse narrator "tandem repeats" — the block-level self-duplication some
 * abliterated narrator models produce (Aion 3.0 observed, 2026-07-11): the reply
 * ends, a run of blank lines follows, then a verbatim copy of the reply (or of
 * its trailing paragraphs) streams again. Left in place the duplicate would
 * (a) render twice in the chat feed / narration and (b) persist and come back as
 * message history, teaching the model in-context that replies look like that —
 * the same self-reinforcing loop as the wrapper tags in narrator-artifacts.ts.
 *
 * Both narrator lanes (engine/character-chat.ts + engine/pipeline.ts) compose
 * {@link collapseRepeatedBlocksStream} after the artifact stripper, so the live
 * deltas AND the accumulated persisted text are cleaned at one seam — nothing of
 * a duplicate reaches the client, the DB row, or future context.
 *
 * What is suppressed is deliberately narrow — paragraph-aligned and verbatim
 * (whitespace-insensitively): a run of blank-line-separated paragraphs that
 * re-traces, in order, a contiguous run of earlier paragraphs ending exactly
 * where the repetition began — i.e. the reply repeats its own suffix (a tandem
 * repeat). Anything else — paraphrased near-repeats, an isolated mid-reply echo
 * of one earlier paragraph, a short stylistic refrain — flushes through intact.
 *
 * Streaming shape: prose flows token-by-token. Each new paragraph is briefly
 * gated while its opening characters still prefix-match an earlier paragraph
 * (usually a handful of characters — shared "[Name] " dialogue openers being the
 * common case); on divergence the held text flushes verbatim. A paragraph that
 * completes as an exact duplicate stays held while the run keeps matching, so a
 * real tandem repeat is dropped before any of it is emitted. A completed suffix
 * copy of ≥ MIN_TANDEM_DROP_CHARS drops immediately (a triple repeat drops
 * copy-by-copy); a shorter completed copy drops only if the stream ends there (a
 * duplicated one-liner reply) and flushes if real content follows (a stylistic
 * echo). An incomplete re-trace of ≥ MIN_TANDEM_DROP_CHARS at stream end (a
 * duplicate cut off by Stop/abort) also drops. Trailing whitespace at stream end
 * is always dropped.
 */

/** A blank line — the paragraph separator (newline, optional spaces/tabs, newline). */
const BLANK_LINE = /\n[^\S\n]*\n/;

/** A trailing newline run that could still grow into a blank line — held back in free flow. */
const PARTIAL_SEP_TAIL = /\n[^\S\n]*$/;

/** Minimum whitespace-collapsed length for a re-trace to drop without waiting for stream end. */
const MIN_TANDEM_DROP_CHARS = 80;

/** Whitespace-insensitive comparison form of a paragraph (or partial paragraph). */
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

interface HeldParagraph {
  /** Original bytes — the preceding whitespace separator plus the paragraph text. */
  raw: string;
  /** Collapsed form, appended to the emitted-paragraph list if the run flushes. */
  norm: string;
}

class RepeatSuppressor {
  /** Collapsed forms of the paragraphs already emitted, in order. */
  private paras: string[] = [];
  /** Completed paragraphs currently held as a possible tandem re-trace. */
  private held: HeldParagraph[] = [];
  /** Candidate start indices j such that `held` matches paras[j .. j+held.length-1]. */
  private cands: number[] = [];
  /** Collapsed length of the held run, for the drop threshold. */
  private heldLen = 0;
  /** A candidate completed the reply's suffix but was under the drop threshold. */
  private suffixDone = false;
  /** Whitespace preceding the paragraph being read (unemitted until classified). */
  private sep = "";
  /** Raw text of the paragraph currently being read. */
  private cur = "";
  /** Prefix of `cur` already emitted (free-flow mode only; 0 while gated). */
  private curEmitted = 0;
  /** True while `cur` could still be re-tracing an earlier paragraph. */
  private tracking = false;
  private inPara = false;
  private out: string[] = [];

  push(chunk: string): string {
    let text = chunk;
    while (text) {
      if (!this.inPara) {
        const i = text.search(/\S/);
        if (i < 0) {
          this.sep += text;
          break;
        }
        this.sep += text.slice(0, i);
        text = text.slice(i);
        this.startParagraph();
      }
      this.cur += text;
      text = "";
      const m = BLANK_LINE.exec(this.cur);
      if (m) {
        const rest = this.cur.slice(m.index);
        this.completeParagraph(this.cur.slice(0, m.index));
        this.inPara = false;
        this.sep = "";
        this.cur = "";
        this.curEmitted = 0;
        text = rest; // the separator run + whatever follows it
        continue;
      }
      this.partialProgress();
    }
    return this.take();
  }

  /** Resolve whatever is still held at stream end (see the module doc's rules). */
  finish(): string {
    if (this.inPara && this.tracking) {
      // Ended mid re-trace. If the paragraph in hand exactly completes a copy of
      // the reply's suffix (the usual case — a duplicate's last paragraph gets
      // no trailing blank line), it is the duplicate regardless of length; a
      // substantial partial run is one too (a duplicate cut off by Stop/abort).
      // Only a short inconclusive hold is kept.
      const norm = collapse(this.cur);
      const m = this.held.length;
      const completesSuffix = this.cands.some((j) => this.paras[j + m] === norm && j + m + 1 === this.paras.length);
      if (completesSuffix || this.heldLen + norm.length >= MIN_TANDEM_DROP_CHARS) {
        this.dropHeld();
      } else {
        this.flushHeld();
        this.out.push(this.sep + this.cur.slice(0, this.safeEnd()));
      }
    } else if (this.inPara) {
      const end = this.safeEnd();
      if (end > this.curEmitted) this.out.push(this.cur.slice(this.curEmitted, end));
    } else if (this.suffixDone) {
      // The reply ended right after a completed (short) copy of its own suffix —
      // a duplicated one-liner, not a refrain. Drop it.
      this.dropHeld();
    } else if (this.held.length > 0) {
      // Ended at a paragraph boundary mid-run: same substantial/short rule.
      if (this.heldLen >= MIN_TANDEM_DROP_CHARS) this.dropHeld();
      else this.flushHeld();
    }
    this.sep = "";
    this.cur = "";
    this.inPara = false;
    return this.take();
  }

  private take(): string {
    const s = this.out.join("");
    this.out = [];
    return s;
  }

  private startParagraph(): void {
    this.inPara = true;
    // Real content after a short completed suffix copy — a stylistic echo, keep it.
    if (this.suffixDone) this.flushHeld();
    if (this.held.length === 0) this.cands = this.paras.map((_, i) => i);
    this.tracking = this.cands.length > 0;
    if (!this.tracking) this.emitSep();
  }

  /** Filter candidates against the growing paragraph; emit freely once diverged. */
  private partialProgress(): void {
    if (this.tracking) {
      const p = collapse(this.cur);
      const m = this.held.length;
      this.cands = this.cands.filter((j) => {
        const target = this.paras[j + m];
        return target !== undefined && target.startsWith(p);
      });
      if (this.cands.length > 0) return; // still plausibly re-tracing — hold
      this.tracking = false;
      this.flushHeld();
      this.emitSep();
    }
    const end = this.safeEnd();
    if (end > this.curEmitted) {
      this.out.push(this.cur.slice(this.curEmitted, end));
      this.curEmitted = end;
    }
  }

  private completeParagraph(text: string): void {
    const norm = collapse(text);
    if (!this.tracking) {
      // Free flow: emit the remainder (curEmitted never passes the separator's
      // first newline, so it is always ≤ text.length).
      if (text.length > this.curEmitted) this.out.push(text.slice(this.curEmitted));
      this.paras.push(norm);
      return;
    }
    const m = this.held.length;
    const survivors = this.cands.filter((j) => this.paras[j + m] === norm);
    if (survivors.length === 0) {
      // Prefix-matched but completed differently — not a duplicate after all.
      this.tracking = false;
      this.flushHeld();
      this.out.push(this.sep + text);
      this.sep = "";
      this.paras.push(norm);
      return;
    }
    this.held.push({ raw: this.sep + text, norm });
    this.sep = "";
    this.heldLen += norm.length + 1;
    this.cands = survivors;
    if (survivors.some((j) => j + this.held.length === this.paras.length)) {
      // The held run is a complete verbatim copy of the reply's suffix.
      if (this.heldLen >= MIN_TANDEM_DROP_CHARS) this.dropHeld();
      else this.suffixDone = true;
    }
  }

  /** The held run turned out legitimate — emit it verbatim and count it as prose. */
  private flushHeld(): void {
    for (const h of this.held) {
      this.out.push(h.raw);
      this.paras.push(h.norm);
    }
    this.resetHeld();
  }

  /** The held run is a confirmed duplicate — discard it (paras stays as emitted). */
  private dropHeld(): void {
    this.resetHeld();
  }

  private resetHeld(): void {
    this.held = [];
    this.cands = [];
    this.heldLen = 0;
    this.suffixDone = false;
  }

  private emitSep(): void {
    if (this.sep) {
      this.out.push(this.sep);
      this.sep = "";
    }
  }

  /** End of the emit-safe prefix of `cur` (holds back a newline run that could become a blank line). */
  private safeEnd(): number {
    const t = PARTIAL_SEP_TAIL.exec(this.cur);
    return t ? t.index : this.cur.length;
  }
}

/** One-shot collapse for a complete string (non-streamed text, backfills, tests). */
export function collapseRepeatedBlocks(text: string): string {
  const s = new RepeatSuppressor();
  return s.push(text) + s.finish();
}

/**
 * Wrap a narrator token stream, suppressing paragraph-aligned tandem repeats as
 * they form. Ordinary prose streams through with at most a short gate at each
 * paragraph opener; a detected duplicate block (and the blank-line gap before
 * it) is never yielded, so the accumulated/persisted text is clean too.
 */
export async function* collapseRepeatedBlocksStream(stream: AsyncIterable<string>): AsyncGenerator<string> {
  const suppressor = new RepeatSuppressor();
  for await (const chunk of stream) {
    const out = suppressor.push(chunk);
    if (out) yield out;
  }
  const tail = suppressor.finish();
  if (tail) yield tail;
}
