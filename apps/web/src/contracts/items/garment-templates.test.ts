import { describe, expect, it } from "vitest";
import { clothingCategories } from "./clothing-categories";
import { expandCoverage } from "./coverage";
import { validateGarmentBlueprint } from "./garment-blueprint-validation";
import { GARMENT_ROOT_PART_ID } from "./garment-blueprint";
import {
  garmentCategoryTemplates,
  garmentSparseTemplateCategoryIds,
  garmentTemplateForCategory,
  mintGarmentBlueprint,
} from "./garment-templates";

describe("garment category templates", () => {
  it("has a template for every clothing category, and no orphans", () => {
    expect(Object.keys(garmentCategoryTemplates).sort()).toEqual(clothingCategories.map((c) => c.id).sort());
  });

  it("EVERY template passes the validator", () => {
    for (const category of clothingCategories) {
      const template = garmentCategoryTemplates[category.id];
      expect(template, category.id).toBeDefined();
      if (!template) continue;
      const result = validateGarmentBlueprint(template);
      expect(result.issues.map((i) => `${i.code}${i.partId ? ` @${i.partId}` : ""}`), category.id).toEqual([]);
    }
  });

  it("the union of a template's node coverage IS the category coverage (migration is coverage-neutral)", () => {
    for (const category of clothingCategories) {
      const template = garmentCategoryTemplates[category.id];
      if (!template) continue;
      const union = new Set(template.nodes.flatMap((node) => [...expandCoverage(node.baselineCoverage)]));
      const expected = expandCoverage(category.coverage);
      expect([...union].sort(), category.id).toEqual([...expected].sort());
    }
  });

  it("the sparse-template categories are sparse; every other category is root-only", () => {
    // A FLOOR, not a fixed count: authoring a NEW sparse template is a pure
    // vocabulary addition, while silently losing one (or shipping none) is a
    // regression. What the count used to stand in for — that the list and the
    // templates agree — is the per-category assertion below.
    expect(garmentSparseTemplateCategoryIds.length).toBeGreaterThanOrEqual(9);
    for (const id of garmentSparseTemplateCategoryIds) {
      expect(clothingCategories.some((category) => category.id === id), `sparse list names ${id}`).toBe(true);
    }
    for (const category of clothingCategories) {
      const template = garmentCategoryTemplates[category.id];
      if (!template) continue;
      const sparse = garmentSparseTemplateCategoryIds.includes(category.id);
      expect(template.nodes.length > 1, category.id).toBe(sparse);
      if (sparse) continue;
      expect(template.nodes[0]?.id, category.id).toBe(GARMENT_ROOT_PART_ID);
      expect([...(template.nodes[0]?.baselineCoverage ?? [])].sort(), category.id).toEqual(
        [...category.coverage].sort(),
      );
    }
  });

  it("carries the asymmetric parts the plan's motivating cases need", () => {
    const top = garmentCategoryTemplates.top;
    expect(top?.nodes.find((n) => n.id === "sleeve_left")?.side).toBe("left");
    expect(top?.nodes.find((n) => n.id === "sleeve_right")?.side).toBe("right");
    expect(top?.behaviors.filter((b) => b.behavior === "rollable_sleeve")).toHaveLength(2);
    expect(top?.nodes.some((n) => n.kind === "collar")).toBe(true);
    expect(top?.nodes.filter((n) => n.kind === "cuff")).toHaveLength(2);
  });

  it("models a placket as ONE closure with a fastener count, never per-button nodes", () => {
    const top = garmentCategoryTemplates.top;
    const closure = top?.behaviors.find((b) => b.behavior === "linear_front_closure");
    expect(closure?.fastenerCount).toBe(6);
    expect(top?.nodes.filter((n) => n.kind === "closure")).toHaveLength(1);
  });

  it("defaults every node to the conservative unknown material", () => {
    for (const template of Object.values(garmentCategoryTemplates)) {
      for (const node of template.nodes) expect(node.materialProfileId).toBe("unknown");
    }
  });
});

describe("garmentTemplateForCategory", () => {
  it("resolves case-insensitively through the category registry", () => {
    expect(garmentTemplateForCategory("Top")?.nodes.length).toBeGreaterThan(1);
    expect(garmentTemplateForCategory(" skirt ")?.nodes.some((n) => n.id === "panel")).toBe(true);
  });

  it("misses cleanly on an unknown category", () => {
    expect(garmentTemplateForCategory("tuxedo")).toBeUndefined();
  });

  it("stamps a requested material onto every node", () => {
    const template = garmentTemplateForCategory("outerwear", "leather");
    expect(template?.nodes.every((n) => n.materialProfileId === "leather")).toBe(true);
    expect(validateGarmentBlueprint(template ?? garmentCategoryTemplates.top!).issues).toEqual([]);
  });
});

describe("mintGarmentBlueprint (R2 ad-hoc path)", () => {
  it("mints a VALID blueprint from every category, with the requested material", () => {
    for (const category of clothingCategories) {
      const minted = mintGarmentBlueprint({ categoryId: category.id, materialProfileId: "knit" });
      expect(validateGarmentBlueprint(minted).issues, category.id).toEqual([]);
      expect(minted.nodes.every((n) => n.materialProfileId === "knit"), category.id).toBe(true);
    }
  });

  it("mints a valid, coverage-free, behavior-free root for an unknown or absent category", () => {
    for (const minted of [mintGarmentBlueprint({ categoryId: "poncho" }), mintGarmentBlueprint({})]) {
      expect(validateGarmentBlueprint(minted).issues).toEqual([]);
      expect(minted.nodes).toHaveLength(1);
      expect(minted.nodes[0]?.baselineCoverage).toEqual([]);
      expect(minted.behaviors).toEqual([]);
      expect(minted.nodes[0]?.materialProfileId).toBe("unknown");
    }
  });

  it("a minted garment can never subtract intimate coverage on its own", () => {
    // "a borrowed hoodie" — F21. Every location it covers is one the category
    // already covered, and no behavior on it targets an intimate location.
    const hoodie = mintGarmentBlueprint({ categoryId: "outerwear" });
    const covered = new Set(hoodie.nodes.flatMap((n) => n.baselineCoverage));
    for (const intimate of ["groin", "hips", "buttocks", "pelvis", "thighs"]) {
      expect(covered.has(intimate)).toBe(false);
    }
  });
});
