import { describe, expect, it } from "vitest";
import { bodyLocationRegistry } from "../../../body/locations";
import { expandCoverage, toggleCoverage } from "../../../items/coverage";
import {
  footContactLocationIds,
  footLocus,
  footLociEqual,
  footLocusKey,
  footSurfaceAncestors,
  footSurfaceChildren,
  footSurfaceCoverageLocationId,
  footSurfaceForDetail,
  footSurfaceForLocation,
  footSurfaceIds,
  footSurfaceNode,
  footSurfaceSubtree,
  footSurfaceTopology,
} from "./topology";

/**
 * The topology and its two registry pointers.
 *
 * The registry half matters as much as the tree: slice 2 added `foot_arch`,
 * `ball_of_foot`, and `toenails` as NON-slot loci, and the point of that choice
 * is that wardrobe coverage behaves exactly as it did before while contact gains
 * three places to talk about.
 */

describe("foot surface topology", () => {
  it("declares every id exactly once, parents before children", () => {
    const seen = new Set<string>();
    for (const node of footSurfaceTopology) {
      expect(seen.has(node.id), node.id).toBe(false);
      if (node.parentId !== undefined) expect(seen.has(node.parentId), node.id).toBe(true);
      seen.add(node.id);
    }
    expect(seen.size).toBe(footSurfaceIds.length);
  });

  it("maps every surface onto a registered body location", () => {
    for (const node of footSurfaceTopology) {
      expect(bodyLocationRegistry.byId(node.bodyLocationId), node.id).toBeDefined();
    }
  });

  it("reports a coverage-relevant locus for every surface", () => {
    for (const surfaceId of footSurfaceIds) {
      const locationId = footSurfaceCoverageLocationId(surfaceId);
      expect(bodyLocationRegistry.byId(locationId)?.coverageRelevant, surfaceId).not.toBe(false);
    }
  });

  it("rolls the three new contact loci up to the slot that contains them", () => {
    expect(footSurfaceCoverageLocationId("arch")).toBe("sole");
    expect(footSurfaceCoverageLocationId("medial_arch")).toBe("sole");
    expect(footSurfaceCoverageLocationId("ball")).toBe("sole");
    expect(footSurfaceCoverageLocationId("toenails")).toBe("toes");
    expect(footSurfaceCoverageLocationId("heel_pad")).toBe("heel");
  });

  it("expands a subtree depth-first and walks ancestors nearest-first", () => {
    expect(footSurfaceSubtree("arch")).toEqual(["arch", "medial_arch", "lateral_arch"]);
    expect(footSurfaceSubtree("toenails")).toEqual(["toenails"]);
    expect(footSurfaceAncestors("medial_arch")).toEqual(["arch", "plantar_surface"]);
    expect(footSurfaceAncestors("plantar_surface")).toEqual([]);
    expect(footSurfaceChildren("toes")).toEqual(["toe_tops", "toe_pads", "interdigital_spaces", "toenails"]);
  });

  it("resolves a detail token, and resolves an unknown one to nothing", () => {
    expect(footSurfaceForDetail("heel_pad")).toBe("heel_pad");
    expect(footSurfaceForDetail("instep")).toBeUndefined();
    expect(footSurfaceForDetail(undefined)).toBeUndefined();
    expect(footSurfaceNode("not_a_surface")).toBeUndefined();
  });

  it("gives a bare locus its surface, but refuses to place a bare `feet`", () => {
    expect(footSurfaceForLocation("sole")).toBe("plantar_surface");
    expect(footSurfaceForLocation("heel")).toBe("heel_pad");
    expect(footSurfaceForLocation("toenails")).toBe("toenails");
    // `feet` is in the accepted set — a contact there IS a foot contact — but it
    // names no region, so nothing regional can be said about it.
    expect(footContactLocationIds.has("feet")).toBe(true);
    expect(footSurfaceForLocation("feet")).toBeUndefined();
  });

  it("keys a locus by surface, side, and digit — and by nothing else", () => {
    expect(footLocusKey(footLocus("arch", "left"))).not.toBe(footLocusKey(footLocus("arch", "right")));
    expect(footLociEqual(footLocus("arch", "left"), footLocus("arch", "left"))).toBe(true);
    expect(footLociEqual(footLocus("toe_pads", "left", "hallux"), footLocus("toe_pads", "left"))).toBe(false);
  });
});

describe("the three new registry loci are contact loci, not garment slots", () => {
  it("never enters a stored coverage set", () => {
    for (const id of ["foot_arch", "ball_of_foot", "toenails"]) {
      expect(toggleCoverage([], id), id).toEqual([]);
    }
  });

  it("still rides `expand`, so a flip-flop's sole covers the arch and the ball", () => {
    const flipFlop = expandCoverage(["sole"]);
    expect(flipFlop.has("foot_arch")).toBe(true);
    expect(flipFlop.has("ball_of_foot")).toBe(true);
    expect(flipFlop.has("toenails")).toBe(false);
  });

  it("leaves the peep-toe carve-out exactly as it was", () => {
    const peepToe = toggleCoverage(["feet"], "toes");
    expect(peepToe).toEqual(["top_of_foot", "sole", "heel"]);
    expect(toggleCoverage(peepToe, "top_of_foot")).toEqual(["sole", "heel"]);
  });
});
