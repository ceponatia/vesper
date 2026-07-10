import { describe, expect, it } from "vitest";
import { avatarImageModels, DEFAULT_AVATAR_IMAGE_MODEL } from "@/contracts";
import { veniceSceneImageModelId, veniceT2IModelId } from "./venice";

describe("veniceT2IModelId", () => {
  it("resolves every avatar-model key to a non-empty Venice model id", () => {
    // Guards the registry: a key with no id mapping (a typo, a forgotten
    // onboarding) would return undefined and silently break generation.
    for (const model of avatarImageModels) {
      const id = veniceT2IModelId(model);
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("maps qwen to the env-overridable text-to-image model and the lustify key to its uncensored id", () => {
    expect(veniceT2IModelId("qwen")).toBe("qwen-image-2");
    expect(veniceT2IModelId("lustify")).toBe("lustify-v8");
  });

  it("the shared default pick is Chroma, and the scene t2i rung resolves through it (owner ruling 2026-07-10)", () => {
    expect(DEFAULT_AVATAR_IMAGE_MODEL).toBe("chroma");
    expect(veniceSceneImageModelId()).toBe("chroma");
  });
});
