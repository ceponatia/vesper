import { describe, expect, it } from "vitest";
import { emptyChatPlayerState, personaProfileSchema } from "@/contracts";
import { playerWornIds } from "./chat-wardrobe";

/**
 * The seeded/unseeded rule (persona-library.plan.md slice 8). The pure half of the
 * player's wardrobe: `resolvePlayerWardrobe` needs a database, but the decision that
 * actually matters — *what is the player wearing right now* — is this function, and it
 * is shared by the read path and the archivist's fold so the two can't disagree.
 */
describe("playerWornIds", () => {
  const persona = personaProfileSchema.parse({
    outfits: [
      { id: "everyday", name: "Everyday", items: ["shirt", "jeans"] },
      { id: "formal", name: "Formal", items: ["suit"] },
    ],
  });
  const state = (over: Partial<ReturnType<typeof emptyChatPlayerState>> = {}) => ({
    ...emptyChatPlayerState(),
    ...over,
  });

  it("wears the persona's default preset before anything has changed the wardrobe", () => {
    // The whole point of `seeded`: an unseeded chat must not read as naked.
    expect(playerWornIds(state(), persona)).toEqual(["shirt", "jeans"]);
  });

  it("honours a named preset while still unseeded", () => {
    expect(playerWornIds(state({ outfitPresetId: "formal" }), persona)).toEqual(["suit"]);
  });

  it("an unknown preset id falls back to the default preset, never to naked", () => {
    expect(playerWornIds(state({ outfitPresetId: "no-such-preset" }), persona)).toEqual(["shirt", "jeans"]);
  });

  it("once seeded, the stored list is the truth", () => {
    expect(playerWornIds(state({ seeded: true, wornItemIds: ["jeans"] }), persona)).toEqual(["jeans"]);
  });

  // The distinction the flag exists for: the same empty list, two opposite meanings.
  it("distinguishes not-dressed-yet from stripped", () => {
    expect(playerWornIds(state({ seeded: false, wornItemIds: [] }), persona)).toEqual(["shirt", "jeans"]);
    expect(playerWornIds(state({ seeded: true, wornItemIds: [] }), persona)).toEqual([]);
  });

  it("is empty with no persona — nobody to dress", () => {
    expect(playerWornIds(state(), undefined)).toEqual([]);
    expect(playerWornIds(state({ seeded: true, wornItemIds: ["shirt"] }), undefined)).toEqual(["shirt"]);
  });

  it("is empty when the persona has no wardrobe authored (unknown, and the caller reads it as covered)", () => {
    expect(playerWornIds(state(), personaProfileSchema.parse({}))).toEqual([]);
  });

  it("does not alias the persona's preset array (a later equip must not mutate the persona)", () => {
    const ids = playerWornIds(state(), persona);
    ids.push("hat");
    expect(persona.outfits[0]?.items).toEqual(["shirt", "jeans"]);
  });
});
