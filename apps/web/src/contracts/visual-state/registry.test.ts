import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toUnitInterval } from "../affordances/core";
import {
  defineVisualStateKind,
  VISUAL_STATE_KIND_ID_PATTERN,
  type VisualStateKindDefinition,
} from "./definitions";
import { presentationOwnedKindIds } from "./presentation";
import { visualStateKindRegistry } from "./registry";
import { visualStateLayers, visualStateStabilities } from "./vocabulary";
import type { VisualStateAttentionPriors } from "./priors";

/**
 * The kind registry is the extension point: a new visual vocabulary is a data
 * edit in `kinds.ts`. These tests pin the guarantees that makes safe — authored
 * calibration is validated at definition time and THROWS (a programmer error),
 * while every runtime read degrades with a diagnostic instead.
 */

const PRIORS: VisualStateAttentionPriors = {
  baseUniqueness: toUnitInterval(5_000),
  baseImportance: toUnitInterval(5_000),
  minimumDetailTier: 2,
};

type TestKind = VisualStateKindDefinition<string>;

function kind(overrides: Partial<TestKind> = {}): TestKind {
  return {
    id: "test.kind",
    layer: "identity",
    valueSchema: z.string().min(1),
    allowedLoci: ["body"],
    stability: "inherent",
    repeatFamily: "test",
    recognitionEligible: true,
    narratorEligible: true,
    imageEligible: true,
    priors: PRIORS,
    ...overrides,
  };
}

describe("defineVisualStateKind", () => {
  it("accepts a well-formed kind", () => {
    expect(defineVisualStateKind(kind()).id).toBe("test.kind");
  });

  it("rejects an id that is not <family>.<snake_case>", () => {
    expect(() => defineVisualStateKind(kind({ id: "TestKind" }))).toThrow(/family/);
    expect(() => defineVisualStateKind(kind({ id: "nofamily" }))).toThrow(/family/);
  });

  it("rejects a kind that allows no loci", () => {
    expect(() => defineVisualStateKind(kind({ allowedLoci: [] }))).toThrow(/no loci/);
  });

  it("rejects a repeated locus kind", () => {
    expect(() => defineVisualStateKind(kind({ allowedLoci: ["body", "body"] }))).toThrow(/repeats/);
  });

  it("refuses to let a one-cut fact earn a recognition floor", () => {
    expect(() =>
      defineVisualStateKind(kind({ stability: "instantaneous", recognitionEligible: true })),
    ).toThrow(/instantaneous/);
  });

  it("allows an instantaneous kind that stays out of recognition", () => {
    const defined = defineVisualStateKind(kind({ stability: "instantaneous", recognitionEligible: false }));
    expect(defined.stability).toBe("instantaneous");
  });
});

describe("visualStateKindRegistry", () => {
  // Named rather than counted: a count says nothing about WHICH kind went
  // missing, and the catalog is the extension point every later slice edits.
  it("registers exactly the first-release catalog", () => {
    expect(visualStateKindRegistry.definitions.map((definition) => definition.id)).toEqual([
      "appearance.attribute",
      "appearance.located_fact",
      "appearance.anatomy",
      "species.feature_group",
      "wardrobe.garment",
      "wardrobe.item",
      "presentation.hairstyle",
      "presentation.makeup",
      "presentation.grooming",
      "presentation.nail_finish",
      "presentation.cosmetic_mark",
    ]);
  });

  it("keeps every item-backed kind out of the non-item presentation owner", () => {
    for (const id of ["wardrobe.garment", "wardrobe.item"]) {
      expect(presentationOwnedKindIds).not.toContain(id);
      expect(visualStateKindRegistry.byId(id)?.layer).toBe("presentation");
    }
  });

  it("refuses a species feature group anywhere but a body locus", () => {
    expect(visualStateKindRegistry.allowsLocus("species.feature_group", "body")).toBe(true);
    expect(visualStateKindRegistry.allowsLocus("species.feature_group", "item")).toBe(false);
  });

  it("hangs wardrobe at an item locus and never on the body", () => {
    expect(visualStateKindRegistry.allowsLocus("wardrobe.garment", "item")).toBe(true);
    expect(visualStateKindRegistry.allowsLocus("wardrobe.garment", "body")).toBe(false);
  });

  it("marks species feature groups mandatory, so salience can never trade morphology away", () => {
    const definition = visualStateKindRegistry.byId("species.feature_group");
    expect(definition?.priors.mandatoryForIdentity).toBe(true);
    expect(definition?.priors.mandatoryForContinuity).toBe(true);
  });

  it("gives every kind a well-formed id, a known layer, and a known stability", () => {
    for (const definition of visualStateKindRegistry.definitions) {
      expect(definition.id).toMatch(VISUAL_STATE_KIND_ID_PATTERN);
      expect(visualStateLayers).toContain(definition.layer);
      expect(visualStateStabilities).toContain(definition.stability);
      expect(definition.repeatFamily.length).toBeGreaterThan(0);
    }
  });

  it("answers an unknown id with undefined rather than throwing", () => {
    expect(visualStateKindRegistry.byId("nowhere.kind")).toBeUndefined();
    expect(visualStateKindRegistry.allowsLocus("nowhere.kind", "body")).toBe(false);
  });

  it("gates loci per kind", () => {
    const [first] = visualStateKindRegistry.definitions;
    expect(first).toBeDefined();
    expect(visualStateKindRegistry.allowsLocus(first?.id ?? "", "body")).toBe(true);
    expect(visualStateKindRegistry.allowsLocus(first?.id ?? "", "relation")).toBe(false);
  });

  it("reports a value failure as issues, not an exception", () => {
    const [first] = visualStateKindRegistry.definitions;
    const result = visualStateKindRegistry.parseValue(first?.id ?? "", 42);
    expect(result.ok).toBe(false);
  });
});
