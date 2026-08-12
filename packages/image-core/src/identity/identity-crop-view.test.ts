import { describe, expect, it } from "vitest";
import {
  clampSelection,
  cropPreviewLayout,
  defaultSelection,
  displayScale,
  fitDisplayBox,
  minimumSelectionSide,
  moveSelection,
  resizeSelection,
  selectionFromCrop,
  selectionToNormalized,
  toDisplayRect,
  toSourceSpace,
  type IdentitySquareSelection,
} from "./identity-crop-view";
import { heuristicCropV1, normalizedCropToSourcePixels } from "./identity-pack-crop";
import { IDENTITY_CROP_POLICY_V1 } from "./identity-pack-policy";

/**
 * The editor's contract with the server: whatever the user frames must survive the
 * trip through normalized coordinates as the SAME source rectangle, and must never
 * be a rectangle `validateIdentityCrop` would refuse for shape or bounds. These
 * tests are that contract — a failure here means the editor can offer a save the
 * server will reject.
 */

const PORTRAIT = { width: 768, height: 1024 };

describe("display mapping", () => {
  it("contain-fits the source into the available box", () => {
    expect(fitDisplayBox(PORTRAIT, { width: 400, height: 400 })).toEqual({ width: 300, height: 400 });
    expect(fitDisplayBox({ width: 1600, height: 400 }, { width: 400, height: 400 })).toEqual({
      width: 400,
      height: 100,
    });
  });

  it("degrades to an empty box rather than dividing by a missing dimension", () => {
    expect(fitDisplayBox({ width: 0, height: 0 }, { width: 400, height: 400 })).toEqual({ width: 0, height: 0 });
    expect(displayScale({ width: 0, height: 0 }, { width: 400, height: 400 })).toBe(1);
    expect(toSourceSpace({ x: 10, y: 10 }, 0)).toEqual({ x: 0, y: 0 });
  });

  it("round-trips a point between display and source space", () => {
    const display = fitDisplayBox(PORTRAIT, { width: 300, height: 600 });
    const scale = displayScale(PORTRAIT, display);
    expect(scale).toBeCloseTo(300 / 768);
    expect(toSourceSpace({ x: 150, y: 200 }, scale)).toEqual({ x: 384, y: 512 });
  });

  it("places the selection in display pixels", () => {
    expect(toDisplayRect({ left: 100, top: 200, side: 400 }, 0.5)).toEqual({ left: 50, top: 100, size: 200 });
  });
});

describe("selection defaults", () => {
  it("opens on the rectangle the automatic heuristic would have chosen", () => {
    const heuristic = heuristicCropV1(PORTRAIT);
    expect(heuristic).not.toBeNull();
    expect(defaultSelection(PORTRAIT)).toEqual({ left: heuristic?.left, top: heuristic?.top, side: heuristic?.width });
  });

  it("collapses a non-square stored crop to its shorter side instead of refusing it", () => {
    expect(selectionFromCrop({ left: 40, top: 60, width: 500, height: 400 }, PORTRAIT)).toEqual({
      left: 40,
      top: 60,
      side: 400,
    });
  });

  it("falls back to the default when there is no stored crop", () => {
    expect(selectionFromCrop(null, PORTRAIT)).toEqual(defaultSelection(PORTRAIT));
  });
});

describe("clamping", () => {
  it("rounds to integer source pixels", () => {
    expect(clampSelection({ left: 10.4, top: 20.6, side: 300.5 }, PORTRAIT)).toEqual({
      left: 10,
      top: 21,
      side: 301,
    });
  });

  it("keeps the square inside the source", () => {
    expect(clampSelection({ left: 700, top: 900, side: 400 }, PORTRAIT)).toEqual({
      left: 368,
      top: 624,
      side: 400,
    });
    expect(clampSelection({ left: -50, top: -80, side: 400 }, PORTRAIT)).toEqual({ left: 0, top: 0, side: 400 });
  });

  it("enforces the policy minimum side and the source ceiling", () => {
    expect(minimumSelectionSide(PORTRAIT)).toBe(IDENTITY_CROP_POLICY_V1.minimumOutputSidePx);
    expect(clampSelection({ left: 0, top: 0, side: 10 }, PORTRAIT).side).toBe(256);
    expect(clampSelection({ left: 0, top: 0, side: 5000 }, PORTRAIT).side).toBe(768);
  });

  it("floors the minimum at what a source smaller than the policy minimum can give", () => {
    const tiny = { width: 200, height: 260 };
    expect(minimumSelectionSide(tiny)).toBe(200);
    expect(clampSelection({ left: 0, top: 0, side: 10 }, tiny)).toEqual({ left: 0, top: 0, side: 200 });
  });
});

