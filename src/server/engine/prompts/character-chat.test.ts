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
    age: "29",
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
    // Identity block carries the real age (profile field), not the apparent-age attribute.
    expect(prompt).toContain("You are 29 years old.");
    expect(prompt).not.toContain("late twenties");
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

  it("adopts the shape profiles, replacing the fixed paragraph target", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).not.toContain("one or two short paragraphs");
    // The default (concise_immersive) profile drives chat length too.
    expect(prompt).toContain("Write one focused beat per turn");
  });

  it("makes the aggressive_concise shape selectable in chat and distinct", () => {
    const aggressive = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "aggressive_concise" });
    const concise = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "concise_immersive" });
    expect(aggressive).toContain("Be brief and tightly scoped");
    expect(aggressive).not.toContain("Write one focused beat per turn");
    expect(aggressive).not.toBe(concise);
  });

  it("carries the proportionate-reaction + stay-in-voice chat rules", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("React in proportion");
    expect(prompt).toContain("affection is earned, not automatic");
    expect(prompt).toContain("Stay in your own voice and the current topic");
  });

  it("introduces no hard length cap in the chat lane for either shape profile", () => {
    const cap = /\d+\s+(characters|tokens|words|lines|sentences|paragraphs)/;
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "concise_immersive" })).not.toMatch(cap);
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), narrationShape: "aggressive_concise" })).not.toMatch(cap);
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

  it("addresses the player by name and surfaces their persona when a player is given", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      player: { name: "Theo", persona: "A traveling cartographer, easy to talk to." },
    });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).toContain("About Theo (the person you're speaking with)");
    expect(prompt).toContain("A traveling cartographer");
    expect(prompt).toContain("talking with Theo");
    expect(prompt).not.toContain("speaking with the user");
  });

  it("uses the player name without a persona block when no bio is given", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), player: { name: "Theo" } });
    expect(prompt).toContain("speaking with Theo");
    expect(prompt).not.toContain("the person you're speaking with");
  });

  it("keeps the faceless 'the user' phrasing when no player is given (prompt unchanged)", () => {
    const prompt = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    expect(prompt).toContain("speaking with the user");
    expect(prompt).toContain('address the user directly as "you"');
  });

  it("is byte-identical when the state block is absent (existing behavior)", () => {
    const withoutState = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() });
    // An empty state (rested, neutral, no premise) adds nothing notable.
    const withEmptyState = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, affinity: 0, conditions: [] },
    });
    expect(withEmptyState).toBe(withoutState);
    expect(withoutState).not.toContain("Your current state");
    expect(withoutState).not.toContain("Scenario for this chat");
  });

  it("renders a warmth steer + mood + mindNote in the Current state block", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: {
        meters: { mood: 0.8, energy: 0.8, hygiene: 0.9, stress: 0.1 },
        affinity: 57, // warm
        conditions: [],
        mindNote: "She's glad he came back.",
      },
    });
    expect(prompt).toContain("Your current state");
    expect(prompt).toMatch(/warm toward you/i);
    expect(prompt).toContain("bright and playful");
    expect(prompt).toContain("She's glad he came back.");
    // The state block sits above the per-line response rules.
    expect(prompt.indexOf("Your current state")).toBeLessThan(prompt.indexOf("How to respond:"));
  });

  it("surfaces a crossed meter threshold (drift made visible)", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: { ...{ hygiene: 0.2 }, mood: 0.5, energy: 0.9 }, affinity: 0, conditions: [] },
    });
    expect(prompt).toMatch(/unwashed/i);
  });

  it("renders the premise as a prominent scenario block, above the response rules; empty ⇒ no block", () => {
    const prompt = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, affinity: 0, conditions: [], premise: "It's the night before she moves away forever." },
    });
    expect(prompt).toContain("Scenario for this chat");
    expect(prompt).toContain("the night before she moves away");
    expect(prompt.indexOf("Scenario for this chat")).toBeLessThan(prompt.indexOf("How to respond:"));

    const noPremise = buildCharacterChatSystemPrompt({
      name: "Mara",
      profile: profile(),
      state: { meters: {}, affinity: 0, conditions: [], premise: "   " },
    });
    expect(noPremise).not.toContain("Scenario for this chat");
  });

  it("adds an opening-beat instruction only when opening is set", () => {
    const opening = buildCharacterChatSystemPrompt({ name: "Mara", profile: profile(), opening: true });
    expect(opening).toMatch(/Opening beat/);
    expect(opening).toMatch(/Begin the conversation yourself/);
    expect(buildCharacterChatSystemPrompt({ name: "Mara", profile: profile() })).not.toContain("Opening beat");
  });
});
