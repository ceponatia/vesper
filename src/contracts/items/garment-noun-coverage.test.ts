import { describe, expect, it } from "vitest";
import { expectRefsResolve } from "@/test/registry-invariants";
import { bodyLocationRegistry } from "../body/locations";
import { garmentNounCoverage, overlayWornInputs, sheerModifiers } from "./garment-noun-coverage";
import { exposedRegions } from "./visibility";

/** The four regions the rows exist to answer for, straight through the shared classifier. */
const regionsOf = (text: string) => exposedRegions(overlayWornInputs(text));

const rowFor = (text: string, identity: string) => overlayWornInputs(text).find((row) => row.name === identity);

describe("garment-noun coverage registry", () => {
  it("every mapped coverage id is a registered body location", () => {
    // A coverage id missing from the registry is silently SKIPPED by
    // exposedRegions, so a typo here would read as "this garment covers nothing"
    // — the exact silent failure this suite exists to catch.
    expectRefsResolve(
      [...garmentNounCoverage],
      ([, mapping]) => mapping.coverage,
      (id) => bodyLocationRegistry.byId(id),
      ([identity], id) => `${identity} → ${id}`,
    );
  });

  it("every mapping covers something (an empty row would be a dead entry)", () => {
    const empty = [...garmentNounCoverage].filter(([, mapping]) => mapping.coverage.length === 0);
    expect(empty.map(([identity]) => identity)).toEqual([]);
  });
});

describe("overlayWornInputs — the coverage a described look contributes", () => {
  it("reads a described gown as a gown (the defect: it contributed nothing)", () => {
    // The reported failure: a thong plus this overlay computed torso "bare", and
    // the scene prompt drew chest anatomy through the beading.
    const regions = regionsOf("pale lavender gown with delicate beading");
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("covered");
    expect(regions.legs).toBe("covered");
    // A dress says nothing about the feet — it must not silently shoe her.
    expect(regions.feet).toBe("bare");
  });

  it("answers PER REGION, so 'only a thong' is pelvis-covered and torso-bare", () => {
    const regions = regionsOf("wearing only a red thong");
    expect(regions.pelvis).toBe("covered");
    expect(regions.torso).toBe("bare");
  });

  it("names no garment ⇒ no rows at all", () => {
    expect(overlayWornInputs("wrapped in shadows and nothing else")).toEqual([]);
    expect(overlayWornInputs("")).toEqual([]);
  });

  it("an ambiguous-coverage garment contributes nothing rather than a guess", () => {
    // The noun registry knows "scarf"/"cloak"; this table deliberately does not.
    // A cloak may hang open over a bare chest, so mapping it would suppress
    // anatomy on nothing better than a coin flip.
    expect(overlayWornInputs("a long silk scarf")).toEqual([]);
    expect(overlayWornInputs("a heavy travelling cloak")).toEqual([]);
    expect(regionsOf("a long silk scarf").torso).toBe("bare");
  });

  it("carries the compound heads the noun registry resolves", () => {
    expect(rowFor("a paint-streaked tank top", "tank_top")?.coverage).toContain("chest");
    expect(regionsOf("a tank top and jeans").pelvis).toBe("covered");
  });

  it("keeps synthetic rows identifiable and out of anyone's id space", () => {
    const rows = overlayWornInputs("a linen shirt");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.instanceId).toBe("overlay:shirt");
    expect(rows[0]?.garmentId).toBe(rows[0]?.instanceId);
    expect(rows[0]?.opacity).toBe("opaque");
  });

  it("folds a repeated identity to one row", () => {
    expect(overlayWornInputs("a shirt over another shirt")).toHaveLength(1);
  });
});

describe("overlayWornInputs — the sheer window", () => {
  it("a modifier before a garment makes THAT garment see-through", () => {
    expect(rowFor("a sheer black negligee", "negligee")?.opacity).toBe("sheer");
    expect(regionsOf("a sheer black negligee").torso).toBe("sheer");
  });

  it("every listed modifier reaches the garment it qualifies", () => {
    for (const modifier of sheerModifiers) {
      expect(rowFor(`a ${modifier} robe`, "robe")?.opacity, modifier).toBe("sheer");
    }
  });

  it("does not leak across a clause boundary", () => {
    const text = "a lace-trimmed cotton robe, sheer stockings";
    // "lace-trimmed" is one token (the shared tokenizer keeps hyphenated
    // compounds whole), so the trim never reads as the fabric…
    expect(rowFor(text, "robe")?.opacity).toBe("opaque");
    // …and the comma stops the modifier that follows from reaching backwards.
    expect(rowFor(text, "stockings")?.opacity).toBe("sheer");
    expect(rowFor("a sheer camisole, a wool skirt", "skirt")?.opacity).toBe("opaque");
  });

  it("is spent on the first garment it reaches", () => {
    const text = "a sheer robe over a cotton shift dress";
    expect(rowFor(text, "robe")?.opacity).toBe("sheer");
    expect(rowFor(text, "dress")?.opacity).toBe("opaque");
    // Opaque wins the region even under a sheer layer — the classifier's own rule.
    expect(exposedRegions(overlayWornInputs(text)).torso).toBe("covered");
  });

  it("an unmapped garment still closes the window (the modifier was ITS adjective)", () => {
    expect(rowFor("a sheer scarf and a linen dress", "dress")?.opacity).toBe("opaque");
  });
});
