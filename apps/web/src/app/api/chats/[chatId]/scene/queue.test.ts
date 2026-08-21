import { describe, expect, it } from "vitest";
import { seedChatState } from "@/server/engine";
import { makeProfile } from "@/server/test-support";
import { memberSceneState } from "./queue";

/**
 * The queue's per-member resolution input (PR #152 follow-up). Falsified
 * against the old castDetail, which skipped wardrobe resolution entirely for a
 * roster member with no chat-state row — wardrobe null → outfit "" → the render
 * prompt fell to "casual everyday clothing" over the character's SAVED default
 * outfit. Seeding itself is chat-state.test.ts's invariant; this pins the
 * queue's claim that a stateless member RIDES that seed rather than nothing.
 */
describe("memberSceneState", () => {
  const dressed = () =>
    makeProfile({ outfits: [{ id: "everyday", name: "Everyday", items: ["itemid1abc", "itemid2def"] }] });

  it("a stateless member resolves from the first-exchange seed — the saved default outfit, never an empty worn set", () => {
    const state = memberSceneState(null, dressed());
    expect(state.wornItemIds).toEqual(["itemid1abc", "itemid2def"]);
    expect(state.outfitPresetId).toBe("everyday");
  });

  it("a stored row passes through untouched", () => {
    const stored = { ...seedChatState(dressed()), outfit: "a borrowed coat" };
    expect(memberSceneState(stored, dressed())).toBe(stored);
  });
});
