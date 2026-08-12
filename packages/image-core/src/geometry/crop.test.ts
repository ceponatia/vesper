import { describe, expect, it } from "vitest";
import { canvasRect, centeredOffset, clampOffset, coverScale, displaySize, MIN_ZOOM } from "./crop";

const FRAME = { fw: 300, fh: 400 }; // 3:4

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

  // Zoom-out letterbox (owner request 2026-07-29): once the image is smaller than
  // the frame on an axis, the clamp flips — pannable within the frame, never off it.
  it("keeps a zoomed-out image fully inside the frame", () => {
    const image = { nw: 600, nh: 800 }; // 3:4 at half zoom → half the frame
    const { width, height } = displaySize(FRAME, image, 0.5);
    expect(width).toBeCloseTo(FRAME.fw / 2);
    const right = clampOffset(FRAME, width, height, { x: 9999, y: 9999 });
    expect(right.x).toBeCloseTo(FRAME.fw - width); // right edge stops at the frame edge
    expect(right.y).toBeCloseTo(FRAME.fh - height);
    expect(clampOffset(FRAME, width, height, { x: -9999, y: -9999 })).toEqual({ x: 0, y: 0 });
  });

  it("MIN_ZOOM sits below cover so zooming out is possible at all", () => {
    expect(MIN_ZOOM).toBeLessThan(1);
    expect(MIN_ZOOM).toBeGreaterThan(0);
  });
});

describe("centeredOffset + canvasRect", () => {
  const OUT = { w: 768, h: 1024 };

  it("a centered 3:4 image at zoom 1 exactly fills the output canvas", () => {
    const image = { nw: 600, nh: 800 };
    const { width, height } = displaySize(FRAME, image, 1);
    const offset = centeredOffset(FRAME, width, height);
    const rect = canvasRect(FRAME, width, height, offset, OUT.w, OUT.h);
    expect(rect.dx).toBeCloseTo(0);
    expect(rect.dy).toBeCloseTo(0);
    expect(rect.dw).toBeCloseTo(OUT.w);
    expect(rect.dh).toBeCloseTo(OUT.h);
  });

  it("a centered landscape image at cover overflows the canvas symmetrically (the old crop)", () => {
    const image = { nw: 1000, nh: 500 }; // 2:1 — cover scales by height
    const { width, height } = displaySize(FRAME, image, 1);
    const offset = centeredOffset(FRAME, width, height);
    const rect = canvasRect(FRAME, width, height, offset, OUT.w, OUT.h);
    expect(rect.dh).toBeCloseTo(OUT.h); // full height fills
    expect(rect.dw).toBeGreaterThan(OUT.w); // width overflows → canvas clips it
    expect(rect.dx).toBeCloseTo((OUT.w - rect.dw) / 2); // centered overflow
  });

  it("a zoomed-out image letterboxes inside the canvas — backdrop shows around it", () => {
    const image = { nw: 600, nh: 800 };
    const { width, height } = displaySize(FRAME, image, 0.5);
    const offset = centeredOffset(FRAME, width, height);
    const rect = canvasRect(FRAME, width, height, offset, OUT.w, OUT.h);
    expect(rect.dw).toBeCloseTo(OUT.w / 2);
    expect(rect.dh).toBeCloseTo(OUT.h / 2);
    expect(rect.dx).toBeCloseTo(OUT.w / 4); // centered with margins on every side
    expect(rect.dy).toBeCloseTo(OUT.h / 4);
  });
});
