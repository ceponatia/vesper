import { describe, expect, it } from "vitest";
import { buildChatArchivistPrompt, CHAT_ARCHIVIST_SYSTEM } from "./chat-archivist";

describe("CHAT_ARCHIVIST_SYSTEM", () => {
  it("declares five fields and carries a worked example for each rare field", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("five fields");
    // The attributeChanges micro-example (C6 — the haircut) so the proposer stops under-firing.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeId":"hair.length"');
    // Both examples carry every field, so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"openLoops":[]');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeChanges":[]');
  });

  it("instructs full-list-each-time open loops (spec §6.2)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/re-emit the full list/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/drop any this exchange resolved/i);
  });
});

describe("buildChatArchivistPrompt", () => {
  const base = {
    characterName: "Mara",
    playerName: "Theo",
    exchange: { player: "Tell me about your sister.", assistant: "[Mara] \"Later. I promise.\"" },
  };

  it("fences the exchange and renders prior open loops for carry-forward", () => {
    const prompt = buildChatArchivistPrompt({ ...base, openLoops: ["tell Theo about her sister"] });
    expect(prompt).toContain("Currently open loops:");
    expect(prompt).toContain("- tell Theo about her sister");
    expect(prompt).toContain("Tell me about your sister.");
  });

  it("renders '(none)' when no loops are open (prompt shape stays stable)", () => {
    const prompt = buildChatArchivistPrompt(base);
    expect(prompt).toContain("Currently open loops:\n(none)");
  });
});
