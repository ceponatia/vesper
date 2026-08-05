import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR_IMAGE_MODEL, veniceAvatarImageModels } from "@/contracts";
import { unwrapVeniceImage, veniceSceneImageModelId, veniceT2IModelId } from "./venice";

describe("veniceT2IModelId", () => {
  it("resolves every Venice avatar key to a non-empty Venice model id", () => {
    for (const model of veniceAvatarImageModels) {
      const id = veniceT2IModelId(model);
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it("maps qwen and lustify to their Venice ids", () => {
    expect(veniceT2IModelId("qwen")).toBe("qwen-image-2");
    expect(veniceT2IModelId("lustify")).toBe("lustify-v8");
  });

  it("keeps Chroma as the shared default and scene fallback", () => {
    expect(DEFAULT_AVATAR_IMAGE_MODEL).toBe("chroma");
    expect(veniceSceneImageModelId()).toBe("chroma");
  });
});

describe("unwrapVeniceImage", () => {
  it("returns successful bytes", () => {
    const image = Buffer.from("webp-bytes");
    expect(unwrapVeniceImage({ ok: true, image }, "venice generate returned no image")).toBe(image);
  });

  it("throws the provider failure text", () => {
    expect(() => unwrapVeniceImage({ ok: false, error: "venice 429: rate limited" }, "venice edit failed")).toThrow(
      "venice 429: rate limited",
    );
  });

  it("uses the caller fallback for missing or empty error text", () => {
    expect(() => unwrapVeniceImage({ ok: false }, "venice generate failed")).toThrow("venice generate failed");
    expect(() => unwrapVeniceImage({ ok: false, error: "" }, "venice edit failed")).toThrow("venice edit failed");
  });

  it("treats an ok result without image bytes as failure", () => {
    expect(() => unwrapVeniceImage({ ok: true }, "venice generate returned no image")).toThrow(
      "venice generate returned no image",
    );
  });
});
