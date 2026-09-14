import { describe, expect, it } from "vitest";
import type { ImageModelProfile } from "../models/image-model-profiles";
import { IMAGE_TARGET_ASPECT } from "../models/image-models";
import { IMAGE_TASK_TARGET_ASPECTS, resolveRenderTarget } from "./render-target";

type ProfileFixture = Pick<ImageModelProfile, "controlDefaults">;

function profileWith(aspectRatio?: string): ProfileFixture {
  return { controlDefaults: { seedPolicy: "random", ...(aspectRatio === undefined ? {} : { aspectRatio }) } } as ProfileFixture;
}

describe("resolveRenderTarget", () => {
  it("answers raw when the intent explicitly asks for no shape, even over a profile's own", () => {
    const result = resolveRenderTarget({
      intentTarget: { aspectRatio: null },
      profile: profileWith("1:1"),
      task: "portrait",
    });
    expect(result).toEqual({ aspectRatio: null, source: "raw" });
  });

  it("prefers the profile's declared shape over the lane's own explicit request", () => {
    const result = resolveRenderTarget({
      intentTarget: { aspectRatio: 1 },
      profile: profileWith("3:2"),
      task: "item",
    });
    expect(result).toEqual({ aspectRatio: 3 / 2, source: "profile" });
  });

  it("falls to the lane's explicit request when the profile declares no shape", () => {
    const result = resolveRenderTarget({
      intentTarget: { aspectRatio: 1.5 },
      profile: profileWith(),
      task: "location",
    });
    expect(result).toEqual({ aspectRatio: 1.5, source: "lane" });
  });

  it("falls to the task default when neither the profile nor the lane names a shape", () => {
    const result = resolveRenderTarget({ intentTarget: undefined, profile: profileWith(), task: "item" });
    expect(result).toEqual({ aspectRatio: 1, source: "task_default" });
  });

  it("reads the fallen-through answer from the TASK's own row of the table", () => {
    // The case above falls through on `item` and lands on 1; this one falls
    // through on `chat_place` and lands on 3:2. Two different non-3:4 answers
    // out of the same branch is what proves the fallback is keyed by the
    // render's task rather than collapsed to one constant on the way out —
    // which a `??` against `IMAGE_TARGET_ASPECT` would look identical to on
    // every portrait-shaped task.
    const result = resolveRenderTarget({
      intentTarget: undefined,
      profile: profileWith(),
      task: "chat_place",
    });
    expect(result).toEqual({ aspectRatio: 3 / 2, source: "task_default" });
  });

  it("degrades an unparseable stored aspectRatio to the next precedence rather than throwing", () => {
    // Defensive only: the profile schema's own refine already refuses this at
    // save time, so a stored row should never carry it — but this resolver
    // must not assume a caller always re-validated first.
    const result = resolveRenderTarget({
      intentTarget: { aspectRatio: 1 },
      profile: { controlDefaults: { seedPolicy: "random", aspectRatio: "not-a-ratio" } } as ProfileFixture,
      task: "item",
    });
    expect(result).toEqual({ aspectRatio: 1, source: "lane" });
  });

  it("carries a closed table of default ratios for every profile task", () => {
    expect(IMAGE_TASK_TARGET_ASPECTS).toEqual({
      portrait: IMAGE_TARGET_ASPECT,
      variant: IMAGE_TARGET_ASPECT,
      scene: IMAGE_TARGET_ASPECT,
      chat_look: IMAGE_TARGET_ASPECT,
      item: 1,
      location: 3 / 2,
      chat_place: 3 / 2,
      text_repair: IMAGE_TARGET_ASPECT,
      example_transform: IMAGE_TARGET_ASPECT,
      image_set: IMAGE_TARGET_ASPECT,
    });
  });
});
