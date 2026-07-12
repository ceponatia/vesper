import { describe, expect, it } from "vitest";
import { buildChatLookPrompt, buildChatPlacePrompt, chatLookKey } from "./chat-look";

describe("chatLookKey", () => {
  const base = { outfit: "a linen sundress", outfitExposed: false, attributeOverlays: [] };

  it("is stable across calls and insensitive to case/whitespace and overlay order", () => {
    expect(chatLookKey(base)).toBe(chatLookKey({ ...base, outfit: "  A Linen Sundress " }));
    const a = chatLookKey({
      ...base,
      attributeOverlays: [
        { id: "hair.color", value: "auburn", source: "narrative" },
        { id: "hair.length", value: "short", source: "narrative" },
      ],
    });
    const b = chatLookKey({
      ...base,
      attributeOverlays: [
        { id: "hair.length", value: "short", source: "narrative" },
        { id: "hair.color", value: "auburn", source: "narrative" },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when the outfit, exposure, or an overlay changes (owner ruling: a haircut invalidates)", () => {
    const key = chatLookKey(base);
    expect(chatLookKey({ ...base, outfit: "jeans and a t-shirt" })).not.toBe(key);
    expect(chatLookKey({ ...base, outfitExposed: true })).not.toBe(key);
    expect(
      chatLookKey({ ...base, attributeOverlays: [{ id: "hair.length", value: "short", source: "narrative" }] }),
    ).not.toBe(key);
  });
});

describe("look/place prompts", () => {
  it("the look edit keeps identity, swaps the outfit, and forbids extra garments", () => {
    const prompt = buildChatLookPrompt({ outfit: "a linen sundress", outfitExposed: false });
    expect(prompt).toContain("exact same person");
    expect(prompt).toContain("now wearing a linen sundress");
    expect(prompt).toContain("remove anything the reference wears that is not listed");
    expect(buildChatLookPrompt({ outfit: "", outfitExposed: true })).toContain("Remove the outfit");
    expect(buildChatLookPrompt({ outfit: "", outfitExposed: false })).toContain("simple, casual outfit");
  });

  it("the place shot is the sketch, empty of people", () => {
    const prompt = buildChatPlacePrompt({ placeName: "the kitchen", sketch: "Warm terracotta tiles; copper pans." });
    expect(prompt).toContain("establishing shot of the kitchen");
    expect(prompt).toContain("Warm terracotta tiles; copper pans.");
    expect(prompt).toContain("No people anywhere in frame");
  });
});
