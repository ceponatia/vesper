import { describe, expect, it } from "vitest";
import { characterDraftSchema, emptyCharacterDraft } from "./drafts";

describe("character draft schema", () => {
  it("characterDraftSchema parses {} into a complete draft", () => {
    const draft = characterDraftSchema.parse({});
    expect(draft.name).toBe("");
    expect(draft.tags).toEqual([]);
    expect(draft.suggestedItems).toEqual([]);
    expect(draft.profile.bodyPlanId).toBe("humanoid");
    expect(draft.profile.attributes).toEqual([]);
    expect(draft.profile.outfits).toEqual([]);
  });

  it("empty helper returns an independent profile", () => {
    expect(emptyCharacterDraft().profile).not.toBe(emptyCharacterDraft().profile);
  });
});
