import { describe, expect, it } from "vitest";
import { seedChatState } from "@/server/engine";
import { makeProfile } from "@/server/test-support";
import { memberSceneState, type QueueChatSceneMember, selectSceneCast } from "./queue";

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

/**
 * #436: the Gallery owner is carried apart from the rendered subject. A selfie
 * by the non-primary used to be filed under its sender (the strip, which reads
 * the primary, never saw it); the filing id must be the primary whoever draws.
 */
describe("selectSceneCast", () => {
  const primary: QueueChatSceneMember = { id: "char-primary", name: "Ada", profile: {} };
  const second: QueueChatSceneMember = { id: "char-second", name: "Bea", profile: {} };
  const third: QueueChatSceneMember = { id: "char-third", name: "Cy", profile: {} };
  const entry = (member: QueueChatSceneMember, presence: "present" | "away" = "present") => ({
    member,
    stored: { ...seedChatState(makeProfile()), presence },
  });

  it("a selfie by the non-primary is filed under the primary and draws only its sender", () => {
    const result = selectSceneCast({
      subject: second,
      flavor: "selfie",
      entries: [entry(primary), entry(second)],
    });
    expect(result.filedCharacterId).toBe(primary.id);
    expect(result.castStates.map((e) => e.member.id)).toEqual([second.id]);
  });

  it("a normal scene is filed under the primary and draws every present member in roster order", () => {
    const result = selectSceneCast({
      subject: primary,
      entries: [entry(primary), entry(second), entry(third, "away")],
    });
    expect(result.filedCharacterId).toBe(primary.id);
    expect(result.castStates.map((e) => e.member.id)).toEqual([primary.id, second.id]);
  });

  it("everyone away falls back to the subject, still filed under the primary", () => {
    const result = selectSceneCast({
      subject: second,
      entries: [entry(primary, "away"), entry(second, "away")],
    });
    expect(result.filedCharacterId).toBe(primary.id);
    expect(result.castStates.map((e) => e.member.id)).toEqual([second.id]);
  });

  it("an empty roster files under, and draws, the subject (the cast is never empty)", () => {
    const result = selectSceneCast({ subject: second, entries: [] });
    expect(result.filedCharacterId).toBe(second.id);
    expect(result.castStates.map((e) => e.member.id)).toEqual([second.id]);
  });
});
