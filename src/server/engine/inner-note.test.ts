import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import type { InnerNoteExtraction } from "@/contracts/turns/inner-note";
import { extractInnerNote, INNER_NOTE_MAX_FACTS, INNER_NOTE_MIN_CONFIDENCE, normalizeInnerNoteExtraction } from "./inner-note";

const NOTE =
  "Fatima knows she is much older than Brian. She's flattered by his bashful flirting but finds the age gap odd.";

function fact(overrides: Partial<InnerNoteExtraction["facts"][number]> = {}): InnerNoteExtraction["facts"][number] {
  return {
    kind: "secret",
    subjectName: "Fatima",
    subjectKind: "character",
    text: "Fatima is privately flattered by Brian's flirting.",
    tags: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("extractInnerNote (demo mode — forced by src/test/setup.ts)", () => {
  it("degrades to the verbatim note as one knowledge fact + guidance, with the diagnostic", async () => {
    const sink = new DiagnosticCollector();
    const { extraction, degraded } = await extractInnerNote({ npcName: "Fatima", note: ` ${NOTE} `, sink });

    expect(degraded).toBe(true);
    expect(extraction.facts).toHaveLength(1);
    expect(extraction.facts[0]).toMatchObject({
      kind: "knowledge",
      subjectName: "Fatima",
      subjectKind: "character",
      text: NOTE,
    });
    expect(extraction.guidance).toBe(NOTE);
    // Degradation tests assert fallback AND diagnostic code (docs/resilience.md §8).
    expect(sink.items.map((d) => d.code)).toContain("inner_note.extraction.degraded");
  });
});

describe("normalizeInnerNoteExtraction", () => {
  it("re-binds every fact to the NPC and floors confidence (trust nothing)", () => {
    const raw: InnerNoteExtraction = {
      facts: [
        fact({ subjectName: "Brian", subjectKind: "player", confidence: 0.1 }),
        fact({ text: "  Fatima remembers the harbor festival.  ", confidence: 0.95 }),
      ],
      guidance: " Fatima will deflect warmly. ",
    };
    const out = normalizeInnerNoteExtraction("Fatima", NOTE, raw);

    expect(out.facts).toHaveLength(2);
    for (const f of out.facts) {
      expect(f.subjectName).toBe("Fatima");
      expect(f.subjectKind).toBe("character");
      expect(f.confidence).toBeGreaterThanOrEqual(INNER_NOTE_MIN_CONFIDENCE);
    }
    expect(out.facts[1]?.text).toBe("Fatima remembers the harbor festival.");
    expect(out.guidance).toBe("Fatima will deflect warmly.");
  });

  it("caps the fact count and drops empty-text facts", () => {
    const raw: InnerNoteExtraction = {
      facts: [fact({ text: "   " }), ...Array.from({ length: 6 }, (_, i) => fact({ text: `Interior fact ${i}.` }))],
      guidance: "g",
    };
    const out = normalizeInnerNoteExtraction("Fatima", NOTE, raw);
    expect(out.facts).toHaveLength(INNER_NOTE_MAX_FACTS);
    expect(out.facts.map((f) => f.text)).toEqual([
      "Interior fact 0.",
      "Interior fact 1.",
      "Interior fact 2.",
      "Interior fact 3.",
    ]);
  });

  it("falls back to the verbatim note when no usable facts, with a warn diagnostic", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeInnerNoteExtraction("Fatima", NOTE, { facts: [], guidance: "g" }, sink);
    expect(out.facts).toHaveLength(1);
    expect(out.facts[0]).toMatchObject({ kind: "knowledge", subjectName: "Fatima", text: NOTE });
    const diag = sink.items.find((d) => d.code === "inner_note.extraction.no_facts");
    expect(diag?.severity).toBe("warn");
  });

  it("falls back to the verbatim note when guidance is empty, with a warn diagnostic", () => {
    const sink = new DiagnosticCollector();
    const out = normalizeInnerNoteExtraction("Fatima", NOTE, { facts: [fact()], guidance: "  " }, sink);
    expect(out.guidance).toBe(NOTE);
    const diag = sink.items.find((d) => d.code === "inner_note.extraction.no_guidance");
    expect(diag?.severity).toBe("warn");
  });
});
