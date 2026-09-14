import { describe, expect, it } from "vitest";
import {
  advisoryReviewKey,
  appendRetryParam,
  lightboxFailureMessage,
  lightboxStateForView,
  updateLightboxImageStatus,
  type LightboxView,
} from "./image-lightbox-state";

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

  it("advisoryReviewKey never collides across images sharing a code (#249 Codex round finding A)", () => {
    expect(advisoryReviewKey("reference-1", "blank_output")).not.toBe(advisoryReviewKey("reference-2", "blank_output"));
    expect(advisoryReviewKey("reference-1", "blank_output")).toBe(advisoryReviewKey("reference-1", "blank_output"));
  });
});

describe("appendRetryParam", () => {
  it("returns the url unchanged for the initial (zero) attempt", () => {
    expect(appendRetryParam("/api/images/abc", 0)).toBe("/api/images/abc");
  });

  it("starts a query string for a url with none", () => {
    expect(appendRetryParam("/api/images/abc", 1)).toBe("/api/images/abc?retry=1");
  });

  it("extends an existing query string instead of starting a second one", () => {
    expect(appendRetryParam("/api/admin/self/files/preview?path=a%2Fb.mp4", 2)).toBe(
      "/api/admin/self/files/preview?path=a%2Fb.mp4&retry=2",
    );
  });
});

describe("lightboxFailureMessage", () => {
  it("keeps the pre-existing image wording", () => {
    expect(lightboxFailureMessage("image")).toBe("This image could not be loaded.");
  });

  it("says video and audio cannot be played, rather than reusing the image wording", () => {
    expect(lightboxFailureMessage("video")).toBe("This video cannot be played in this browser.");
    expect(lightboxFailureMessage("audio")).toBe("This audio cannot be played in this browser.");
  });
});
