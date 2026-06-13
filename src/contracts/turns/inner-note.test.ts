import { describe, expect, it } from "vitest";
import { degradedInnerNoteExtraction, INNER_NOTE_MAX_CHARS, innerNoteExtractionSchema } from "./inner-note";

describe("innerNoteExtractionSchema", () => {
  it("parses an empty object to schema defaults", () => {
    const parsed = innerNoteExtractionSchema.parse({});
    expect(parsed).toEqual({ facts: [], guidance: "" });
  });

  it("tolerates a bad fact kind via the taxonomy catch", () => {
    const parsed = innerNoteExtractionSchema.parse({
      facts: [{ kind: "daydream", subjectName: "Fatima", subjectKind: "character", text: "x", confidence: 0.8 }],
      guidance: "g",
    });
    expect(parsed.facts[0]?.kind).toBe("knowledge");
  });

  it("caps inner notes at a sane authoring length", () => {
    expect(INNER_NOTE_MAX_CHARS).toBe(2000);
  });
});

describe("degradedInnerNoteExtraction", () => {
  const note = "  Fatima is privately flattered by Brian's flirting but finds the age gap odd.  ";

  it("stores the note verbatim (trimmed) as one knowledge fact bound to the NPC", () => {
    const degraded = degradedInnerNoteExtraction("Fatima", note);
    expect(degraded.facts).toHaveLength(1);
    expect(degraded.facts[0]).toMatchObject({
      kind: "knowledge",
      subjectName: "Fatima",
      subjectKind: "character",
      text: note.trim(),
    });
    expect(degraded.guidance).toBe(note.trim());
  });

  it("round-trips through its own schema (the fallback is a valid extraction)", () => {
    const degraded = degradedInnerNoteExtraction("Fatima", note);
    expect(innerNoteExtractionSchema.parse(degraded)).toEqual(degraded);
  });

  it("survives the addFacts confidence gate", () => {
    const degraded = degradedInnerNoteExtraction("Fatima", note);
    expect(degraded.facts[0]?.confidence).toBeGreaterThanOrEqual(0.4);
  });
});
