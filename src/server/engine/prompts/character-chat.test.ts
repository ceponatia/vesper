import { describe, expect, it } from "vitest";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import type { AttributeValue } from "@/contracts/attributes/value";
import { buildCharacterChatSystemPrompt } from "./character-chat";

const attr = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue => ({ id, value, source: "creation" });

function profile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return {
    ...emptyCharacterProfile(),
    bio: "A harbor-town glassblower with salt in her hair.",
    personality: "Wry, guarded, fiercely loyal once you earn it.",
    voice: "Low and dry, with a coastal lilt.",
    attributes: [
      attr("identity.apparent_age", "late twenties"),
      attr("identity.gender", "female"),
      attr("hair.color", "auburn"),
      attr("voice.pitch", "low"),
      attr("voice.cadence", "measured"),
    ],
    ...overrides,
  };
}

describe("buildCharacterChatSystemPrompt", () => {
  it("embodies the named character and surfaces identity, personality, and voice", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("You are Mara");
    expect(prompt).toContain("late twenties");
    expect(prompt).toContain("Wry, guarded, fiercely loyal");
    expect(prompt).toContain("Low and dry, with a coastal lilt.");
    expect(prompt).toContain("A harbor-town glassblower");
  });

  it("renders resolved attribute values, never raw ids", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("auburn");
    expect(prompt).not.toContain("hair.color");
    expect(prompt).not.toContain("voice.pitch");
  });

  it("includes registry promptHints as deduped phrasing guidance", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("Phrasing guidance:");
  });

  it("carries the in-character + dialogue-tag rules", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("Stay fully in character as Mara");
    expect(prompt).toContain('[Mara]');
    expect(prompt).toMatch(/never mention being an AI/i);
  });

  it("grants the mature-content license the sessionless chat otherwise lacks", () => {
    // The session engine licenses explicit content via world directives + exposure
    // rules; the chat carries neither, so the prompt must state the frame itself or
    // safety-aligned narrators refuse and break character. See character-chat.ts.
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toMatch(/adult interactive fiction/i);
    expect(prompt).toMatch(/sexually explicit content (are|is) fully in scope/i);
  });

  it("forbids breaking character to refuse, and routes a 'no' through the character", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toMatch(/never break character to refuse/i);
    expect(prompt).toMatch(/play it as Mara's own in-world choice/i);
  });

  it("skips unknown attribute vocabulary instead of leaking it", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile({ attributes: [attr("identity.gender", "female"), attr("face.nonexistent_trait", "whatever")] }),
    });
    expect(prompt).not.toContain("nonexistent");
    expect(prompt).not.toContain("face.nonexistent_trait");
  });

  it("falls back gracefully for an empty profile", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "", profile: emptyCharacterProfile() });
    expect(prompt).toContain("this character");
    expect(prompt).toContain("How to respond:");
  });

  it("surfaces a prior summary as a continuity-context block, before the response rules", () => {
    const recap = "You met at the night market and traded names. Established:\n- The user is Theo.";
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), priorSummary: recap });
    expect(prompt).toContain("Earlier in this conversation");
    expect(prompt).toContain("The user is Theo.");
    // It's context, not dialogue, and must sit above the per-line response rules.
    expect(prompt.indexOf("Earlier in this conversation")).toBeLessThan(prompt.indexOf("How to respond:"));
  });

  it("omits the recap block entirely when there is no prior summary (prompt unchanged)", () => {
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain(
      "Earlier in this conversation",
    );
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), priorSummary: "   " })).not.toContain(
      "Earlier in this conversation",
    );
  });
});
