import { describe, expect, it } from "vitest";
import { avatarImageModels, DEFAULT_AVATAR_IMAGE_MODEL } from "@/contracts";
import { unwrapVeniceImage, veniceSceneImageModelId, veniceT2IModelId } from "./venice";

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

describe("unwrapVeniceImage", () => {
  it("returns the bytes of a successful result", () => {
    const image = Buffer.from("webp-bytes");
    expect(unwrapVeniceImage({ ok: true, image }, "venice generate returned no image")).toBe(image);
  });

  it("throws the provider's failure text — the message the caller writes onto the failed row", () => {
    expect(() => unwrapVeniceImage({ ok: false, error: "venice 429: rate limited" }, "venice edit failed")).toThrow(
      "venice 429: rate limited",
    );
  });

  it("falls back to the caller's message when the failure carries no text", () => {
    expect(() => unwrapVeniceImage({ ok: false }, "venice generate failed")).toThrow("venice generate failed");
  });

  it("falls back on an EMPTY error string too, so the thrown Error is never blank", () => {
    // `||`, not `??`: an empty message would leave the failed row unexplained.
    expect(() => unwrapVeniceImage({ ok: false, error: "" }, "venice edit failed")).toThrow("venice edit failed");
  });

  it("treats an ok result with no image as a failure", () => {
    expect(() => unwrapVeniceImage({ ok: true }, "venice generate returned no image")).toThrow(
      "venice generate returned no image",
    );
  });
});
