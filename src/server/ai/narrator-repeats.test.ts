import { describe, expect, it } from "vitest";
import { collapseRepeatedBlocks, collapseRepeatedBlocksStream } from "./narrator-repeats";

/** Feed an array of deltas through the streaming suppressor and join the result. */
async function streamCollapse(chunks: string[]): Promise<string> {
  async function* gen(): AsyncGenerator<string> {
    for (const c of chunks) yield c;
  }
  let out = "";
  for await (const piece of collapseRepeatedBlocksStream(gen())) out += piece;
  return out;
}

/** Split a string into token-sized deltas to simulate a live model stream. */
function tokenize(text: string, size = 6): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// The observed Aion 3.0 failure (2026-07-11), verbatim shape: the whole reply
// repeated after a run of blank lines.
const MINA_REPLY = [
  "Mina's brow lifts just slightly — the kind of almost-expression that could go either way.",
  '[Mina] "A little." She takes a sip, considering. "But honestly? Most people who say they like history mean they watched one documentary. You\'re on book two of a series. That\'s already ahead of the curve."',
  "She tilts her head, thumb tapping the side of her cup once.",
  '[Mina] "Which series, though? There\'s a _lot_ of Roman Empire books out there."',
].join("\n\n");

describe("collapseRepeatedBlocks (one-shot)", () => {
  it("drops a verbatim whole-reply duplicate and the blank-line gap before it", () => {
    expect(collapseRepeatedBlocks(`${MINA_REPLY}\n\n\n\n\n${MINA_REPLY}`)).toBe(MINA_REPLY);
  });

  it("drops a triple repeat copy by copy", () => {
    expect(collapseRepeatedBlocks(`${MINA_REPLY}\n\n${MINA_REPLY}\n\n${MINA_REPLY}`)).toBe(MINA_REPLY);
  });

  it("drops a duplicated trailing run of paragraphs (partial-suffix tandem)", () => {
    const tail = "She tilts her head, thumb tapping the side of her cup once — a long, deliberate pause that stretches the moment.";
    const text = `An opening paragraph that is not repeated.\n\n${tail}\n\n${tail}`;
    expect(collapseRepeatedBlocks(text)).toBe(`An opening paragraph that is not repeated.\n\n${tail}`);
  });

  it("drops a whole-reply duplicate even when the reply is a short one-liner", () => {
    expect(collapseRepeatedBlocks('[Mina] "Hey."\n\n[Mina] "Hey."')).toBe('[Mina] "Hey."');
  });

  it("keeps a duplicate that is followed by fresh content when it is short (stylistic echo)", () => {
    const text = "Knock.\n\nKnock.\n\nShe waits, listening for footsteps on the other side of the door.";
    expect(collapseRepeatedBlocks(text)).toBe(text);
  });

  it("keeps fresh content that follows a dropped long duplicate", () => {
    const fresh = "Outside, the rain keeps falling.";
    expect(collapseRepeatedBlocks(`${MINA_REPLY}\n\n${MINA_REPLY}\n\n${fresh}`)).toBe(`${MINA_REPLY}\n\n${fresh}`);
  });

  it("keeps a short refrain of the opening paragraph at the end (not a suffix repeat)", () => {
    const text = "The bell rings.\n\nShe crosses the room without hurry, coat over one arm.\n\nThe bell rings.";
    expect(collapseRepeatedBlocks(text)).toBe(text);
  });

  it("keeps an isolated mid-reply echo of one earlier paragraph", () => {
    const beat = "Silence.";
    const text = `${beat}\n\nShe sets the cup down and studies him across the table.\n\n${beat}\n\nThen she laughs, finally, and the tension breaks.`;
    expect(collapseRepeatedBlocks(text)).toBe(text);
  });

  it("passes a reply with no repetition through byte-identical", () => {
    expect(collapseRepeatedBlocks(MINA_REPLY)).toBe(MINA_REPLY);
  });

  it("passes paragraphs sharing a dialogue opener through untouched", () => {
    const text = '[Mina] "A little."\n\n[Mina] "A lot, actually." She grins.';
    expect(collapseRepeatedBlocks(text)).toBe(text);
  });

  it("flushes verbatim when a copy diverges partway (near-repeat, not tandem)", () => {
    const text = `First paragraph of the reply here.\n\nFirst paragraph of the reply — no, different after all.`;
    expect(collapseRepeatedBlocks(text)).toBe(text);
  });

  it("matches a duplicate whose internal whitespace differs, keeping the first copy's bytes", () => {
    const first = "She tilts her head, thumb tapping the side of her cup once, watching him over the rim of it.";
    const second = first.replace("head, thumb", "head,  thumb");
    expect(collapseRepeatedBlocks(`Intro paragraph, never repeated afterwards.\n\n${first}\n\n${second}`)).toBe(
      `Intro paragraph, never repeated afterwards.\n\n${first}`,
    );
  });

  it("trims trailing whitespace at the end of the reply", () => {
    expect(collapseRepeatedBlocks("Done.\n\n\n")).toBe("Done.");
  });
});

describe("collapseRepeatedBlocksStream", () => {
  it("drops a whole-reply duplicate arriving as token-sized deltas", async () => {
    expect(await streamCollapse(tokenize(`${MINA_REPLY}\n\n\n\n${MINA_REPLY}`))).toBe(MINA_REPLY);
  });

  it("streams a clean reply through unchanged across arbitrary chunk boundaries", async () => {
    for (const size of [1, 3, 7, 50]) {
      expect(await streamCollapse(tokenize(MINA_REPLY, size))).toBe(MINA_REPLY);
    }
  });

  it("handles a paragraph separator split across deltas, preserving its bytes", async () => {
    const deltas = ["One paragraph here, long enough to matter.", "\n", "  ", "\n", "And a second paragraph after the break."];
    expect(await streamCollapse(deltas)).toBe(deltas.join(""));
  });

  it("drops a duplicate cut off mid-copy by a stop/abort once it is substantial", async () => {
    const cut = MINA_REPLY.slice(0, 150);
    expect(await streamCollapse(tokenize(`${MINA_REPLY}\n\n${cut}`))).toBe(MINA_REPLY);
  });

  it("flushes a short inconclusive hold at stream end", async () => {
    const text = "She waits by the window, counting the seconds.\n\nShe waits";
    expect(await streamCollapse(tokenize(text))).toBe(text);
  });
});
