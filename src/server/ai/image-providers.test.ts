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

  it("single mode: a reference image anchors the uncensored edit ONLY — no text-to-image fallback (fail-visible)", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" })];
    expect(routeSceneProviders({ references: refs, demo: false })).toEqual(["venice_edit"]);
  });

  it("featured-but-textual characters (no image) skip the edit provider — text-to-image only", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira" })];
    expect(routeSceneProviders({ references: refs, demo: false })).toEqual(["venice_generate"]);
  });

  it("no references at all still has a valid last rung", () => {
    expect(routeSceneProviders({ references: [], demo: false })).toEqual(["venice_generate"]);
  });

  it("multi mode with ≥2 reference images prepends the Venice multi-edit rung — still no text-to-image", () => {
    const refs = [
      charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" }),
      charRef({ entityId: "c2", name: "Sayed", imageId: "img2", source: "generated" }),
    ];
    expect(routeSceneProviders({ references: refs, demo: false, mode: "multi" })).toEqual(["venice_multi_edit", "venice_edit"]);
  });

  it("multi mode with only ONE reference image degrades to the single-edit rung (multi needs ≥2)", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira", imageId: "img1", source: "generated" })];
    expect(routeSceneProviders({ references: refs, demo: false, mode: "multi" })).toEqual(["venice_edit"]);
  });

  it("multi mode with no reference images falls to text-to-image only", () => {
    const refs = [charRef({ entityId: "c1", name: "Mira" })];
    expect(routeSceneProviders({ references: refs, demo: false, mode: "multi" })).toEqual(["venice_generate"]);
  });

  it("demo mode ignores the reference mode — only the monogram runs", () => {
    expect(routeSceneProviders({ references: [], demo: true, mode: "multi" })).toEqual(["demo"]);
  });

  it("the registry never allows uploaded real people on an NSFW path", () => {
    for (const caps of Object.values(IMAGE_PROVIDERS)) {
      expect(caps.supportsUploadedRealPeopleInNsfw).toBe(false);
    }
  });
});

describe("classifyImageFailure", () => {
  it("classifies upstream moderation (recovered from a 200-after-stream body) as a content rejection", () => {
    const body = JSON.stringify({
      error: {
        message: "Provider returned error",
        metadata: { raw: JSON.stringify({ details: { "Moderation Reasons": ["Sexual Content"] } }) },
      },
    });
    expect(classifyImageFailure(apiError(body))).toBe("content_rejection");
  });

  it("classifies a Venice safe-mode / NSFW rejection string as a content rejection (no retry)", () => {
    expect(classifyImageFailure("venice 400: request blocked by content policy")).toBe("content_rejection");
  });

  it("classifies timeouts and 5xx/429 as transient (retryable)", () => {
    expect(classifyImageFailure("fetch failed: ETIMEDOUT")).toBe("transient");
    expect(classifyImageFailure("venice 503: service unavailable")).toBe("transient");
    expect(classifyImageFailure("Too Many Requests")).toBe("transient");
  });

  it("treats a missing-key / unknown failure as other (no retry, fall down the ladder)", () => {
    expect(classifyImageFailure("VENICE_API_KEY not configured")).toBe("other");
    expect(classifyImageFailure("venice returned no image")).toBe("other");
  });
});
