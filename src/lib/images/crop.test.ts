import { describe, expect, it } from "vitest";
import {
  AVATAR_ASPECT_RATIO,
  aspectMatches,
  centeredOffset,
  clampOffset,
  coverScale,
  displaySize,
  sourceRect,
} from "./crop";

const FRAME = { fw: 300, fh: 400 }; // 3:4

describe("aspectMatches", () => {
  it("accepts a 3:4 image and rejects others", () => {
    expect(aspectMatches({ nw: 1500, nh: 2000 })).toBe(true);
    expect(aspectMatches({ nw: 768, nh: 1024 })).toBe(true);
    expect(aspectMatches({ nw: 1000, nh: 1000 })).toBe(false); // square
    expect(aspectMatches({ nw: 1920, nh: 1080 })).toBe(false); // landscape
  });

  it("guards against degenerate sizes", () => {
    expect(aspectMatches({ nw: 0, nh: 0 })).toBe(false);
  });
});

describe("coverScale / displaySize", () => {
  it("a wide image scales by height so it covers the frame", () => {
    const image = { nw: 800, nh: 400 }; // wider than 3:4
    const scale = coverScale(FRAME, image);
    expect(scale).toBe(1); // 400/400 limits; 300/800 would leave gaps
    const { width, height } = displaySize(FRAME, image, 1);
    expect(width).toBeGreaterThanOrEqual(FRAME.fw);
    expect(height).toBe(FRAME.fh);
  });

  it("zoom enlarges past cover", () => {
    const image = { nw: 600, nh: 800 }; // already 3:4
    const base = displaySize(FRAME, image, 1);
    const zoomed = displaySize(FRAME, image, 2);
    expect(zoomed.width).toBeCloseTo(base.width * 2);
    expect(zoomed.height).toBeCloseTo(base.height * 2);
  });
});

describe("clampOffset", () => {
  it("keeps the frame covered — no gaps past the edges", () => {
    const image = { nw: 900, nh: 600 }; // landscape; tall cover ⇒ wide overflow
    const { width, height } = displaySize(FRAME, image, 1);
    // Dragging far right is clamped to 0 (left edge can't enter the frame).
    expect(clampOffset(FRAME, width, height, { x: 999, y: 999 })).toEqual({ x: 0, y: 0 });
    // Dragging far left is clamped to the right edge meeting the frame.
    const left = clampOffset(FRAME, width, height, { x: -9999, y: -9999 });
    expect(left.x).toBeCloseTo(FRAME.fw - width);
    expect(left.y).toBeCloseTo(FRAME.fh - height);
  });
});

describe("centeredOffset + sourceRect", () => {
  it("a centered 3:4 image maps to the whole source at zoom 1", () => {
    const image = { nw: 600, nh: 800 };
    const { width, height } = displaySize(FRAME, image, 1);
    const offset = centeredOffset(FRAME, width, height);
    const rect = sourceRect(FRAME, image, 1, offset);
    expect(rect.sx).toBeCloseTo(0);
    expect(rect.sy).toBeCloseTo(0);
    expect(rect.sw).toBeCloseTo(image.nw);
    expect(rect.sh).toBeCloseTo(image.nh);
  });

  it("a centered landscape image crops symmetrically to a 3:4 slice", () => {
    const image = { nw: 1000, nh: 500 }; // 2:1
    const { width, height } = displaySize(FRAME, image, 1);
    const offset = centeredOffset(FRAME, width, height);
    const rect = sourceRect(FRAME, image, 1, offset);
    expect(rect.sh).toBeCloseTo(image.nh); // full height kept
    expect(rect.sw / rect.sh).toBeCloseTo(AVATAR_ASPECT_RATIO); // 3:4 slice
    expect(rect.sx).toBeCloseTo((image.nw - rect.sw) / 2); // centered horizontally
  });
});
