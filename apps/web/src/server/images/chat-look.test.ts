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

  it("folds in the garment fingerprint (OQ8) without invalidating an unmodelled chat's key", () => {
    const key = chatLookKey(base);
    // An unmodelled chat contributes "" — the hash is byte-identical to before
    // slice 6, so no cached `chat_look` invalidates just because the field exists.
    expect(chatLookKey({ ...base, garmentKey: "" })).toBe(key);
    expect(chatLookKey({ ...base, garmentKey: "   " })).toBe(key);
    // A structural arrangement change moves the key even though the id list did not:
    // this is the whole reason the fingerprint had to enter here (audit finding 4).
    expect(chatLookKey({ ...base, garmentKey: "g1|sleeve_left=rolled||" })).not.toBe(key);
    expect(chatLookKey({ ...base, garmentKey: "g1|sleeve_left=rolled||" })).not.toBe(
      chatLookKey({ ...base, garmentKey: "g1|sleeve_left=down||" }),
    );
  });

  it("a legacy free-text chat (empty worn list) keys on the overlay alone — stable across the change", () => {
    const legacy = { wornItemIds: [], overlay: "a linen sundress", exposure: FULLY_COVERED, attributeOverlays: [] };
    expect(chatLookKey(legacy)).toBe(chatLookKey({ ...legacy, overlay: "  A Linen Sundress " }));
    expect(chatLookKey(legacy)).not.toBe(chatLookKey({ ...legacy, overlay: "jeans and a t-shirt" }));
  });
});

/**
 * GOLDEN DETERMINISM PINS — never "update to fix" a failure here.
 *
 * `chatLookKey` is the `meta.lookKey` stamped on every `chat_look` row, and the
 * loader (`latestChatLook`) reads a mismatch as "this look is stale". The values
 * below were computed from the hand-rolled FNV-1a this file carried BEFORE it
 * adopted the shared `@/lib/hash` (image-pipeline-consolidation.plan.md C10), so
 * they prove the consolidation moved nothing.
 *
 * If one of them ever changes, every conversation already in the database misses
 * its cache on the next turn and silently re-renders its look anchor against the
 * provider. Nothing throws — that invisibility is exactly why these are pinned.
 * A failure here IS the breakage: fix the hash, never the pin.
 */
describe("chatLookKey — golden determinism pins", () => {
  it("pins a fully-populated key", () => {
    expect(
      chatLookKey({
        // Deliberately unsorted: the sort is part of what these values pin.
        wornItemIds: ["item-c", "item-a", "item-b"],
        // Mixed case with surrounding whitespace — the trim+lowercase is pinned too.
        overlay: "  A Borrowed Hoodie ",
        exposure: { torso: "covered", pelvis: "sheer", legs: "bare", feet: "covered" },
        attributeOverlays: [
          { id: "hair.length", value: "short", source: "narrative" },
          { id: "hair.color", value: "auburn", source: "narrative" },
        ],
        garmentKey: " g1|sleeve_left=rolled|| ",
      }),
    ).toBe("505c4537");
  });

  it("pins a legacy free-text chat's key (empty worn list, overlay alone, no garment fingerprint)", () => {
    expect(
      chatLookKey({ wornItemIds: [], overlay: "a linen sundress", exposure: FULLY_COVERED, attributeOverlays: [] }),
    ).toBe("5fb5063f");
  });

  it("pins the fully-covered, overlay-free key the cases above build on", () => {
    expect(
      chatLookKey({ wornItemIds: ["item-b", "item-a"], overlay: "", exposure: FULLY_COVERED, attributeOverlays: [] }),
    ).toBe("7a2348c8");
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

  it("carries the sheet's age anchor after the identity lock (2026-07-29 ruling)", () => {
    const anchor = "Kristin is in her late twenties; her skin, hands and legs read smooth and youthful.";
    const prompt = buildChatLookPrompt({ outfit: "a linen sundress", outfitExposed: false, ageAnchor: anchor });
    expect(prompt).toContain(`apparent age. ${anchor} Change the outfit`);
  });

  it("the place shot is the sketch, empty of people", () => {
    const prompt = buildChatPlacePrompt({ placeName: "the kitchen", sketch: "Warm terracotta tiles; copper pans." });
    expect(prompt).toContain("establishing shot of the kitchen");
    expect(prompt).toContain("Warm terracotta tiles; copper pans.");
    expect(prompt).toContain("No people anywhere in frame");
  });
});