describe("drag", () => {
  it("translates by a source-space delta", () => {
    expect(moveSelection({ left: 100, top: 100, side: 400 }, { x: 25, y: -40 }, PORTRAIT)).toEqual({
      left: 125,
      top: 60,
      side: 400,
    });
  });

  it("stops at every edge instead of leaving the source", () => {
    const selection: IdentitySquareSelection = { left: 100, top: 100, side: 400 };
    expect(moveSelection(selection, { x: 9999, y: 9999 }, PORTRAIT)).toEqual({ left: 368, top: 624, side: 400 });
    expect(moveSelection(selection, { x: -9999, y: -9999 }, PORTRAIT)).toEqual({ left: 0, top: 0, side: 400 });
  });
});

describe("corner resize", () => {
  const selection: IdentitySquareSelection = { left: 200, top: 300, side: 400 };

  it("keeps the opposite corner fixed and the rectangle square", () => {
    const resized = resizeSelection(selection, "se", { x: 700, y: 620 }, PORTRAIT);
    // The anchor is the north-west corner; the pointer travelled further on x (500)
    // than on y (320), so the side follows x.
    expect(resized).toEqual({ left: 200, top: 300, side: 500 });
  });

  it("grows up and left from a north-west handle", () => {
    // Anchor is the south-east corner (600, 700); the pointer is 500 left of it and
    // 300 above, so the side is 500 and the square hangs off that fixed corner.
    const resized = resizeSelection(selection, "nw", { x: 100, y: 400 }, PORTRAIT);
    expect(resized).toEqual({ left: 100, top: 200, side: 500 });
  });

  it("grows the other two corners from their own anchors", () => {
    // ne: anchor south-west (200, 700).
    expect(resizeSelection(selection, "ne", { x: 500, y: 250 }, PORTRAIT)).toEqual({
      left: 200,
      top: 250,
      side: 450,
    });
    // sw: anchor north-east (600, 300).
    expect(resizeSelection(selection, "sw", { x: 300, y: 800 }, PORTRAIT)).toEqual({
      left: 100,
      top: 300,
      side: 500,
    });
  });

  it("never shrinks below the minimum side", () => {
    const resized = resizeSelection(selection, "se", { x: 205, y: 305 }, PORTRAIT);
    expect(resized.side).toBe(256);
    expect(resized).toEqual({ left: 200, top: 300, side: 256 });
  });

  it("caps growth at the room between the anchor and the source edge", () => {
    // Anchor (200, 300) leaves 568 across and 724 down; the pointer asks for far more.
    const resized = resizeSelection(selection, "se", { x: 5000, y: 5000 }, PORTRAIT);
    expect(resized).toEqual({ left: 200, top: 300, side: 568 });
  });

  it("slides back inside when the anchor is too close to an edge to hold the minimum", () => {
    // Anchor (740, 300) has only 28px of room, well under the 256 minimum: the side
    // stays legal and the square moves rather than becoming unsavable.
    const cornered: IdentitySquareSelection = { left: 740, top: 300, side: 28 };
    const resized = resizeSelection(cornered, "se", { x: 760, y: 320 }, PORTRAIT);
    expect(resized).toEqual({ left: 512, top: 300, side: 256 });
  });
});

describe("normalized round trip", () => {
  it("resolves back to the exact source rectangle the user framed", () => {
    for (const selection of [
      { left: 0, top: 0, side: 768 },
      { left: 137, top: 291, side: 401 },
      { left: 368, top: 624, side: 400 },
    ]) {
      const normalized = selectionToNormalized(selection, PORTRAIT);
      expect(normalizedCropToSourcePixels(normalized, PORTRAIT)).toEqual({
        left: selection.left,
        top: selection.top,
        width: selection.side,
        height: selection.side,
      });
    }
  });

  it("stays inside the unit square", () => {
    const normalized = selectionToNormalized({ left: 0, top: 624, side: 400 }, PORTRAIT);
    expect(normalized.left).toBe(0);
    expect(normalized.top).toBeCloseTo(624 / 1024);
    expect(normalized.width).toBeCloseTo(400 / 768);
    expect(normalized.height).toBeCloseTo(400 / 1024);
  });

  it("degrades to zeros when the source has no dimensions", () => {
    expect(selectionToNormalized({ left: 10, top: 10, side: 100 }, { width: 0, height: 0 })).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("preview layout", () => {
  it("scales the source so the preview box shows exactly the selection", () => {
    expect(cropPreviewLayout({ left: 100, top: 200, side: 400 }, PORTRAIT, 200)).toEqual({
      width: 384,
      height: 512,
      left: -50,
      top: -100,
    });
  });

  it("renders nothing rather than dividing by a zero-sided selection", () => {
    expect(cropPreviewLayout({ left: 0, top: 0, side: 0 }, PORTRAIT, 200)).toEqual({
      width: 0,
      height: 0,
      left: 0,
      top: 0,
    });
  });
});
