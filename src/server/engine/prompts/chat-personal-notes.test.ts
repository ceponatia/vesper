import { describe, expect, it } from "vitest";
import { buildChatPersonalNotesPrompt, CHAT_PERSONAL_NOTES_SYSTEM } from "./chat-personal-notes";

describe("CHAT_PERSONAL_NOTES_SYSTEM (followups ruling 10)", () => {
  it("declares the four personal fields, scoped to ONE character", () => {
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain("four fields");
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain('"openLoops"');
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain('"attributeChanges"');
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain('"outfit"');
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain('"driveUpdates"');
    // The ownership rule — another character's changes are never this member's.
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toMatch(/Track ONLY the named character/);
    // The nothing-happened example keeps the model comfortable emitting all-empty.
    expect(CHAT_PERSONAL_NOTES_SYSTEM).toContain('{"openLoops":[],"attributeChanges":[],"outfit":{},"driveUpdates":[]}');
  });

  it("builds a prompt carrying the member's loops, drives (secret-flagged), and the fenced exchange", () => {
    const prompt = buildChatPersonalNotesPrompt({
      characterName: "Vera",
      playerName: "Brian",
      exchange: { player: "hi all", assistant: "[Vera] \"hey\"" },
      openLoops: ["show the player her studio"],
      drives: [{ want: "leave this town", secrecy: "secret", revealed: false }],
    });
    expect(prompt).toContain("Your character: Vera");
    expect(prompt).toContain("- show the player her studio");
    expect(prompt).toContain("- leave this town (a SECRET the player does not know)");
    expect(prompt).toContain("Brian: hi all");
  });

  it("renders (none) for a member with no loops or drives", () => {
    const prompt = buildChatPersonalNotesPrompt({
      characterName: "Vera",
      playerName: "",
      exchange: { player: "hi", assistant: "hello" },
    });
    expect(prompt).toContain("Currently open loops:\n(none)");
    expect(prompt).toContain("Player: the player");
  });
});
