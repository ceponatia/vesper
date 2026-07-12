import { describe, expect, it } from "vitest";
import { buildChatArchivistPrompt, CHAT_ARCHIVIST_SYSTEM } from "./chat-archivist";

describe("CHAT_ARCHIVIST_SYSTEM", () => {
  it("declares eight fields and carries a worked example for each rare field", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toContain("eight fields");
    // The attributeChanges micro-example (C6 — the haircut) so the proposer stops under-firing.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeId":"hair.length"');
    // Both examples carry every field, so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"openLoops":[]');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"attributeChanges":[]');
  });

  it("declares the optional outfit field with a worked example (chat-scene-fidelity slice 1)", () => {
    // Full-replacement semantics, change-gated, undressing included, player excluded.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"outfit": what the character is WEARING, only when this exchange CHANGED it/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/a full replacement, never a delta/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/Undressing counts/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/Never record the player's clothing/);
    // The dressed-for-dinner example shows the populated shape; the others show the {} no-op.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"outfit":{"description":"a black wrap dress and low heels, hair pinned up","exposed":false}');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"outfit":{}');
  });

  it("declares the optional scene field and carries a worked scene example (chat scene memory)", () => {
    // The scene field is described and gated to only established/changed settings.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"scene":/);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/chat locations are imagined by the narrator/i);
    // A populated example shows current place + time of day + a durable detail + a connection.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"current":"kitchen"');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"details":["blue-tiled counter"');
    // Non-scene exchanges emit an empty object.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"scene":{}');
  });

  it("instructs full-list-each-time open loops (spec §6.2)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/re-emit the full list/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/drop any this exchange resolved/i);
  });

  it("asserts the state-agent exemption: reads narration + interiority, not just what the character perceives (player-input-perception.plan.md slice 3)", () => {
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/read the player's entire message/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/narration and inner thoughts/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/not only what the character could perceive/i);
  });

  it("teaches the fact channel: perceived vs private, and skip OOC (player-input-perception.plan.md slice 6)", () => {
    // The facts field lists the channel key, the rule defines the vocabulary, and OOC is dropped.
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/"channel" one of perceived\|private/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/quoted speech or a visible action/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/unspoken inner thoughts/i);
    expect(CHAT_ARCHIVIST_SYSTEM).toMatch(/double parentheses.*record no facts/is);
    // Both worked examples carry an explicit channel so the model sees the full shape.
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"channel":"perceived"');
    expect(CHAT_ARCHIVIST_SYSTEM).toContain('"channel":"private"');
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

  it("adds a parser-derived channel hint when the player marks a private thought (slice 6)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: '"Hey." *God, I hope she says yes.*', assistant: base.exchange.assistant },
    });
    expect(prompt).toContain("Channel notes (the player used notation this message):");
    expect(prompt).toMatch(/private thought/i);
    expect(prompt).toContain('"channel":"private"');
  });

  it("adds an OOC hint that forbids storing facts from a ((direction)) span (slice 6)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: "((skip ahead to the next morning))", assistant: base.exchange.assistant },
    });
    expect(prompt).toMatch(/double-parenthesized.*record NO fact/is);
  });

  it("omits the channel hint entirely when the player used no thought/OOC notation (the common case)", () => {
    const prompt = buildChatArchivistPrompt({
      ...base,
      exchange: { player: '"Tell me about your sister." I lean in.', assistant: base.exchange.assistant },
    });
    expect(prompt).not.toContain("Channel notes");
  });
});
