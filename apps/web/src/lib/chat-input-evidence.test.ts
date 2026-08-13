import { describe, expect, it } from "vitest";
import {
  chatEvidenceCandidateFlags,
  chatEvidenceSentences,
  hasChatEvidenceNegation,
} from "@/lib/chat-input-evidence";

describe("chat input evidence primitives", () => {
  it("recognizes the full safe contraction family with straight, curly, or omitted apostrophes", () => {
    for (const text of [
      "haven't",
      "hasn’t",
      "hadnt",
      "isn't",
      "wasn’t",
      "werent",
      "wouldn't",
      "couldnt",
      "shouldn’t",
      "ain't",
    ]) {
      expect(hasChatEvidenceNegation(text), text).toBe(true);
    }
    expect(hasChatEvidenceNegation("I paint her portrait.")).toBe(false);
  });

  it("returns ordered evidence only from explicitly accepted message channels", () => {
    const input = 'I cross the room. "I touch her cheek." *I imagine touching her hair.* ((touch her eyes))';
    expect(chatEvidenceSentences(input, ["narration"])).toEqual([
      { kind: "narration", text: "I cross the room." },
    ]);
    expect(chatEvidenceSentences(input, ["narration", "speech"])).toEqual([
      { kind: "narration", text: "I cross the room." },
      { kind: "speech", text: "I touch her cheek." },
    ]);
  });

  it("marks perfect/history only at the candidate while preserving ordinary plain past", () => {
    const perfect = "I have gently touched her cheek before.";
    const plainPast = "I touched her cheek.";
    expect(chatEvidenceCandidateFlags(perfect, perfect.indexOf("touched")).historical).toBe(true);
    expect(chatEvidenceCandidateFlags(plainPast, plainPast.indexOf("touched")).historical).toBe(false);
  });
});
