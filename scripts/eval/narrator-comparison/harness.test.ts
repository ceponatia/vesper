import { describe, expect, it } from "vitest";
import {
  deterministicArmOrder,
  narratorArmHistory,
  normalizedQuoteAppears,
  stripMarkdownSection,
} from "./harness";

describe("narratorArmHistory", () => {
  it("keeps each arm's prior replies and appends the current player line", () => {
    const turns = [{ player: "one" }, { player: "two" }, { player: "three" }];
    expect(narratorArmHistory(turns, ["reply one", "reply two"], 2)).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "reply one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "reply two" },
      { role: "user", content: "three" },
    ]);
  });
});

describe("deterministicArmOrder", () => {
  it("is stable for a key and never drops an arm", () => {
    const first = deterministicArmOrder("scenario-a", ["treatment", "control"] as const);
    expect(deterministicArmOrder("scenario-a", ["treatment", "control"] as const)).toEqual(first);
    expect(new Set(first)).toEqual(new Set(["treatment", "control"]));
  });
});

describe("normalizedQuoteAppears", () => {
  it("accepts whitespace and typographic-quote differences but not paraphrases", () => {
    const transcript = "She says, “That sleeve stays rolled.” Then she turns away.";
    expect(normalizedQuoteAppears('she says, "that sleeve stays rolled."', transcript)).toBe(true);
    expect(normalizedQuoteAppears("the sleeve remains rolled", transcript)).toBe(false);
  });
});

describe("stripMarkdownSection", () => {
  it("removes one level-two block without disturbing the surrounding prompt", () => {
    const prompt = [
      "prefix",
      "",
      "## Wardrobe right now",
      "- Wren: shirt",
      "",
      "## Scene",
      "The study",
    ].join("\n");
    expect(stripMarkdownSection(prompt, "Wardrobe right now")).toBe("prefix\n\n## Scene\nThe study");
  });
});
