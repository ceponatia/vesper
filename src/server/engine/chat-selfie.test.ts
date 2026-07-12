import { describe, expect, it } from "vitest";
import {
  appendSelfieEntry,
  CHAT_SELFIE_HISTORY_CAP,
  type SelfieEntry,
  CHAT_SELFIE_OFFER_GAP_MINUTES,
  chatSelfieOfferEligible,
  detectSelfieRequest,
  hasCommsSpans,
  type SelfieOfferGateInput,
} from "./chat-selfie";

describe("detectSelfieRequest", () => {
  it("catches the natural phrasings", () => {
    expect(detectSelfieRequest("send me a pic")).toBe(true);
    expect(detectSelfieRequest("Can you send me a selfie?")).toBe(true);
    expect(detectSelfieRequest("take a photo for me?")).toBe(true);
    expect(detectSelfieRequest("show me what you're wearing")).toBe(true);
    expect(detectSelfieRequest("*Theo: send a pic, please*")).toBe(true);
  });

  it("stays quiet on ordinary talk about photos", () => {
    expect(detectSelfieRequest("I love that photo on your wall.")).toBe(false);
    expect(detectSelfieRequest("we should take the scenic route")).toBe(false);
    expect(detectSelfieRequest("")).toBe(false);
  });
});

describe("hasCommsSpans", () => {
  it("reads the texted-comms grammar and nothing else", () => {
    expect(hasCommsSpans("*Sabrina: on my way*")).toBe(true);
    expect(hasCommsSpans('"Hey there." I wave.')).toBe(false);
    expect(hasCommsSpans("*a private thought*")).toBe(false);
    expect(hasCommsSpans("")).toBe(false);
  });
});

describe("chatSelfieOfferEligible (apart-only, ruled)", () => {
  const gate = (overrides: Partial<SelfieOfferGateInput> = {}): SelfieOfferGateInput => ({
    regard: 60,
    clockMinutes: 500,
    selfieHistory: [],
    playerComms: true,
    lastReplyComms: false,
    ...overrides,
  });

  it("passes when apart (comms register) + warm + off cooldown", () => {
    expect(chatSelfieOfferEligible(gate())).toBe(true);
    expect(chatSelfieOfferEligible(gate({ playerComms: false, lastReplyComms: true }))).toBe(true);
  });

  it("never offers face-to-face — a selfie simulates texting (owner ruling)", () => {
    expect(chatSelfieOfferEligible(gate({ playerComms: false, lastReplyComms: false }))).toBe(false);
  });

  it("requires warm-or-better regard and respects the cooldown", () => {
    expect(chatSelfieOfferEligible(gate({ regard: 30 }))).toBe(false);
    const recent = gate({
      selfieHistory: [{ kind: "request", atClockMinutes: 500 - CHAT_SELFIE_OFFER_GAP_MINUTES + 1 }],
    });
    expect(chatSelfieOfferEligible(recent)).toBe(false);
    const cooled = gate({
      selfieHistory: [{ kind: "offer", atClockMinutes: 500 - CHAT_SELFIE_OFFER_GAP_MINUTES }],
    });
    expect(chatSelfieOfferEligible(cooled)).toBe(true);
  });
});

describe("appendSelfieEntry", () => {
  it("appends and caps the ring, oldest out", () => {
    let ring: SelfieEntry[] = [...Array(CHAT_SELFIE_HISTORY_CAP)].map((_, i) => ({ kind: "request", atClockMinutes: i }));
    ring = appendSelfieEntry(ring, { kind: "offer", atClockMinutes: 999 });
    expect(ring).toHaveLength(CHAT_SELFIE_HISTORY_CAP);
    expect(ring.at(-1)?.kind).toBe("offer");
    expect(ring[0]?.atClockMinutes).toBe(1);
  });
});
