import { describe, expect, it } from "vitest";
import { FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { buildChatLookPrompt, buildChatPlacePrompt, chatLookKey } from "./chat-look";

describe("chatLookKey (chat-wardrobe-parity — structured key)", () => {
  const bare: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };
  const base = { wornItemIds: ["item-b", "item-a"], overlay: "", exposure: FULLY_COVERED, attributeOverlays: [] };

  it("is stable and insensitive to worn-id order, overlay case/whitespace, and overlay order", () => {
    // Worn ids are sorted, so reordering the worn list is a no-op.
    expect(chatLookKey(base)).toBe(chatLookKey({ ...base, wornItemIds: ["item-a", "item-b"] }));
    // Overlay text normalizes case/whitespace.
    expect(chatLookKey({ ...base, overlay: "a Scarf" })).toBe(chatLookKey({ ...base, overlay: "  A SCARF " }));
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

  it("changes when the worn list, overlay, computed exposure, or an overlay changes (a haircut invalidates)", () => {
    const key = chatLookKey(base);
    expect(chatLookKey({ ...base, wornItemIds: ["item-a"] })).not.toBe(key);
    expect(chatLookKey({ ...base, overlay: "a borrowed hoodie" })).not.toBe(key);
    expect(chatLookKey({ ...base, exposure: bare })).not.toBe(key);
    expect(
      chatLookKey({ ...base, attributeOverlays: [{ id: "hair.length", value: "short", source: "narrative" }] }),
    ).not.toBe(key);
  });

  it("a legacy free-text chat (empty worn list) keys on the overlay alone — stable across the change", () => {
    const legacy = { wornItemIds: [], overlay: "a linen sundress", exposure: FULLY_COVERED, attributeOverlays: [] };
    expect(chatLookKey(legacy)).toBe(chatLookKey({ ...legacy, overlay: "  A Linen Sundress " }));
    expect(chatLookKey(legacy)).not.toBe(chatLookKey({ ...legacy, overlay: "jeans and a t-shirt" }));
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
