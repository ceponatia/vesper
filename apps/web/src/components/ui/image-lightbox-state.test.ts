import { describe, expect, it } from "vitest";
import { lightboxStateForView, updateLightboxImageStatus, type LightboxView } from "./image-lightbox-state";

const first: LightboxView = { viewKey: "front:attempt-1", imageId: "reference-1", comparisonImageId: "portrait", visible: true };

describe("lightbox view state", () => {
  it("returns to the reference and requires a fresh load after navigation, including returning to the first view", () => {
    const compared = { ...updateLightboxImageStatus(lightboxStateForView(null, first), first, "loaded"), showComparison: true };
    const next = lightboxStateForView(compared, { ...first, viewKey: "back:attempt-2", imageId: "reference-2" });
    expect(next).toMatchObject({ showComparison: false, imageStatus: "loading" });
    expect(lightboxStateForView(next, first)).toMatchObject({ showComparison: false, imageStatus: "loading" });
    expect(lightboxStateForView(compared, first)).toBe(compared);
  });

  it.each([
    { ...first, viewKey: "front:attempt-2" },
    { ...first, comparisonImageId: "new-portrait" },
    { ...first, visible: false },
  ])("resets comparison for a changed attempt, accepted portrait or open state: %j", (view) => {
    const compared = { ...lightboxStateForView(null, first), showComparison: true };
    expect(lightboxStateForView(compared, view).showComparison).toBe(false);
  });

  it("ignores old-image callbacks and revokes readiness on failure or retry", () => {
    const second = { ...first, viewKey: "back:attempt-2", imageId: "reference-2" };
    const waiting = lightboxStateForView(null, second);
    expect(updateLightboxImageStatus(waiting, first, "loaded")).toBe(waiting);
    const loaded = updateLightboxImageStatus(waiting, second, "loaded");
    expect(loaded.imageStatus).toBe("loaded");
    const failed = updateLightboxImageStatus(loaded, second, "failed");
    expect(failed.imageStatus).toBe("failed");
    expect(updateLightboxImageStatus(failed, second, "loading").imageStatus).toBe("loading");
  });

  it("cannot mark an empty or closed view ready", () => {
    for (const view of [{ ...first, imageId: null }, { ...first, visible: false }]) {
      const state = lightboxStateForView(null, view);
      expect(updateLightboxImageStatus(state, view, "loaded")).toBe(state);
    }
  });
});
