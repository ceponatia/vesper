import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHARACTER_CHAT_MODEL_ID,
  DEFAULT_NARRATIVE_MODEL_ID,
  NARRATIVE_MODELS,
  narrativeModelProvider,
  resolveChatModelId,
} from "./narrative-models";

describe("NARRATIVE_MODELS", () => {
  it("every OpenRouter entry is a vendor/model slug with a label", () => {
    for (const option of NARRATIVE_MODELS.filter((o) => narrativeModelProvider(o.id) === "openrouter")) {
      // The optional leading `~` is OpenRouter's marker for a **floating alias**
      // that redirects to the newest release in a family (e.g.
      // `~deepseek/deepseek-v4-flash-latest`). It is part of the slug — the
      // tilde-less form 404s — so the shape guard has to admit it.
      expect(option.id).toMatch(/^~?[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  // Featherless ids are Hugging Face repo paths, so they carry the case and the
  // underscores the OpenRouter guard above forbids. They are still `owner/name`,
  // which is what keeps one namespace usable for both providers.
  it("every Featherless entry is a Hugging Face repo path with a label", () => {
    const featherless = NARRATIVE_MODELS.filter((o) => narrativeModelProvider(o.id) === "featherless");
    expect(featherless.length).toBeGreaterThan(0);
    for (const option of featherless) {
      expect(option.id).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });

  // The id alone names the upstream (there is no provider prefix), so a collision
  // between two providers' catalogs would silently route one model to the other's
  // endpoint. Uniqueness is what makes `narrativeModelProvider` a total function.
  it("ids are unique", () => {
    const ids = NARRATIVE_MODELS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a listed row reports its provider; anything unlisted reads as OpenRouter", () => {
    for (const option of NARRATIVE_MODELS) {
      expect(narrativeModelProvider(option.id)).toBe(option.provider ?? "openrouter");
    }
    expect(narrativeModelProvider("vendor/never-listed")).toBe("openrouter");
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
