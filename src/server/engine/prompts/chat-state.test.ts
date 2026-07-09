import { describe, expect, it } from "vitest";
import { buildChatPulsePrompt, CHAT_PULSE_SYSTEM } from "./chat-state";

describe("CHAT_PULSE_SYSTEM", () => {
  it("reports playerAct + mindNote and carries a worked example", () => {
    expect(CHAT_PULSE_SYSTEM).toContain('"playerAct"');
    expect(CHAT_PULSE_SYSTEM).toContain('"mindNote"');
    expect(CHAT_PULSE_SYSTEM).toContain("Interaction concepts:");
    expect(CHAT_PULSE_SYSTEM).toContain('{"playerAct":{"concept":"physical_affection"}');
  });

  it("carries the untrusted-data notice", () => {
    expect(CHAT_PULSE_SYSTEM).toContain("untrusted DATA");
  });

  it("asserts the state-agent exemption: interiority is in scope as an intent signal (player-input-perception.plan.md slice 3)", () => {
    // The narrator's perception partition (quoted = heard, narration = seen,
    // interiority = invisible) must NOT be ported into the pulse by symmetry —
    // the pulse reads the whole message, and interiority is a strong intent cue.
    expect(CHAT_PULSE_SYSTEM).toMatch(/whole message is yours to read/i);
    expect(CHAT_PULSE_SYSTEM).toMatch(/narration and unspoken inner thoughts/i);
    expect(CHAT_PULSE_SYSTEM).toMatch(/not only what the character could hear or see/i);
    expect(CHAT_PULSE_SYSTEM).toMatch(/strong signal of intent and disposition/i);
  });
});

describe("buildChatPulsePrompt", () => {
  const base = {
    characterName: "Mara",
    playerName: "Theo",
    mindNote: "",
    exchange: { player: "\"Hey.\" I hesitate, unsure she wants me here.", assistant: "[Mara] \"You came.\"" },
  };

  it("renders the exchange, fenced, with a prior mindNote when present", () => {
    const prompt = buildChatPulsePrompt({ ...base, mindNote: "Mara is guarded but curious." });
    expect(prompt).toContain("Character: Mara");
    expect(prompt).toContain("Prior mindNote:");
    expect(prompt).toContain("Mara is guarded but curious.");
    expect(prompt).toContain("Latest exchange:");
    // The player's narration/interiority is passed through verbatim — not stripped.
    expect(prompt).toContain("I hesitate, unsure she wants me here.");
  });

  it("renders '(none yet)' when there is no prior mindNote (prompt shape stays stable)", () => {
    const prompt = buildChatPulsePrompt(base);
    expect(prompt).toContain("Prior mindNote:\n(none yet)");
  });
});
