import { describe, expect, it } from "vitest";
import { DiagnosticCollector, type AttributeValue } from "@/contracts";
import { emptyCharacterDraft, type CharacterDraft } from "./drafts";
import { derivePortraitAttributes, mergePortraitReadings, portraitAttributeDefinitions } from "./portrait-attributes";

const attr = (id: string, value: AttributeValue["value"], source: AttributeValue["source"] = "creation"): AttributeValue => ({
  id: id as AttributeValue["id"],
  value,
  source,
});

function draftWith(mutate: (draft: CharacterDraft) => void): CharacterDraft {
  const draft = emptyCharacterDraft();
  mutate(draft);
  return draft;
}

describe("portraitAttributeDefinitions", () => {
  it("offers appearance categories and excludes personality + intimate ones", () => {
    const definitions = portraitAttributeDefinitions(emptyCharacterDraft());
    const categories = new Set(definitions.map((d) => d.category));
    expect(categories.has("hair")).toBe(true);
    expect(categories.has("eyes")).toBe(true);
    expect(categories.has("voice")).toBe(false);
    expect(categories.has("presentation")).toBe(false);
    expect(categories.has("movement")).toBe(false);
    expect(categories.has("vulva")).toBe(false);
    expect(categories.has("breasts")).toBe(false);
  });
});

describe("mergePortraitReadings", () => {
  it("fills unset ids and reports (never applies) disagreements", () => {
    const sink = new DiagnosticCollector();
    const draft = draftWith((d) => {
      d.profile.attributes = [attr("hair.color", "black", "manual")];
    });
    const merged = mergePortraitReadings(draft, [attr("hair.color", "auburn"), attr("eyes.color", "green")], sink);
    expect(merged.profile.attributes).toEqual([attr("hair.color", "black", "manual"), attr("eyes.color", "green")]);
    const conflict = sink.items.find((d) => d.code === "forge.character.portrait.portrait_conflict");
    expect(conflict?.message).toContain("hair.color");
  });

  it("is silent when the portrait agrees with the sheet", () => {
    const sink = new DiagnosticCollector();
    const draft = draftWith((d) => {
      d.profile.attributes = [attr("hair.color", "black", "manual")];
    });
    const merged = mergePortraitReadings(draft, [attr("hair.color", "black")], sink);
    expect(merged.profile.attributes).toEqual(draft.profile.attributes);
    expect(sink.items).toEqual([]);
  });
});

describe("derivePortraitAttributes (keyless demo mode)", () => {
  it("degrades to a no-op with a diagnostic — never invents a reading of an image nobody looked at", async () => {
    const sink = new DiagnosticCollector();
    const draft = draftWith((d) => {
      d.profile.attributes = [attr("hair.color", "black", "manual")];
    });
    const result = await derivePortraitAttributes({
      draft,
      image: { data: new Uint8Array([1, 2, 3]), mediaType: "image/webp" },
      sink,
    });
    expect(result.profile.attributes).toEqual(draft.profile.attributes);
    expect(sink.items.some((d) => d.code === "forge.character.portrait.degraded")).toBe(true);
  });
});
