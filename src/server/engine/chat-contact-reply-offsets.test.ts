import { describe, expect, it } from "vitest";
import { affordanceSubjectId } from "@/contracts";
import { detectChatNpcContactEnding, type ChatNpcEndingCharacter } from "./chat-contact-reply";
import { locateChatNpcEndingActionSpan } from "./chat-contact-reply-offsets";

/**
 * Floor-ending source offsets (romantic-contact-affordances.spec.actor-control.md
 * §"Authority model" / §"Chronology and folding"): the frozen detector says WHAT
 * ended; this wrapper re-derives WHERE, by replaying that same detector one
 * narration sentence at a time and then pinning the matched ACTION PHRASE
 * inside it. The tests pin that the located phrase is the one the full-reply
 * scan actually matched — including past hedged sentences and never inside
 * dialogue — that it is phrase-grain (an action sharing the sentence stays
 * orderable), and that inconsistent inputs answer null instead of a guessed
 * position.
 */

const WREN = affordanceSubjectId("wren");
const CHARACTERS: readonly ChatNpcEndingCharacter[] = [{ subjectId: WREN, name: "Wren", aliases: [] }];

describe("locateChatNpcEndingActionSpan", () => {
  it("returns the matched action phrase's absolute span for a detected withdrawal", () => {
    const reply = "Wren smiles softly. Wren pulls away from your hand.";
    const ending = detectChatNpcContactEnding({ reply, characters: CHARACTERS });
    expect(ending).toEqual({ subjectId: WREN, reason: "withdrawn" });
    if (ending === null) return;
    const span = locateChatNpcEndingActionSpan({ reply, characters: CHARACTERS, ending });
    expect(span).not.toBeNull();
    if (span === null) return;
    expect(reply.slice(span.start, span.end)).toBe("Wren pulls away");
  });

  it("pins the phrase, not the sentence, so a same-sentence action stays orderable", () => {
    // The chronology planner drops any tier-2 phrase overlapping the floor's
    // span. Phrase grain keeps "rests her hand on your shoulder" disjoint from
    // the ending, so the reply's second action can still be ordered after it.
    const reply = "Wren steps back, then rests her hand on your shoulder.";
    const ending = detectChatNpcContactEnding({ reply, characters: CHARACTERS });
    expect(ending).toEqual({ subjectId: WREN, reason: "separated" });
    if (ending === null) return;
    const span = locateChatNpcEndingActionSpan({ reply, characters: CHARACTERS, ending });
    expect(span).not.toBeNull();
    if (span === null) return;
    expect(reply.slice(span.start, span.end)).toBe("Wren steps back");
    expect(span.end).toBeLessThan(reply.indexOf("rests"));
  });

  it("skips dialogue and locates the narration phrase, curly quotes included", () => {
    const reply = "“Don’t pull away,” Wren pleads. Wren steps back.";
    const ending = detectChatNpcContactEnding({ reply, characters: CHARACTERS });
    expect(ending).toEqual({ subjectId: WREN, reason: "separated" });
    if (ending === null) return;
    const span = locateChatNpcEndingActionSpan({ reply, characters: CHARACTERS, ending });
    expect(span).not.toBeNull();
    if (span === null) return;
    expect(reply.slice(span.start, span.end)).toBe("Wren steps back");
  });

  it("walks past sentences the floor's own eligibility gates vetoed", () => {
    const reply = "Wren seems to pull away. Wren steps back.";
    const ending = detectChatNpcContactEnding({ reply, characters: CHARACTERS });
    expect(ending).toEqual({ subjectId: WREN, reason: "separated" });
    if (ending === null) return;
    const span = locateChatNpcEndingActionSpan({ reply, characters: CHARACTERS, ending });
    expect(span).not.toBeNull();
    if (span === null) return;
    expect(reply.slice(span.start, span.end)).toBe("Wren steps back");
  });

  it("answers null for an ending the reply's first match does not describe", () => {
    const reply = "Wren steps back.";
    const span = locateChatNpcEndingActionSpan({
      reply,
      characters: CHARACTERS,
      ending: { subjectId: WREN, reason: "withdrawn" },
    });
    expect(span).toBeNull();
  });

  it("answers null when the reply carries no ending at all", () => {
    const span = locateChatNpcEndingActionSpan({
      reply: "Wren smiles and pours the tea.",
      characters: CHARACTERS,
      ending: { subjectId: WREN, reason: "separated" },
    });
    expect(span).toBeNull();
  });
});
