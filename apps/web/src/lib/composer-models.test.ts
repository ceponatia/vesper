import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCENE_COMPOSER_MODEL_ID,
  resolveSceneComposerModelId,
  SCENE_COMPOSER_MODELS,
} from "./composer-models";

describe("SCENE_COMPOSER_MODELS", () => {
  it("every entry is an OpenRouter slug (vendor/model) with a label and operator guidance", () => {
    for (const option of SCENE_COMPOSER_MODELS) {
      // The optional leading `~` is OpenRouter's floating-alias marker (the tilde-less form
      // 404s) — same shape guard the narrator list carries.
      expect(option.id).toMatch(/^~?[a-z0-9-]+\/[a-z0-9.-]+$/);
      expect(option.label.length).toBeGreaterThan(0);
      // The description is what an admin reads before moving a live conversation onto a
      // candidate; an entry without one is an unexplained choice in a dropdown.
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it("ids are unique", () => {
    const ids = SCENE_COMPOSER_MODELS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the default composer is one of the listed options", () => {
    expect(SCENE_COMPOSER_MODELS.some((option) => option.id === DEFAULT_SCENE_COMPOSER_MODEL_ID)).toBe(true);
  });

  it("the production default is pinned rather than a floating latest alias", () => {
    expect(DEFAULT_SCENE_COMPOSER_MODEL_ID).not.toMatch(/^~/);
    expect(DEFAULT_SCENE_COMPOSER_MODEL_ID).not.toMatch(/-latest$/);
  });

  it("has at least two entries — a one-model list cannot be a selection", () => {
    expect(SCENE_COMPOSER_MODELS.length).toBeGreaterThan(1);
  });
});

describe("resolveSceneComposerModelId", () => {
  it("passes a curated id through unchanged", () => {
    for (const option of SCENE_COMPOSER_MODELS) {
      expect(resolveSceneComposerModelId(option.id)).toBe(option.id);
    }
  });

  it("treats empty / null / undefined / whitespace as no override", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(resolveSceneComposerModelId(value)).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
    }
  });

  it("refuses an uncurated id — it would otherwise be billed to the deployment's key", () => {
    expect(resolveSceneComposerModelId("openai/gpt-5-pro")).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
    expect(resolveSceneComposerModelId("vendor/retired-model")).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
  });

  it("trims a stored id before matching, so a stray space is not a silent downgrade", () => {
    expect(resolveSceneComposerModelId(` ${DEFAULT_SCENE_COMPOSER_MODEL_ID} `)).toBe(DEFAULT_SCENE_COMPOSER_MODEL_ID);
  });
});
