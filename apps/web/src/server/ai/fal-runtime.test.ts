import { afterEach, describe, expect, it, vi } from "vitest";
import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import {
  FAL_QWEN3_EDIT_SLUG,
  FAL_QWEN3_TEXT_SLUG,
  falQwen3Payload,
  qwen3ImageSize,
  runFalQwen3ImageModel,
  type FalPreparedReference,
} from "./fal-runtime";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function model(slug: string): ImageModel {
  return imageModelSchema.parse({
    id: slug === FAL_QWEN3_EDIT_SLUG ? "fal-qwen3-edit" : "fal-qwen3-text",
    slug,
    label: slug,
    canGenerate: slug === FAL_QWEN3_TEXT_SLUG,
    canEdit: slug === FAL_QWEN3_EDIT_SLUG,
    extraInput: {
      enable_safety_checker: false,
      enable_prompt_expansion: false,
      num_images: 1,
      output_format: "png",
    },
  });
}

const ref = (name: string): FalPreparedReference => ({
  bytes: Buffer.from(name),
  mediaType: "image/webp",
});

describe("fal Qwen Image 3 payload", () => {
  it("sends the reviewed safety/prompt-expansion posture and defaults the tier to 1K", () => {
    expect(falQwen3Payload(model(FAL_QWEN3_TEXT_SLUG), { prompt: "a portrait", aspect: "3:4" })).toMatchObject({
      prompt: "a portrait",
      enable_safety_checker: false,
      enable_prompt_expansion: false,
      num_images: 1,
      output_format: "png",
      image_size: { width: 768, height: 1024 },
    });
  });

  it("maps the normalized 2K tier plus aspect to fal custom dimensions without leaking the tier string", () => {
    const payload = falQwen3Payload(model(FAL_QWEN3_TEXT_SLUG), {
      prompt: "a portrait",
      aspect: "3:4",
      controlInput: { image_size: "2K", seed: 42 },
    });
    expect(payload["image_size"]).toEqual({ width: 1536, height: 2048 });
    expect(payload["seed"]).toBe(42);
  });

  it("keeps one to three edit references ordered as data URLs", () => {
    const payload = falQwen3Payload(model(FAL_QWEN3_EDIT_SLUG), {
      prompt: "change the jacket",
      aspect: "1:1",
      references: [ref("first"), ref("second"), ref("third")],
    });
    expect(payload["image_urls"]).toEqual([
      `data:image/webp;base64,${Buffer.from("first").toString("base64")}`,
      `data:image/webp;base64,${Buffer.from("second").toString("base64")}`,
      `data:image/webp;base64,${Buffer.from("third").toString("base64")}`,
    ]);
    expect(payload["image_size"]).toEqual({ width: 1024, height: 1024 });
  });

  it("refuses a reference on text-to-image and edit requests outside the 1-3 range", () => {
    expect(() =>
      falQwen3Payload(model(FAL_QWEN3_TEXT_SLUG), { prompt: "portrait", references: [ref("one")] }),
    ).toThrow(/does not accept reference images/);
    expect(() => falQwen3Payload(model(FAL_QWEN3_EDIT_SLUG), { prompt: "edit", references: [] })).toThrow(
      /requires 1 to 3 reference images/,
    );
    expect(() =>
      falQwen3Payload(model(FAL_QWEN3_EDIT_SLUG), {
        prompt: "edit",
        references: [ref("1"), ref("2"), ref("3"), ref("4")],
      }),
    ).toThrow(/requires 1 to 3 reference images/);
  });
});

describe("qwen3ImageSize", () => {
  it("maps the supported aspect/tier combinations onto fal's pixel bounds", () => {
    expect(qwen3ImageSize("16:9", "1K")).toEqual({ width: 1024, height: 576 });
    expect(qwen3ImageSize("16:9", "2K")).toEqual({ width: 2048, height: 1152 });
    expect(qwen3ImageSize("9:16", "1K")).toEqual({ width: 576, height: 1024 });
    expect(qwen3ImageSize(null, "1K")).toEqual({ width: 1024, height: 1024 });
  });
});

describe("fal result provenance", () => {
  it("never reports Vesper's requested schema revision as a provider-executed version", async () => {
    vi.stubEnv("FAL_API_KEY", "fal_test");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ images: [{ url: "data:image/png;base64,aW1hZ2U=" }] }), {
        status: 200,
        headers: { "x-fal-request-id": "fal-request-1" },
      }),
    );

    const staleRequest = { prompt: "portrait", versionId: "vesper-schema-revision" };
    const result = await runFalQwen3ImageModel(model(FAL_QWEN3_TEXT_SLUG), staleRequest);

    expect(result).toMatchObject({ ok: true, predictionId: "fal-request-1" });
    expect(result).not.toHaveProperty("executedVersionId");
  });
});
