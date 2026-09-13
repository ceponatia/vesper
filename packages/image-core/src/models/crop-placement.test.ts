import { describe, expect, it } from "vitest";
import { chooseCropPlacement } from "./crop-placement";

describe("chooseCropPlacement", () => {
  it("centers a too-wide trim, whatever the task", () => {
    // 1600×800 into 3:4 (0.75): the sides go, not the top or bottom.
    const placement = chooseCropPlacement({
      task: "portrait",
      outputWidth: 1600,
      outputHeight: 800,
      targetRatio: 3 / 4,
      focal: null,
    });
    expect(placement).toEqual({
      kind: "explicit",
      gravity: "center",
      rect: { left: 500, top: 0, width: 600, height: 800 },
    });
  });

  it("anchors a too-tall trim to the top for a subject-bearing task", () => {
    // 800×1600 into 3:4: a portrait's head sits near the top of the frame.
    const placement = chooseCropPlacement({
      task: "portrait",
      outputWidth: 800,
      outputHeight: 1600,
      targetRatio: 3 / 4,
      focal: null,
    });
    expect(placement).toEqual({
      kind: "explicit",
      gravity: "top",
      rect: { left: 0, top: 0, width: 800, height: 1067 },
    });
  });

  it("centers a too-tall trim for a non-subject task", () => {
    const placement = chooseCropPlacement({
      task: "item",
      outputWidth: 800,
      outputHeight: 1600,
      targetRatio: 3 / 4,
      focal: null,
    });
    expect(placement).toEqual({
      kind: "explicit",
      gravity: "center",
      rect: { left: 0, top: 266, width: 800, height: 1067 },
    });
  });

  it("centers a too-tall trim when no task is known at all", () => {
    // A direct trial/lab caller with no profile context gets the legacy
    // centre-crop behavior exactly — no task must never read as subject-bearing.
    const placement = chooseCropPlacement({
      outputWidth: 800,
      outputHeight: 1600,
      targetRatio: 3 / 4,
      focal: null,
    });
    expect(placement.kind).toBe("explicit");
    expect(placement.kind === "explicit" && placement.gravity).toBe("center");
  });

  it("is a no-op window covering the whole image when the shape already matches", () => {
    const placement = chooseCropPlacement({
      task: "portrait",
      outputWidth: 900,
      outputHeight: 1200,
      targetRatio: 3 / 4,
      focal: null,
    });
    expect(placement).toEqual({
      kind: "explicit",
      gravity: "center",
      rect: { left: 0, top: 0, width: 900, height: 1200 },
    });
  });

  it("shifts the crop window to contain an off-centre focal box", () => {
    // A 1000×1000 square trimmed to 3:4 loses width; a marker near the right
    // edge must survive rather than be centre-cropped away.
    const placement = chooseCropPlacement({
      outputWidth: 1000,
      outputHeight: 1000,
      targetRatio: 3 / 4,
      focal: { left: 800, top: 400, width: 100, height: 100 },
    });
    expect(placement.kind).toBe("focal");
    expect(placement.rect).toEqual({ left: 250, top: 0, width: 750, height: 1000 });
    // The focal box's horizontal span, [800, 900), is fully inside the window's
    // [250, 1000).
    const rect = placement.rect;
    expect(rect.left).toBeLessThanOrEqual(800);
    expect(rect.left + rect.width).toBeGreaterThanOrEqual(900);
  });

  it("clamps a focal shift to the image bounds rather than overshooting", () => {
    // A marker flush against the left edge cannot pull the window past 0.
    const placement = chooseCropPlacement({
      outputWidth: 1000,
      outputHeight: 1000,
      targetRatio: 3 / 4,
      focal: { left: 0, top: 0, width: 50, height: 50 },
    });
    expect(placement.kind).toBe("focal");
    expect(placement.rect.left).toBe(0);
  });

  it("ignores the focal box on the untrimmed axis and centers it instead", () => {
    // The trim is horizontal (too-wide), so the vertical axis is never
    // shifted even though the focal box is off-centre vertically too.
    const placement = chooseCropPlacement({
      outputWidth: 1600,
      outputHeight: 800,
      targetRatio: 3 / 4,
      focal: { left: 1400, top: 700, width: 50, height: 50 },
    });
    expect(placement.kind).toBe("focal");
    expect(placement.rect.top).toBe(0);
  });
});
