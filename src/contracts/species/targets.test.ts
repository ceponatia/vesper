import { describe, expect, it } from "vitest";
import { detectBodyTargets, expandBodyTarget, resolveBodyTarget } from "./targets";
import { realizeBody } from "./realize";

const categoriesOf = (term: string): Set<string> => {
  const expansion = resolveBodyTarget(term);
  return new Set((expansion?.definitions ?? []).map((d) => d.category));
};

const ids = (term: string): string[] => (resolveBodyTarget(term)?.definitions ?? []).map((d) => d.id);

describe("resolveBodyTarget", () => {
  it('expands "face" to face + eyes + brows + lips (the colloquial group)', () => {
    const cats = categoriesOf("face");
    expect(cats).toContain("face");
    expect(cats).toContain("eyes");
    expect(cats).toContain("brows");
    expect(cats).toContain("lips");
    expect(resolveBodyTarget("face")?.locationIds).toContain("eyes"); // pulled via subtree expand
  });

  it("resolves a plain location to just its own attributes", () => {
    expect(categoriesOf("eyes")).toEqual(new Set(["eyes"]));
  });

  it("resolves a category id directly (hair)", () => {
    expect(categoriesOf("hair")).toEqual(new Set(["hair"]));
  });

  it("resolves colloquial synonyms that match no location or category id", () => {
    expect(categoriesOf("mouth")).toEqual(new Set(["lips", "teeth"]));
    expect(categoriesOf("figure")).toEqual(new Set(["build"]));
    expect(categoriesOf("physique")).toEqual(new Set(["build"]));
  });

  it("normalizes case and spacing (Upper Arms → upper_arms)", () => {
    expect(resolveBodyTarget("Upper Arms")?.term).toBe("upper_arms");
    expect(resolveBodyTarget("upper arms")?.locationIds).toContain("upper_arms");
  });

  it("returns undefined for an unknown term and de-duplicates definitions", () => {
    expect(resolveBodyTarget("zorp")).toBeUndefined();
    const list = ids("face");
    expect(list.length).toBe(new Set(list).size);
  });
});

describe("expandBodyTarget — realized-body filtering", () => {
  it('drops anatomy the character lacks ("chest" without breasts)', () => {
    const flat = realizeBody({}); // empty body-config — no breasts
    const expanded = expandBodyTarget("chest", flat.isAttributeApplicable);
    const cats = new Set((expanded?.definitions ?? []).map((d) => d.category));
    expect(cats).toContain("chest");
    expect(cats).not.toContain("breasts");
  });

  it("keeps that anatomy when the body-config has it", () => {
    const busty = realizeBody({ intimateRegions: ["breasts"] });
    const expanded = expandBodyTarget("chest", busty.isAttributeApplicable);
    const cats = new Set((expanded?.definitions ?? []).map((d) => d.category));
    expect(cats).toContain("breasts");
  });

  it("is identical to resolveBodyTarget when no predicate is given", () => {
    expect(expandBodyTarget("eyes")?.definitions.map((d) => d.id)).toEqual(ids("eyes"));
  });
});

describe("detectBodyTargets", () => {
  it("finds a body reference in prose and expands it", () => {
    const found = detectBodyTargets("I look at her face for a long moment");
    expect(found.map((f) => f.term)).toContain("face");
  });

  it("prefers the longest phrase and consumes its span (upper arms, not arms)", () => {
    const terms = detectBodyTargets("she flexes her upper arms").map((f) => f.term);
    expect(terms).toContain("upper_arms");
    expect(terms).not.toContain("arms");
  });

  it("detects multiple distinct references, once each", () => {
    const terms = detectBodyTargets("his hands and his feet and his hands again").map((f) => f.term);
    expect(terms.filter((t) => t === "hands")).toHaveLength(1);
    expect(terms).toContain("feet");
  });

  it("returns nothing when no body reference is present", () => {
    expect(detectBodyTargets("the weather turned cold")).toEqual([]);
  });
});
