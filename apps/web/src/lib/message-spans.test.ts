import { describe, expect, it } from "vitest";
import {
  formatCommsReply,
  parseEmphasisRuns,
  parseMessageSpans,
  parseMessageSpansWithOffsets,
  spanChannel,
  type MessageSpanContext,
  type MessageSpanKind,
} from "./message-spans";

/** Compact view of a span for table assertions. */
const shape = (s: { kind: MessageSpanKind; text: string; sender?: string; recipient?: string }) => ({
  kind: s.kind,
  text: s.text,
  ...(s.sender !== undefined ? { sender: s.sender } : {}),
  ...(s.recipient !== undefined ? { recipient: s.recipient } : {}),
});

describe("parseMessageSpans — the sigil grammar (player-input-perception.plan.md §Markup lane)", () => {
  it("reads quoted text as speech and unmarked text as narration", () => {
    const spans = parseMessageSpans(`"Hey, Sabrina." I lean against the doorframe, grinning.`);
    expect(spans.map(shape)).toEqual([
      { kind: "speech", text: "Hey, Sabrina." },
      { kind: "narration", text: "I lean against the doorframe, grinning." },
    ]);
  });

  it("treats a whole unmarked message as a single narration span (the no-sigil path)", () => {
    expect(parseMessageSpans("hey Sabrina, how's it going? quiet day?").map(shape)).toEqual([
      { kind: "narration", text: "hey Sabrina, how's it going? quiet day?" },
    ]);
  });

  it("classifies a multi-word standalone asterisk span as a thought", () => {
    expect(parseMessageSpans("*There's no way she'd ever go for a klutz like me.*").map(shape)).toEqual([
      { kind: "thought", text: "There's no way she'd ever go for a klutz like me." },
    ]);
  });

  it("classifies a multi-word mid-sentence asterisk clause as a thought", () => {
    const spans = parseMessageSpans("I glance away, *there's no way she wants me here*, and shrink back.");
    expect(spans.map(shape)).toEqual([
      { kind: "narration", text: "I glance away," },
      { kind: "thought", text: "there's no way she wants me here" },
      { kind: "narration", text: ", and shrink back." },
    ]);
  });

  it("keeps the outermost asterisk sigil: nested quotes stay inside one thought span", () => {
    expect(parseMessageSpans(`*She said "no" — I can't believe it*`).map(shape)).toEqual([
      { kind: "thought", text: `She said "no" — I can't believe it` },
    ]);
  });

  it("reads _underscore_ spans as styling only, never a thought", () => {
    const spans = parseMessageSpans("I say it was _fine_, nothing more.");
    expect(spans.map(shape)).toEqual([
      { kind: "narration", text: "I say it was" },
      { kind: "styled", text: "fine" },
      { kind: "narration", text: ", nothing more." },
    ]);
  });

  describe("emphasis guard — short mid-sentence asterisks are styling, not thoughts", () => {
    it("treats a single-word mid-sentence asterisk span as styled emphasis", () => {
      const spans = parseMessageSpans("Wait — you *really* think I didn't notice?");
      expect(spans.map(shape)).toEqual([
        { kind: "narration", text: "Wait — you" },
        { kind: "styled", text: "really" },
        { kind: "narration", text: "think I didn't notice?" },
      ]);
    });

    it("treats a two-word mid-sentence asterisk span as styled emphasis", () => {
      const spans = parseMessageSpans("that was *so good* honestly");
      expect(spans.map(shape)).toEqual([
        { kind: "narration", text: "that was" },
        { kind: "styled", text: "so good" },
        { kind: "narration", text: "honestly" },
      ]);
    });

    it("still reads a single-word asterisk span as a thought when it stands alone on its line", () => {
      // Standalone-on-its-line beats the word-count guard.
      expect(parseMessageSpans("*Damn.*").map(shape)).toEqual([{ kind: "thought", text: "Damn." }]);
    });
  });

  describe("comms shapes — both forms normalize to { sender, recipient }", () => {
    const ctx: MessageSpanContext = { playerName: "Brian", knownNames: ["Sabrina"] };

    it("parses the sender-named form and resolves the sole 1-on-1 recipient", () => {
      expect(parseMessageSpans("*Brian: hey, u up?*", ctx).map(shape)).toEqual([
        { kind: "comms", text: "hey, u up?", sender: "Brian", recipient: "Sabrina" },
      ]);
    });

    it("parses the explicit-recipient `to Name:` form (sender defaults to the player persona)", () => {
      expect(parseMessageSpans("*to Sabrina: on my way*", ctx).map(shape)).toEqual([
        { kind: "comms", text: "on my way", sender: "Brian", recipient: "Sabrina" },
      ]);
    });

    it("leaves the recipient undefined when the roster can't resolve a sole other party", () => {
      expect(parseMessageSpans("*Brian: hey*").map(shape)).toEqual([
        { kind: "comms", text: "hey", sender: "Brian", recipient: undefined },
      ]);
    });

    it("does NOT treat a thought with an internal colon as comms", () => {
      // The name must be a single token immediately before the colon.
      expect(parseMessageSpans("*I remember what she said: never come back*").map(shape)).toEqual([
        { kind: "thought", text: "I remember what she said: never come back" },
      ]);
    });

    it("does NOT treat a `to be honest, …` opener as a comms recipient", () => {
      expect(parseMessageSpans("*to be honest, I'm nervous about this*").map(shape)).toEqual([
        { kind: "thought", text: "to be honest, I'm nervous about this" },
      ]);
    });
  });

  describe("OOC — double parens only", () => {
    it("reads a `((...))` span as ooc", () => {
      expect(parseMessageSpans("((skip ahead to the evening at the restaurant))").map(shape)).toEqual([
        { kind: "ooc", text: "skip ahead to the evening at the restaurant" },
      ]);
    });

    it("leaves a single-paren prose aside as narration (never misfires as ooc)", () => {
      expect(parseMessageSpans("I sink into the chair (still catching my breath from the walk).").map(shape)).toEqual([
        { kind: "narration", text: "I sink into the chair (still catching my breath from the walk)." },
      ]);
    });

    it("mixes an ooc span with surrounding narration", () => {
      const spans = parseMessageSpans("I nod. ((keep her guarded here)) and wait.");
      expect(spans.map(shape)).toEqual([
        { kind: "narration", text: "I nod." },
        { kind: "ooc", text: "keep her guarded here" },
        { kind: "narration", text: "and wait." },
      ]);
    });
  });

  describe("multi-span messages", () => {
    it("segments a quoted line, a visible action, and an asterisked thought in order", () => {
      const spans = parseMessageSpans(`"Hi…" I stammer, my face flushing.\n*She'll never want a klutz like me.*`);
      expect(spans.map((s) => s.kind)).toEqual(["speech", "narration", "thought"]);
      expect(spans[2]?.text).toBe("She'll never want a klutz like me.");
    });
  });

  describe("empty / degenerate input", () => {
    it("returns no spans for empty, whitespace, null, or undefined input", () => {
      expect(parseMessageSpans("")).toEqual([]);
      expect(parseMessageSpans("   \n  ")).toEqual([]);
      expect(parseMessageSpans(null)).toEqual([]);
      expect(parseMessageSpans(undefined)).toEqual([]);
    });

    it("treats an unterminated sigil as literal narration", () => {
      expect(parseMessageSpans("I feel *nervous about this").map(shape)).toEqual([
        { kind: "narration", text: "I feel *nervous about this" },
      ]);
      expect(parseMessageSpans('she said "wait').map(shape)).toEqual([
        { kind: "narration", text: 'she said "wait' },
      ]);
    });

    it("keeps an empty sigil pair as literal narration text", () => {
      expect(parseMessageSpans("nothing ** here").map(shape)).toEqual([
        { kind: "narration", text: "nothing ** here" },
      ]);
    });
  });
});

