import { describe, expect, it } from "vitest";
import { FULLY_COVERED, exposedRegions, type RegionExposure } from "../items/visibility";
import { attributeRegistry } from "../attributes";
import {
  resolveViewerParts,
  VIEWER_SKIN_ATTRIBUTE_IDS,
  viewerBodyPartById,
  viewerBodyParts,
} from "./viewer-body";

const ids = (parts: readonly { id: string }[]): string[] => parts.map((p) => p.id);
/** Nothing worn ⇒ every region bare. */
const NUDE = exposedRegions([]);
const PANTS: RegionExposure = { torso: "bare", pelvis: "covered", legs: "covered", feet: "bare" };
const SHEER: RegionExposure = { torso: "covered", pelvis: "sheer", legs: "sheer", feet: "covered" };

// The possessive-binding and frame-geometry invariant belongs to the layer that
// now writes those words: `packages/image-core`'s dialects, asserted over a
// compiled prompt. This registry decides which parts a frame may hold.
describe("the viewer-body registry", () => {
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
    expect(ids(resolveViewerParts({ proposed: ["forearms", "hands", "forearms"], exposure: NUDE, ...allowed }))).toEqual([
      "forearms",
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

/**
 * The composer has no intimate vocabulary — it runs allowIntimate:false whatever model
 * its seam picks — so `genitals` can never be PROPOSED. It has to be earned
 * deterministically (scene-pov-embodiment slice 4), and three independent conditions must
 * all hold: the shot is already looking down the viewer's body, the pelvis reads bare, and
 * the route is uncensored.
 */
describe("the derived intimate part", () => {
  const allowed = { allowIntimate: true };

  it("is earned when the shot already looks down the viewer's body and the pelvis is bare", () => {
    expect(ids(resolveViewerParts({ proposed: ["lap_thighs"], exposure: NUDE, ...allowed }))).toContain("genitals");
    expect(ids(resolveViewerParts({ proposed: ["torso"], exposure: NUDE, ...allowed }))).toContain("genitals");
  });

  // A hand on her cheek is not a view of your own crotch.
  it("is NOT earned by parts that aren't looking down", () => {
    expect(ids(resolveViewerParts({ proposed: ["hands", "forearms"], exposure: NUDE, ...allowed }))).not.toContain(
      "genitals",
    );
  });

  it("still obeys coverage and the route once derived", () => {
    expect(ids(resolveViewerParts({ proposed: ["lap_thighs"], exposure: PANTS, ...allowed }))).toEqual(["lap_thighs"]);
    expect(ids(resolveViewerParts({ proposed: ["lap_thighs"], exposure: NUDE, allowIntimate: false }))).toEqual([
      "lap_thighs",
    ]);
  });

  it("never derives from an empty proposal — no shot, no body", () => {
    expect(resolveViewerParts({ proposed: [], exposure: NUDE, ...allowed })).toEqual([]);
  });

  it("doesn't duplicate an already-present genitals", () => {
    const out = ids(resolveViewerParts({ proposed: ["torso", "genitals"], exposure: NUDE, ...allowed }));
    expect(out.filter((id) => id === "genitals")).toHaveLength(1);
  });
});

describe("per-part attribute ids", () => {
  it("names only what each part can show, so a hands shot doesn't state leg hair", () => {
    expect(viewerBodyPartById("hands")?.attributeIds).not.toContain("legs.hair");
    expect(viewerBodyPartById("legs_feet")?.attributeIds).toContain("legs.hair");
    expect(viewerBodyPartById("forearms")?.attributeIds).toContain("arms.hair");
  });

  it("every listed id is real — a typo'd id would silently describe nothing", () => {
    const known = new Set(attributeRegistry.definitions.map((d) => d.id as string));
    for (const part of viewerBodyParts) {
      for (const id of part.attributeIds) expect(known).toContain(id);
    }
    for (const id of VIEWER_SKIN_ATTRIBUTE_IDS) expect(known).toContain(id);
  });
});
