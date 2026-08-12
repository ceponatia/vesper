import { describe, expect, it } from "vitest";
import { emptyImageModelAdvancedCapabilities } from "../capabilities/image-model-capabilities";
import type { ImageModel } from "../models/image-models";
import type { SceneVisualReference } from "../references/scene-reference";
import { attemptReferenceCount, routeSceneAttempts } from "./attempts";

const charRef = (overrides: Partial<SceneVisualReference> = {}): SceneVisualReference => ({
  kind: "character",
  allowForIntimate: true,
  ...overrides,
});

/** A registry row shaped like the seeded qwen edit model unless overridden. */
const model = (overrides: Partial<ImageModel> = {}): ImageModel => ({
  id: "m1",
  slug: "qwen/qwen-image-edit-2511",
  label: "Qwen Image Edit 2511",
  canGenerate: false,
  canEdit: true,
  referenceField: "image",
  referenceArity: "array",
  referenceTransport: "file",
  maxReferences: 3,
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "3:4", "16:9"],
  outputFormat: "webp",
  extraInput: {},
  // Scene routing reads mechanical capability only; these are the reviewed
  // ratings the seeded row carries.
  probedVersionId: null,
  editKind: "instruction_edit",
  identityPreservation: "strong",
  operatorWarning: null,
  advancedCapabilities: emptyImageModelAdvancedCapabilities(),
  forPortrait: false,
  forVariant: true,
  forScene: true,
  builtin: true,
  sort: 20,
  ...overrides,
});

const withImage = (id: string) => charRef({ entityId: id, name: id, imageId: `img-${id}`, source: "generated" });

describe("routeSceneAttempts", () => {
  it("demo mode routes to the monogram only", () => {
    expect(routeSceneAttempts({ references: [], demo: true, model: model() })).toEqual(["demo"]);
  });

  it("demo mode ignores the model and the reference mode", () => {
    expect(routeSceneAttempts({ references: [], demo: true, mode: "multi", model: null })).toEqual(["demo"]);
  });

  it("edits when a usable reference exists", () => {
    expect(routeSceneAttempts({ references: [withImage("c1")], demo: false, model: model() })).toEqual(["edit"]);
  });

  it("prepends the multi rung only in multi mode with two usable references", () => {
    const two = [withImage("c1"), withImage("c2")];
    expect(routeSceneAttempts({ references: two, demo: false, mode: "multi", model: model() })).toEqual([
      "multi_edit",
      "edit",
    ]);
    // Same two references, single mode: no multi rung.
    expect(routeSceneAttempts({ references: two, demo: false, mode: "single", model: model() })).toEqual(["edit"]);
    // Multi mode, one reference: nothing to combine.
    expect(routeSceneAttempts({ references: [two[0]!], demo: false, mode: "multi", model: model() })).toEqual(["edit"]);
  });

  it("never offers a multi rung to a single-reference model, however many refs exist", () => {
    const single = model({ referenceArity: "single", maxReferences: 1 });
    const two = [withImage("c1"), withImage("c2")];
    expect(routeSceneAttempts({ references: two, demo: false, mode: "multi", model: single })).toEqual(["edit"]);
  });

  it("falls back to a bare prompt only for a model that can generate", () => {
    const noImages = [charRef({ entityId: "c1", name: "Mira" })];
    const generative = model({ canGenerate: true });
    expect(routeSceneAttempts({ references: noImages, demo: false, model: generative })).toEqual(["generate"]);
  });

  it("returns an empty chain when an edit-only model has no reference", () => {
    const noImages = [charRef({ entityId: "c1", name: "Mira" })];
    // The caller turns this into a visible refusal rather than rendering a
    // different-looking person (owner ruling 2026-07-29).
    expect(routeSceneAttempts({ references: noImages, demo: false, model: model() })).toEqual([]);
  });

  it("returns an empty chain when no model is registered", () => {
    expect(routeSceneAttempts({ references: [withImage("c1")], demo: false, model: null })).toEqual([]);
  });
});

describe("attemptReferenceCount", () => {
  it("gives the multi rung the model's full capacity and the edit rung one", () => {
    expect(attemptReferenceCount("multi_edit", model())).toBe(3);
    expect(attemptReferenceCount("edit", model())).toBe(1);
  });

  it("caps the multi rung at what a single-reference model accepts", () => {
    expect(attemptReferenceCount("multi_edit", model({ referenceArity: "single", maxReferences: 5 }))).toBe(1);
  });

  it("sends nothing on the demo and generate rungs", () => {
    expect(attemptReferenceCount("generate", model())).toBe(0);
    expect(attemptReferenceCount("demo", model())).toBe(0);
    expect(attemptReferenceCount("edit", null)).toBe(0);
  });
});
