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
    ["a non-array value is unreadable — degrade to unseeded", { seeded: true, wornItemIds: "garbage" }, [], false, undefined],
    ["an all-dropped residue is not proof of emptiness", { seeded: true, wornItemIds: [42] }, [], false, undefined],
    ["a partial drop keeps the readable garments and the seed — marked incomplete", { seeded: true, wornItemIds: ["shirt", 42] }, ["shirt"], true, true],
    ["a genuinely stored [] keeps its stripped proof", { seeded: true, wornItemIds: [] }, [], true, undefined],
    ["a clean list is untouched", { seeded: true, wornItemIds: ["shirt"] }, ["shirt"], true, undefined],
  ])("%s", (_case, raw, wornItemIds, seeded, incomplete) => {
    const parsed = chatPlayerStateSchema.parse(raw);
    expect(parsed.wornItemIds).toEqual(wornItemIds);
    expect(parsed.seeded).toBe(seeded);
    // Survivors are readable wardrobe but NOT a complete one: the marker rides
    // exactly the partial-drop case, so `resolvePlayerWardrobe` degrades
    // exposure to covered instead of reading the dropped garment's regions bare.
    expect(parsed.wornItemIdsIncomplete).toBe(incomplete);
  });

  it("damage to the worn list leaves the rest of the state intact — never a whole-object fallback", () => {
    const parsed = chatPlayerStateSchema.parse({ personaId: "p1", overlay: "a scarf", seeded: true, wornItemIds: 7 });
    expect(parsed).toEqual({ personaId: "p1", wornItemIds: [], seeded: false, outfitPresetId: "", overlay: "a scarf" });
  });

  it("the incomplete marker is parse-derived, never persisted truth — a round-trip clears it", () => {
    // The defect this kills: were the marker persistable, writing the parsed
    // state back would carry it in jsonb forever and permanently park the mint
    // consumers. It is not: the shape strips the unknown key on reparse, and
    // the survivor list — now all strings, read in full — re-derives nothing.
    const damaged = chatPlayerStateSchema.parse({ seeded: true, wornItemIds: ["shirt", 42] });
    expect(damaged.wornItemIdsIncomplete).toBe(true);
    const reparsed = chatPlayerStateSchema.parse(JSON.parse(JSON.stringify(damaged)));
    expect(reparsed).toEqual({ personaId: "", wornItemIds: ["shirt"], seeded: true, outfitPresetId: "", overlay: "" });
    expect(reparsed.wornItemIdsIncomplete).toBeUndefined();
  });
});
