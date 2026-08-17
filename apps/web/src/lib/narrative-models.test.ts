import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARACTER_CHAT_MODEL_ID,
  DEFAULT_NARRATIVE_MODEL_ID,
  NARRATIVE_MODELS,
  resolveChatModelId,
} from "./narrative-models";

describe("NARRATIVE_MODELS", () => {
  it("every entry is an OpenRouter slug (vendor/model) with a label", () => {
    for (const option of NARRATIVE_MODELS) {
      // The optional leading `~` is OpenRouter's marker for a **floating alias**
      // that redirects to the newest release in a family (e.g.
      // `~deepseek/deepseek-v4-flash-latest`). It is part of the slug — the
      // tilde-less form 404s — so the shape guard has to admit it.
      expect(option.id).toMatch(/^~?[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = NARRATIVE_MODELS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The dropdown renders the label and nothing else, so two rows sharing one is
  // an unpickable option, not a cosmetic slip. It bites hardest on the bench's
  // same-family rows (the two Euryale versions, the four TheDrummer tunes), where
  // the version is the only thing telling them apart.
  it("labels are unique", () => {
    const labels = NARRATIVE_MODELS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the default narrator is one of the listed options", () => {
    expect(NARRATIVE_MODELS.some((o) => o.id === DEFAULT_NARRATIVE_MODEL_ID)).toBe(true);
  });
});

describe("resolveChatModelId", () => {
  it("passes a curated id through unchanged", () => {
    for (const option of NARRATIVE_MODELS) {
      expect(resolveChatModelId(option.id)).toBe(option.id);
    }
  });

  it("falls back to the chat default for empty / null / unknown ids", () => {
    expect(resolveChatModelId("")).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(resolveChatModelId(null)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(resolveChatModelId(undefined)).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
    expect(resolveChatModelId("vendor/retired-model")).toBe(DEFAULT_CHARACTER_CHAT_MODEL_ID);
  });

  it("the chat default is itself a curated option", () => {
    expect(NARRATIVE_MODELS.some((o) => o.id === DEFAULT_CHARACTER_CHAT_MODEL_ID)).toBe(true);
  });
});
