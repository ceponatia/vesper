import { describe, expect, it } from "vitest";
import {
  appendVoiceExemplar,
  CHAT_VOICE_EXEMPLAR_CAP,
  CHAT_VOICE_EXEMPLAR_LINE_MAX,
  type VoiceExemplar,
} from "./chat-voice";

describe("appendVoiceExemplar (voice-exemplar ring — character-fidelity slice 8)", () => {
  it("appends a picked line with its clock minute", () => {
    const out = appendVoiceExemplar([], "Tell me you at least practiced the toast.", 120);
    expect(out).toEqual([{ line: "Tell me you at least practiced the toast.", atClockMinutes: 120 }]);
  });

  it("is a no-op for a blank/whitespace pick (the common no-distinct-line case)", () => {
    const prior: VoiceExemplar[] = [{ line: "existing", atClockMinutes: 0 }];
    expect(appendVoiceExemplar(prior, "", 30)).toEqual(prior);
    expect(appendVoiceExemplar(prior, "   ", 30)).toEqual(prior);
  });

  it("keeps only the newest CHAT_VOICE_EXEMPLAR_CAP entries", () => {
    let ring: VoiceExemplar[] = [];
    for (let i = 0; i < CHAT_VOICE_EXEMPLAR_CAP + 4; i++) ring = appendVoiceExemplar(ring, `line ${i}`, i);
    expect(ring).toHaveLength(CHAT_VOICE_EXEMPLAR_CAP);
    expect(ring[0]?.line).toBe(`line 4`); // oldest 4 dropped
    expect(ring.at(-1)?.line).toBe(`line ${CHAT_VOICE_EXEMPLAR_CAP + 3}`);
  });

  it("trims and length-caps the stored line", () => {
    const long = "x".repeat(CHAT_VOICE_EXEMPLAR_LINE_MAX + 50);
    const out = appendVoiceExemplar([], `  ${long}  `, 0);
    expect(out[0]?.line.length).toBe(CHAT_VOICE_EXEMPLAR_LINE_MAX);
  });
});
