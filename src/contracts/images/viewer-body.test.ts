import { describe, expect, it } from "vitest";
import { FULLY_COVERED, exposedRegions, type RegionExposure } from "../items/visibility";
import { resolveViewerParts, viewerBodyPartById, viewerBodyParts } from "./viewer-body";

const ids = (parts: readonly { id: string }[]): string[] => parts.map((p) => p.id);
/** Nothing worn ⇒ every region bare. */
const NUDE = exposedRegions([]);
const PANTS: RegionExposure = { torso: "bare", pelvis: "covered", legs: "covered", feet: "bare" };
const SHEER: RegionExposure = { torso: "covered", pelvis: "sheer", legs: "sheer", feet: "covered" };

describe("the viewer-body registry", () => {
  it("every part is possessive-bound and cropped — never a bare noun a model could stand up", () => {
    for (const part of viewerBodyParts) {
      expect(part.framing).toContain("the viewer's own");
      // Frame geometry is what stops a limb becoming a subject; every phrase carries some.
      expect(part.framing).toMatch(/foreshorten|cropped|frame edge|lower edge|bottom of the frame|toward the lens|from the lens/);
    }
  });

  it("gates anatomy and nothing else — a clothed torso or lap is a fine POV element", () => {
    expect(viewerBodyPartById("genitals")?.requiresBare).toBe("pelvis");
    expect(viewerBodyPartById("genitals")?.intimate).toBe(true);
    for (const id of ["hands", "forearms", "lap_thighs", "legs_feet", "torso"]) {
      expect(viewerBodyPartById(id)?.requiresBare).toBeNull();
      expect(viewerBodyPartById(id)?.intimate).toBe(false);
    }
  });
});

describe("resolveViewerParts (the composer proposes, coverage disposes)", () => {
  const allowed = { allowIntimate: true };

  // THE table test the whole gate exists for: pants on ⇒ genitals structurally gone.
  it("drops genitals when the pelvis is covered, however the route is configured", () => {
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: PANTS, ...allowed }))).toEqual([]);
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: FULLY_COVERED, ...allowed }))).toEqual([]);
  });

  it("permits genitals only when the pelvis reads bare or sheer AND the route allows intimate", () => {
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: NUDE, ...allowed }))).toEqual(["genitals"]);
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: SHEER, ...allowed }))).toEqual(["genitals"]);
    // Bare, but the moderated text-to-image fallback: still dropped.
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: NUDE, allowIntimate: false }))).toEqual([]);
    expect(ids(resolveViewerParts({ proposed: ["genitals"], exposure: NUDE }))).toEqual([]);
  });

  // Default-shut, the same rule chatSceneIsIntimate follows: no coverage established ⇒
  // nothing earned. A missing exposure must never read as permission.
  it("treats missing coverage as covered", () => {
    expect(ids(resolveViewerParts({ proposed: ["genitals"], ...allowed }))).toEqual([]);
  });

  it("lets ungated parts through dressed — pants don't hide your own hands", () => {
    expect(ids(resolveViewerParts({ proposed: ["hands", "forearms"], exposure: FULLY_COVERED }))).toEqual([
      "hands",
      "forearms",
    ]);
  });

  it("drops ids the composer invented", () => {
    expect(ids(resolveViewerParts({ proposed: ["hands", "elbows", "wings"], exposure: NUDE, ...allowed }))).toEqual(["hands"]);
  });

  it("preserves order and collapses duplicates so the phrasing stays stable", () => {
    expect(ids(resolveViewerParts({ proposed: ["torso", "hands", "torso"], exposure: NUDE, ...allowed }))).toEqual([
      "torso",
      "hands",
    ]);
  });

  it("filters a mixed proposal down to exactly what the state permits", () => {
    // Topless but trousered, uncensored route: torso yes, genitals no.
    expect(ids(resolveViewerParts({ proposed: ["torso", "genitals", "hands"], exposure: PANTS, ...allowed }))).toEqual([
      "torso",
      "hands",
    ]);
  });

  it("is empty for an empty proposal — the default path", () => {
    expect(resolveViewerParts({ proposed: [], exposure: NUDE, ...allowed })).toEqual([]);
  });
});
