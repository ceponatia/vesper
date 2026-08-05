import { describe, expect, it } from "vitest";
import type { SceneVisualReference } from "@/contracts";
import { apiError } from "@/server/test-support";
import { classifyImageFailure, IMAGE_PROVIDERS, routeSceneProviders } from "./image-providers";

const charRef = (overrides: Partial<SceneVisualReference> = {}): SceneVisualReference => ({
  kind: "character",
  allowForIntimate: true,
  ...overrides,
});

describe("routeSceneProviders", () => {
  it("demo mode routes to the monogram only", () => {
    expect(routeSceneProviders({ references: [], demo: true })).toEqual(["demo"]);
  });

  it("defaults to a fail-visible Venice edit when a reference exists", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" })];
    expect(routeSceneProviders({ references: refs, demo: false })).toEqual(["venice_edit"]);
  });

  it("routes an explicit Replicate selection to Replicate Edit only", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" })];
    expect(routeSceneProviders({ references: refs, demo: false, provider: "replicate" })).toEqual(["replicate_edit"]);
  });

  it("uses the selected provider's text-to-image model when no reference exists", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira" })];
    expect(routeSceneProviders({ references: refs, demo: false })).toEqual(["venice_generate"]);
    expect(routeSceneProviders({ references: refs, demo: false, provider: "replicate" })).toEqual(["replicate_generate"]);
  });

  it("prepends each provider's multi-edit rung only when at least two images exist", () => {
    const twoRefs = [
      charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" }),
      charRef({ entityId: "c2", name: "Sayed", imageId: "img2", source: "generated" }),
    ];
    expect(routeSceneProviders({ references: twoRefs, demo: false, mode: "multi" })).toEqual([
      "venice_multi_edit",
      "venice_edit",
    ]);
    expect(routeSceneProviders({ references: twoRefs, demo: false, mode: "multi", provider: "replicate" })).toEqual([
      "replicate_multi_edit",
      "replicate_edit",
    ]);

    const oneRef = [twoRefs[0]!];
    expect(routeSceneProviders({ references: oneRef, demo: false, mode: "multi", provider: "replicate" })).toEqual([
      "replicate_edit",
    ]);
  });

  it("demo mode ignores provider and reference mode", () => {
    expect(routeSceneProviders({ references: [], demo: true, mode: "multi", provider: "replicate" })).toEqual(["demo"]);
  });

  it("the registry never allows uploaded real people on an NSFW path", () => {
    for (const caps of Object.values(IMAGE_PROVIDERS)) {
      expect(caps.supportsUploadedRealPeopleInNsfw).toBe(false);
    }
  });
});

describe("classifyImageFailure", () => {
  it("classifies upstream moderation as a content rejection", () => {
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        metadata: { raw: JSON.stringify({ details: { "Moderation Reasons": ["Sexual Content"] } }) },
      },
    });
    expect(classifyImageFailure(apiError(body))).toBe("content_rejection");
  });

  it("classifies provider content-policy strings as content rejections", () => {
    expect(classifyImageFailure("venice 400: request blocked by content policy")).toBe("content_rejection");
    expect(classifyImageFailure("replicate failed: NSFW content flagged")).toBe("content_rejection");
  });

  it("classifies timeouts and 5xx/429 as transient", () => {
    expect(classifyImageFailure("fetch failed: ETIMEDOUT")).toBe("transient");
    expect(classifyImageFailure("replicate 503: service unavailable")).toBe("transient");
    expect(classifyImageFailure("Too Many Requests")).toBe("transient");
  });

  it("treats missing keys and unknown failures as other", () => {
    expect(classifyImageFailure("VENICE_API_KEY not configured")).toBe("other");
    expect(classifyImageFailure("REPLICATE_API_TOKEN not configured")).toBe("other");
    expect(classifyImageFailure("replicate returned no image")).toBe("other");
  });
});