describe("comms output grammar round-trip (slice 4)", () => {
  it("formatCommsReply → parseMessageSpans recovers the same comms span", () => {
    const line = formatCommsReply("Sabrina", "omg. yes.");
    expect(line).toBe("*Sabrina: omg. yes.*");
    const spans = parseMessageSpans(line);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("comms");
    expect(spans[0]?.sender).toBe("Sabrina");
    expect(spans[0]?.text).toBe("omg. yes.");
  });
});

describe("parseEmphasisRuns — `_…_` emphasis inside a span body (chat-formatting fix)", () => {
  it("splits an underscore pair nested in quoted speech into an emphasized run", () => {
    // The outermost-sigil rule keeps the quote one atomic speech span, so the
    // underscores reach the renderer raw — the runs carry the emphasis instead.
    const speech = parseMessageSpans(`"Oh my god, it's _perfect_!"`)[0];
    expect(speech?.kind).toBe("speech");
    expect(parseEmphasisRuns(`"${speech?.text ?? ""}"`)).toEqual([
      { text: `"Oh my god, it's `, em: false },
      { text: "perfect", em: true },
      { text: `!"`, em: false },
    ]);
  });

  it("handles several pairs and preserves every non-sigil character", () => {
    expect(parseEmphasisRuns("_you_ said it was _fine_")).toEqual([
      { text: "you", em: true },
      { text: " said it was ", em: false },
      { text: "fine", em: true },
    ]);
  });

  it("keeps an unmatched underscore literal", () => {
    expect(parseEmphasisRuns("wait_ what")).toEqual([{ text: "wait_ what", em: false }]);
  });

  it("keeps empty and whitespace-only pairs literal", () => {
    expect(parseEmphasisRuns("a __ b")).toEqual([{ text: "a __ b", em: false }]);
    expect(parseEmphasisRuns("a _ _ b")).toEqual([{ text: "a _ _ b", em: false }]);
  });

  it("returns a single literal run for text with no underscores, and none for empty text", () => {
    expect(parseEmphasisRuns("just words")).toEqual([{ text: "just words", em: false }]);
    expect(parseEmphasisRuns("")).toEqual([]);
  });
});

