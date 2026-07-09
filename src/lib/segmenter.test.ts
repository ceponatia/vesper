import { describe, expect, it } from "vitest";
import type { TurnChunkEvent } from "@/contracts/turns/stream";
import { createSegmenter, parseSegments } from "./segmenter";

const KNOWN = ["Maya", "Rhett Calloway"];

/** Rebuild per-segment text from deltas to compare against a full parse. */
function assemble(events: TurnChunkEvent[]): Array<{ speaker: string | null; content: string }> {
  const segments: Array<{ speaker: string | null; content: string }> = [];
  for (const e of events) {
    const seg = segments[e.segmentIndex];
    if (seg) seg.content += e.content;
    else segments[e.segmentIndex] = { speaker: e.speaker, content: e.content };
  }
  return segments;
}

describe("parseSegments", () => {
  it("returns a single narrator segment when there are no tags", () => {
    const text = "The rain kept falling.\n\nNobody spoke for a while.";
    expect(parseSegments(text, KNOWN)).toEqual([{ speaker: null, content: text }]);
  });

  it("splits narrator prose and tagged dialogue", () => {
    const text = 'The door creaked open.\n[Maya] "You came back."\n\nShe stepped aside.';
    expect(parseSegments(text, KNOWN)).toEqual([
      { speaker: null, content: "The door creaked open." },
      { speaker: "Maya", content: '"You came back."' },
      { speaker: null, content: "She stepped aside." },
    ]);
  });

  it("treats unknown bracketed names as narrator prose", () => {
    const text = '[Stranger] "Who goes there?"';
    expect(parseSegments(text, KNOWN)).toEqual([{ speaker: null, content: text }]);
  });

  it("matches tag names case-insensitively and returns canonical casing", () => {
    const segments = parseSegments('[maya] "Hi."', KNOWN);
    expect(segments).toEqual([{ speaker: "Maya", content: '"Hi."' }]);
  });

  it("continues a speaker segment across soft-wrapped untagged lines", () => {
    const text = '[Maya] "It was a long week,\nand I kept thinking about the lake."';
    expect(parseSegments(text, KNOWN)).toEqual([
      { speaker: "Maya", content: '"It was a long week,\nand I kept thinking about the lake."' },
    ]);
  });

  it("ends a speaker segment at a blank line", () => {
    const text = '[Maya] "Stay."\n\nThe lamp guttered.';
    expect(parseSegments(text, KNOWN)).toEqual([
      { speaker: "Maya", content: '"Stay."' },
      { speaker: null, content: "The lamp guttered." },
    ]);
  });

  it("merges consecutive same-speaker tags with a paragraph break", () => {
    const text = '[Maya] "First."\n\n[Maya] "Second."';
    expect(parseSegments(text, KNOWN)).toEqual([{ speaker: "Maya", content: '"First."\n\n"Second."' }]);
  });

  it("handles multiple speakers including multi-word names", () => {
    const text = '[Maya] "Ready?"\n[Rhett Calloway] "Born ready."\nThe horses stamped.\n\nDust rose.';
    expect(parseSegments(text, KNOWN)).toEqual([
      { speaker: "Maya", content: '"Ready?"' },
      { speaker: "Rhett Calloway", content: '"Born ready."\nThe horses stamped.' },
      { speaker: null, content: "Dust rose." },
    ]);
  });

  it("keeps narrator paragraphs in one segment across blank lines", () => {
    const text = "Paragraph one.\n\nParagraph two.";
    expect(parseSegments(text, KNOWN)).toEqual([{ speaker: null, content: "Paragraph one.\n\nParagraph two." }]);
  });
});

