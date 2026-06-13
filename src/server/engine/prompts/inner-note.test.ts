import { describe, expect, it } from "vitest";
import { buildInnerNotePrompt, INNER_NOTE_SYSTEM } from "./inner-note";

describe("INNER_NOTE_SYSTEM", () => {
  it("stays under the ~600-token budget (≈4 chars/token)", () => {
    expect(INNER_NOTE_SYSTEM.length).toBeLessThan(2600);
  });

  it("carries the never-dialogue and interiority-only rules", () => {
    expect(INNER_NOTE_SYSTEM).toContain("NEVER produce dialogue");
    expect(INNER_NOTE_SYSTEM).toContain("NEVER produce physical events");
    expect(INNER_NOTE_SYSTEM).toMatch(/THIS character's interior only/);
    expect(INNER_NOTE_SYSTEM).toMatch(/never another character's thoughts or feelings/);
    expect(INNER_NOTE_SYSTEM).toMatch(/never invent/i);
    expect(INNER_NOTE_SYSTEM).toMatch(/exactly as written/i);
  });

  it("worked example sketches the schema fields", () => {
    expect(INNER_NOTE_SYSTEM).toContain("Example");
    expect(INNER_NOTE_SYSTEM).toContain('"facts"');
    expect(INNER_NOTE_SYSTEM).toContain('"guidance"');
    expect(INNER_NOTE_SYSTEM).toContain('"subjectName"');
    expect(INNER_NOTE_SYSTEM).toContain('"confidence"');
  });

  it("names the allowed interior fact kinds", () => {
    expect(INNER_NOTE_SYSTEM).toContain("knowledge, preference, secret, relationship");
  });
});

describe("buildInnerNotePrompt", () => {
  it("carries the character name and the note", () => {
    const text = buildInnerNotePrompt({ npcName: "Fatima", note: "She is privately flattered." });
    expect(text).toContain("Character: Fatima");
    expect(text).toContain("Author's note:\nShe is privately flattered.");
  });
});
