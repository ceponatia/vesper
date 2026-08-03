import { describe, expect, it } from "vitest";
import { expectRefsResolve } from "@/test/registry-invariants";
import { bodyLocationRegistry } from "../body/locations";
import {
  displacementMarkers,
  garmentNounCoverage,
  negationMarkers,
  overlayWornInputs,
  sheerModifiers,
} from "./garment-noun-coverage";
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

  it("reads bikini SEPARATES as their own panel, never the pair", () => {
    // The defect: both resolved to the unigram, so a top covered the pelvis and
    // bottoms covered the chest — anatomy suppressed on a garment that is
    // demonstrably not there. Fixed in the vocabulary (compound heads), not here.
    const top = regionsOf("a bikini top");
    expect(top.torso).toBe("covered");
    expect(top.pelvis).toBe("bare");
    const bottoms = regionsOf("bikini bottoms");
    expect(bottoms.torso).toBe("bare");
    expect(bottoms.pelvis).toBe("covered");
    // The bare noun is still the pair, and still covers both.
    const pair = regionsOf("a bikini");
    expect(pair.torso).toBe("covered");
    expect(pair.pelvis).toBe("covered");
  });
});

describe("overlayWornInputs — named, but not covering", () => {
  it("a DENIED garment contributes nothing (the P1: stated bareness read as covered)", () => {
    expect(overlayWornInputs("without a shirt")).toEqual([]);
    expect(regionsOf("without a shirt").torso).toBe("bare");
  });

  it("denies only what the denial names", () => {
    const text = "no panties, just his hoodie";
    expect(rowFor(text, "panties")).toBeUndefined();
    const regions = regionsOf(text);
    expect(regions.torso).toBe("covered");
    expect(regions.pelvis).toBe("bare");
  });

  it("carries a denial across a conjunction — 'a shirt or bra' is ONE denial", () => {
    expect(overlayWornInputs("without a shirt or bra")).toEqual([]);
  });

  it("stops carrying at the first word that is not filler", () => {
    // Window-scoped on purpose. Clause-scoped negation would strip the sweater
    // here and bare a covered torso — the one direction that must never happen.
    const text = "no bra under her sweater";
    expect(rowFor(text, "bra")).toBeUndefined();
    expect(rowFor(text, "sweater")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("every negation marker denies the garment after it", () => {
    for (const marker of negationMarkers) {
      expect(overlayWornInputs(`${marker} a robe`), marker).toEqual([]);
    }
  });

  it("a DISPLACED garment contributes nothing, marker before or after the noun", () => {
    expect(overlayWornInputs("her shirt hanging open")).toEqual([]);
    expect(overlayWornInputs("gown pooled at her waist")).toEqual([]);
  });

  it("displaces only the garment it qualifies — the layer under it still covers", () => {
    const text = "unbuttoned jacket over a tee";
    expect(rowFor(text, "jacket")).toBeUndefined();
    expect(rowFor(text, "tee")).toBeDefined();
    expect(regionsOf(text).torso).toBe("covered");
  });

  it("every displacement marker reaches from BOTH windows", () => {
    for (const marker of displacementMarkers) {
      expect(overlayWornInputs(`her ${marker} robe`), `${marker} before`).toEqual([]);
      expect(overlayWornInputs(`her robe ${marker}`), `${marker} after`).toEqual([]);
    }
  });

  it("keeps hyphenated compounds whole, so a cut is not a displacement", () => {
    // "off-the-shoulder" is ONE token (the shared tokenizer), so the `off` marker
    // never appears in it — the same choice that keeps "lace-trimmed" opaque.
    expect(rowFor("off-the-shoulder gown", "gown")).toBeDefined();
    expect(regionsOf("off-the-shoulder gown").torso).toBe("covered");
  });

  it("a suppressed noun still closes the sheer window (the modifier was ITS adjective)", () => {
    expect(rowFor("no sheer bra under her sweater", "sweater")?.opacity).toBe("opaque");
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
