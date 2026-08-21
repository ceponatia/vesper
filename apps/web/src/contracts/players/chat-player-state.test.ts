import { describe, expect, it } from "vitest";
import { chatPlayerStateSchema } from "./chat-player-state";

/**
 * `seeded: true` over an empty `wornItemIds` is downstream PROOF of a stripped
 * player (`resolvePlayerWardrobe` reads it as `worn: []` — pelvis bare, the
 * scene-image viewer-body gates open). Falsified against the old `.catch([])`:
 * ONE malformed array element blanked the whole list while `seeded: true`
 * survived beside it, fabricating that proof from garbage. Elements parse
 * per-element so readable garments keep their coverage, and only a list read
 * in full as `[]` may combine with `seeded` into proven-stripped.
 */
describe("chatPlayerStateSchema — a malformed worn list cannot prove a stripped player", () => {
  it.each([
    ["a non-array value is unreadable — degrade to unseeded", { seeded: true, wornItemIds: "garbage" }, [], false],
    ["an all-dropped residue is not proof of emptiness", { seeded: true, wornItemIds: [42] }, [], false],
    ["a partial drop keeps the readable garments and the seed", { seeded: true, wornItemIds: ["shirt", 42] }, ["shirt"], true],
    ["a genuinely stored [] keeps its stripped proof", { seeded: true, wornItemIds: [] }, [], true],
    ["a clean list is untouched", { seeded: true, wornItemIds: ["shirt"] }, ["shirt"], true],
  ])("%s", (_case, raw, wornItemIds, seeded) => {
    const parsed = chatPlayerStateSchema.parse(raw);
    expect(parsed.wornItemIds).toEqual(wornItemIds);
    expect(parsed.seeded).toBe(seeded);
  });

  it("damage to the worn list leaves the rest of the state intact — never a whole-object fallback", () => {
    const parsed = chatPlayerStateSchema.parse({ personaId: "p1", overlay: "a scarf", seeded: true, wornItemIds: 7 });
    expect(parsed).toEqual({ personaId: "p1", wornItemIds: [], seeded: false, outfitPresetId: "", overlay: "a scarf" });
  });
});