describe("spanChannel — the perception fact-channel map (slice 6 forward-compat)", () => {
  it("maps perceivable channels to `perceived`, thoughts to `private`, ooc to `ooc`", () => {
    expect(spanChannel("speech")).toBe("perceived");
    expect(spanChannel("narration")).toBe("perceived");
    expect(spanChannel("comms")).toBe("perceived");
    expect(spanChannel("written")).toBe("perceived");
    expect(spanChannel("styled")).toBe("perceived");
    expect(spanChannel("thought")).toBe("private");
    expect(spanChannel("ooc")).toBe("ooc");
  });
});

describe("parseMessageSpansWithOffsets — the same walker, plus where each span sits", () => {
  it("returns offsets whose input slices equal the span text for narration and simple sigils", () => {
    const input = 'He nods slowly. "Hi there." *what a strange day* She waves.';
    const spans = parseMessageSpansWithOffsets(input);
    expect(spans.map((s) => s.kind)).toEqual(["narration", "speech", "thought", "narration"]);
    for (const span of spans) {
      expect(input.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("produces exactly the spans parseMessageSpans produces — offsets ride beside, never change classification", () => {
    const inputs = [
      'Plain narration only.',
      '"Speech." *thought here maybe* _styled_ ((ooc note)) trailing narration',
      'Unmatched *sigil stays literal narration',
      "*Wren: on my way*",
    ];
    for (const input of inputs) {
      const plain = parseMessageSpans(input, { playerName: "Rio", knownNames: ["Wren"] });
      const offset = parseMessageSpansWithOffsets(input, { playerName: "Rio", knownNames: ["Wren"] });
      expect(offset).toHaveLength(plain.length);
      expect(offset.map(shape)).toEqual(plain.map(shape));
    }
  });

  it("keeps narration offsets exact when sigil fallbacks glue literal text into the buffer", () => {
    const input = "before *  * after";
    const spans = parseMessageSpansWithOffsets(input);
    expect(spans).toHaveLength(1);
    const only = spans[0]!;
    expect(only.kind).toBe("narration");
    expect(input.slice(only.start, only.end)).toBe(only.text);
  });

  it("bounds a comms span by its whole inner region (the parsed text is the body only)", () => {
    const input = "*Wren: running late*";
    const spans = parseMessageSpansWithOffsets(input, { playerName: "Rio", knownNames: ["Wren"] });
    const comms = spans[0]!;
    expect(comms.kind).toBe("comms");
    expect(comms.text).toBe("running late");
    expect(input.slice(comms.start, comms.end)).toBe("Wren: running late");
  });
});