describe("parseSegments — standalone-quote attribution (attributeStandaloneQuotes)", () => {
  const OPT = { attributeStandaloneQuotes: true };

  it("attributes a whole-line quote to the sole known name, as if tagged", () => {
    const text = 'Mara leans against the doorframe.\n"You came back."';
    expect(parseSegments(text, ["Mara"], OPT)).toEqual([
      { speaker: null, content: "Mara leans against the doorframe." },
      { speaker: "Mara", content: '"You came back."' },
    ]);
  });

  it("allows the narrator's typographic quotes too", () => {
    expect(parseSegments("“You came back.”", ["Mara"], OPT)).toEqual([
      { speaker: "Mara", content: "“You came back.”" },
    ]);
  });

  it("attributes a multi-line quoted paragraph as one speaker segment", () => {
    const text = '"It was a long week,\nand I kept thinking about the lake."';
    expect(parseSegments(text, ["Mara"], OPT)).toEqual([
      { speaker: "Mara", content: '"It was a long week,\nand I kept thinking about the lake."' },
    ]);
  });

  it("leaves a quote with a trailing beat as narrator prose", () => {
    const text = '"You came back," she says, not looking up.';
    expect(parseSegments(text, ["Mara"], OPT)).toEqual([{ speaker: null, content: text }]);
  });

  it("leaves a quote embedded in a narration sentence as narrator prose", () => {
    const text = 'her mother\'s voice drifts from the back: "Sabrina!"';
    expect(parseSegments(text, ["Sabrina"], OPT)).toEqual([{ speaker: null, content: text }]);
  });

  it("is a no-op with the option off (default behavior unchanged)", () => {
    const text = 'Mara leans against the doorframe.\n"You came back."';
    // Both the untagged narration and the bare quote fold into one narrator segment.
    expect(parseSegments(text, ["Mara"])).toEqual([{ speaker: null, content: text }]);
  });

  it("ignores the option when more than one name is known (ambiguous speaker)", () => {
    const text = '"You came back."';
    expect(parseSegments(text, KNOWN, OPT)).toEqual([{ speaker: null, content: text }]);
  });

  it("still honors explicit [Name] tags alongside standalone quotes", () => {
    const text = '[Maya] "Tagged line."\n\n"Untagged quote."';
    expect(parseSegments(text, ["Maya"], OPT)).toEqual([
      // Same-speaker tag + standalone quote merge with a paragraph break, like two tags.
      { speaker: "Maya", content: '"Tagged line."\n\n"Untagged quote."' },
    ]);
  });
});

describe("createSegmenter (streaming deltas)", () => {
  it("emits append-only deltas equal to the full parse", () => {
    const text = 'Morning light.\n[Maya] "Coffee?"\n\nShe was already pouring.';
    const seg = createSegmenter(KNOWN);
    const events: TurnChunkEvent[] = [];
    for (const ch of text) events.push(...seg.push(ch));
    events.push(...seg.finish());
    expect(assemble(events)).toEqual(parseSegments(text, KNOWN));
  });

  it("holds back a partial trailing line that could become a tag", () => {
    const seg = createSegmenter(KNOWN);
    const first = seg.push("Prose line.\n[Ma");
    // "[Ma" could still become "[Maya]" — withheld from display.
    expect(assemble(first)).toEqual([{ speaker: null, content: "Prose line." }]);
    const second = seg.push('ya] "Hello."');
    const all = assemble([...first, ...second, ...seg.finish()]);
    expect(all).toEqual([
      { speaker: null, content: "Prose line." },
      { speaker: "Maya", content: '"Hello."' },
    ]);
  });

  it("releases a bracketed line once it is too long to be a known tag", () => {
    const seg = createSegmenter(["Maya"]);
    const events = seg.push("[A very long unknown prefix that keeps going");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.speaker).toBeNull();
  });

  it("handles a tag split across many small chunks", () => {
    const seg = createSegmenter(KNOWN);
    const events: TurnChunkEvent[] = [];
    for (const chunk of ["[Rhett", " Call", "oway] ", '"Easy', ' now."']) {
      events.push(...seg.push(chunk));
    }
    events.push(...seg.finish());
    const segments = assemble(events);
    expect(segments).toEqual([{ speaker: "Rhett Calloway", content: '"Easy now."' }]);
    // every delta for the segment carries the same speaker + index
    expect(new Set(events.map((e) => `${e.segmentIndex}:${e.speaker}`))).toEqual(new Set(["0:Rhett Calloway"]));
  });

  it("flushes held-back text on finish", () => {
    const seg = createSegmenter(KNOWN);
    const pushed = seg.push("Ending on a partial...\n[Maya");
    const finished = seg.finish();
    const segments = assemble([...pushed, ...finished]);
    // never completed into a tag → narrator prose, nothing lost
    expect(segments).toEqual([{ speaker: null, content: "Ending on a partial...\n[Maya" }]);
  });

  it("streams multi-speaker text chunked at arbitrary boundaries identically to a full parse", () => {
    const text =
      'The kitchen smelled of rosemary.\n\n[Maya] "Sit down, both of you."\nShe pointed with the spoon.\n\n[Rhett Calloway] "Yes ma\'am."\n\nOutside, the dog barked twice.';
    for (const size of [1, 3, 7, 13, 40]) {
      const seg = createSegmenter(KNOWN);
      const events: TurnChunkEvent[] = [];
      for (let i = 0; i < text.length; i += size) events.push(...seg.push(text.slice(i, i + size)));
      events.push(...seg.finish());
      expect(assemble(events), `chunk size ${size}`).toEqual(parseSegments(text, KNOWN));
    }
  });

  it("emits valid deltas with empty known-name list", () => {
    const seg = createSegmenter([]);
    const events = [...seg.push('[Maya] "Hi."'), ...seg.finish()];
    expect(assemble(events)).toEqual([{ speaker: null, content: '[Maya] "Hi."' }]);
  });
});
