import { describe, expect, it } from "vitest";
import { DEFAULT_NARRATIVE_MODEL_ID, NARRATIVE_MODELS } from "./narrative-models";

describe("NARRATIVE_MODELS", () => {
  it("every entry is an OpenRouter slug (vendor/model) with a label", () => {
    for (const option of NARRATIVE_MODELS) {
      expect(option.id).toMatch(/^[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = NARRATIVE_MODELS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the default narrator is one of the listed options", () => {
    expect(NARRATIVE_MODELS.some((o) => o.id === DEFAULT_NARRATIVE_MODEL_ID)).toBe(true);
  });
});
