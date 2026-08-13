import { describe, expect, it } from "vitest";
import { caretInOocBlock, commsLine, messageRenderModel, type RenderPiece } from "./message-markup";

/** Flatten the paragraph model to compact tuples for readable assertions. */
const flat = (content: string, ctx?: Parameters<typeof messageRenderModel>[1]) =>
  messageRenderModel(content, ctx).map((p) =>
    p.map((piece: RenderPiece) => ({
      variant: piece.variant,
      text: piece.text,
      space: piece.space,
      ...(piece.prefix !== undefined ? { prefix: piece.prefix } : {}),
    })),
  );

describe("messageRenderModel — span → display pieces (player-input-perception.plan.md slice 5)", () => {
  it("re-adds the quotes to speech and leaves narration plain, spaced as one line", () => {
    expect(flat(`"Hey, Sabrina." I lean against the doorframe.`)).toEqual([
      [
        { variant: "plain", text: `"Hey, Sabrina."`, space: false },
        { variant: "plain", text: "I lean against the doorframe.", space: true },
      ],
    ]);
  });

  it("renders a thought and styled span as italic, sigils already stripped", () => {
    expect(flat("*There's no way she'd go for me.*")).toEqual([
      [{ variant: "italic", text: "There's no way she'd go for me.", space: false }],
    ]);
    expect(flat("I say it was _fine_, nothing more.")).toEqual([
      [
        { variant: "plain", text: "I say it was", space: false },
        { variant: "italic", text: "fine", space: true },
        // The clause resumes on a comma → no leading space, so it reads "fine, nothing".
        { variant: "plain", text: ", nothing more.", space: false },
      ],
    ]);
  });

  it("suppresses the leading space before resume-punctuation around an inline thought", () => {
    expect(flat("I glance away, *there's no way she wants me here*, and shrink back.")).toEqual([
      [
        { variant: "plain", text: "I glance away,", space: false },
        { variant: "italic", text: "there's no way she wants me here", space: true },
        { variant: "plain", text: ", and shrink back.", space: false },
      ],
    ]);
  });

  it("renders a comms span with the Name: prefix visible and the body italic", () => {
    expect(flat("*Sabrina: omg. yes.*")).toEqual([
      [{ variant: "comms", text: "omg. yes.", prefix: "Sabrina:", space: false }],
    ]);
  });

  it("omits the comms prefix when the sender can't be resolved", () => {
    // The `to Name:` form with no player-name context leaves the sender undefined.
    expect(flat("*to Sabrina: on my way*")).toEqual([
      [{ variant: "comms", text: "on my way", space: false }],
    ]);
  });

  it("renders an OOC span as its own variant with the parens hidden", () => {
    expect(flat("I nod. ((keep her guarded here)) and wait.")).toEqual([
      [
        { variant: "plain", text: "I nod.", space: false },
        { variant: "ooc", text: "keep her guarded here", space: true },
        { variant: "plain", text: "and wait.", space: true },
      ],
    ]);
  });

  it("keeps a single-paren aside inside narration (never an OOC variant)", () => {
    expect(flat("I sink into the chair (still catching my breath).")).toEqual([
      [{ variant: "plain", text: "I sink into the chair (still catching my breath).", space: false }],
    ]);
  });

  it("treats short mid-sentence emphasis as italic styling, not a thought", () => {
    expect(flat("Wait — you *really* think I didn't notice?")).toEqual([
      [
        { variant: "plain", text: "Wait — you", space: false },
        { variant: "italic", text: "really", space: true },
        { variant: "plain", text: "think I didn't notice?", space: true },
      ],
    ]);
  });

  it("splits blank-line-separated paragraphs into separate runs (prose breaks survive)", () => {
    const model = flat(`"Oh! Hey." She looks up.\n\n*Well, this is unexpected.* She sets down her book.`);
    expect(model).toHaveLength(2);
    expect(model[0]).toEqual([
      { variant: "plain", text: `"Oh! Hey."`, space: false },
      { variant: "plain", text: "She looks up.", space: true },
    ]);
    expect(model[1]).toEqual([
      { variant: "italic", text: "Well, this is unexpected.", space: false },
      { variant: "plain", text: "She sets down her book.", space: true },
    ]);
  });

  it("keeps a single newline inside a narration span (a soft line break, one paragraph)", () => {
    expect(flat("Line one.\nLine two.")).toEqual([
      [{ variant: "plain", text: "Line one.\nLine two.", space: false }],
    ]);
  });

  it("renders unmarked plain text unchanged as a single plain piece", () => {
    expect(flat("hey Sabrina, how's it going?")).toEqual([
      [{ variant: "plain", text: "hey Sabrina, how's it going?", space: false }],
    ]);
  });

  it("returns no paragraphs for blank / degenerate input", () => {
    expect(messageRenderModel("")).toEqual([]);
    expect(messageRenderModel("   \n  \n ")).toEqual([]);
  });
});

describe("commsLine — SMS-style texted-line detection for the session feed", () => {
  it("detects a solely `*Name: …*` line, returning the label + body", () => {
    expect(commsLine("*Mara: on my way, five minutes*")).toEqual({ prefix: "Mara:", text: "on my way, five minutes" });
  });

  it("omits the prefix when the sender is unresolved (the `to Name:` form without context)", () => {
    expect(commsLine("*to Mara: on my way*")).toEqual({ text: "on my way" });
  });

  it("returns null for an ordinary italic line (a thought, not a text)", () => {
    expect(commsLine("*She looks up, unsure what to say.*")).toBeNull();
  });

  it("returns null for plain prose and for `**bold**` (leaves inline-markup rendering alone)", () => {
    expect(commsLine("She sets down the cup.")).toBeNull();
    expect(commsLine("**Don't.**")).toBeNull();
  });

  it("returns null when a comms span is mixed with other content (not a whole texted line)", () => {
    expect(commsLine('*Mara: omw* she types, then pockets the phone.')).toBeNull();
  });
});

describe("caretInOocBlock — the composer OOC affordance probe", () => {
  it("is true immediately after the auto-closed `((|))`", () => {
    expect(caretInOocBlock("(())", 2)).toBe(true);
  });

  it("is true while typing inside an open block", () => {
    expect(caretInOocBlock("((skip ahead", 12)).toBe(true);
    expect(caretInOocBlock("((skip ahead))", 6)).toBe(true);
  });

  it("is false once the caret is past the closing `))`", () => {
    expect(caretInOocBlock("((skip ahead))", 14)).toBe(false);
  });

  it("is false with no block, a single paren, or the caret before the block", () => {
    expect(caretInOocBlock("just talking", 4)).toBe(false);
    expect(caretInOocBlock("(aside)", 3)).toBe(false);
    expect(caretInOocBlock("hi ((later))", 1)).toBe(false);
  });

  it("tracks the nearest open block when several are present", () => {
    expect(caretInOocBlock("((a)) and ((b", 13)).toBe(true);
    expect(caretInOocBlock("((a)) and later", 15)).toBe(false);
  });
});
