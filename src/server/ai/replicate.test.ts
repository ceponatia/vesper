import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  replicateEditImage,
  replicateGenerateImage,
  replicateImageModelId,
  unwrapReplicateImage,
} from "./replicate";

const originalToken = process.env.REPLICATE_API_TOKEN;

beforeEach(() => {
  process.env.REPLICATE_API_TOKEN = "test-token";
  delete process.env.REPLICATE_IMAGE_MODEL;
  delete process.env.REPLICATE_IMAGE_EDIT_MODEL;
  delete process.env.REPLICATE_PREDICTION_TIMEOUT_MS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REPLICATE_PREDICTION_TIMEOUT_MS;
  if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = originalToken;
});

/** Capture the prediction POST for one succeeded-immediately generation. */
async function predictionRequest(): Promise<RequestInit | undefined> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/predictions")) {
        return Response.json({ id: "pred-1", status: "succeeded", output: ["https://replicate.delivery/o.webp"] });
      }
      return new Response(Buffer.from("image-bytes"), { status: 200 });
    }),
  );
  await replicateGenerateImage({ prompt: "portrait" });
  return calls[0]?.init;
}

describe("Replicate image client", () => {
  it("fails clearly when the token is absent", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    expect(await replicateGenerateImage({ prompt: "portrait" })).toEqual({
      ok: false,
      error: "REPLICATE_API_TOKEN not configured",
    });
  });

  it("submits an official-model prediction and downloads its output", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/models/qwen/qwen-image-2512/predictions")) {
          return Response.json({
            id: "pred-1",
            status: "succeeded",
            output: ["https://replicate.delivery/output.webp"],
          });
        }
        if (url === "https://replicate.delivery/output.webp") {
          return new Response(Buffer.from("image-bytes"), { status: 200, headers: { "content-type": "image/webp" } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await replicateGenerateImage({ prompt: "a portrait", aspectRatio: "3:4" });
    expect(result.ok).toBe(true);
    expect(result.image?.toString()).toBe("image-bytes");
    expect(replicateImageModelId()).toBe("qwen/qwen-image-2512");

    const prediction = calls[0];
    expect(prediction?.init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      Prefer: "wait=60",
      "Cancel-After": "300s",
    });
    const body = JSON.parse(String(prediction?.init?.body)) as { input: Record<string, unknown> };
    expect(body.input).toMatchObject({
      prompt: "a portrait",
      aspect_ratio: "3:4",
      output_format: "webp",
      disable_safety_checker: true,
    });
  });

  it("uploads references, runs Edit 2511, downloads output, and removes temporary files", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let uploadNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/v1/files") && method === "POST") {
          uploadNumber += 1;
          return Response.json({
            id: `file-${uploadNumber}`,
            urls: { get: `https://api.replicate.com/v1/files/file-${uploadNumber}` },
          });
        }
        if (url.includes("/models/qwen/qwen-image-edit-2511/predictions")) {
          const body = JSON.parse(String(init?.body)) as { input: { image: string[] } };
          expect(body.input.image).toEqual([
            "https://api.replicate.com/v1/files/file-1",
            "https://api.replicate.com/v1/files/file-2",
          ]);
          return Response.json({
            id: "pred-edit",
            status: "succeeded",
            output: ["https://replicate.delivery/edit.webp"],
          });
        }
        if (url === "https://replicate.delivery/edit.webp") {
          return new Response(Buffer.from("edited-image"), { status: 200 });
        }
        if (url.includes("/v1/files/file-") && method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const result = await replicateEditImage({
      prompt: "keep both people recognizable",
      references: [Buffer.from("one"), Buffer.from("two")],
    });
    expect(result.ok).toBe(true);
    expect(result.image?.toString()).toBe("edited-image");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  it("sends the configured prediction deadline as Replicate's Cancel-After", async () => {
    process.env.REPLICATE_PREDICTION_TIMEOUT_MS = "900000";
    expect(await predictionRequest()).toMatchObject({ headers: { "Cancel-After": "900s" } });
  });

  it("clamps an out-of-range deadline before it reaches the header", async () => {
    process.env.REPLICATE_PREDICTION_TIMEOUT_MS = "9999999999";
    expect(await predictionRequest()).toMatchObject({ headers: { "Cancel-After": "1800s" } });

    process.env.REPLICATE_PREDICTION_TIMEOUT_MS = "not-a-number";
    expect(await predictionRequest()).toMatchObject({ headers: { "Cancel-After": "300s" } });
  });

  it("unwraps bytes and preserves provider error text", () => {
    const image = Buffer.from("image");
    expect(unwrapReplicateImage({ ok: true, image }, "fallback")).toBe(image);
    expect(() => unwrapReplicateImage({ ok: false, error: "replicate 429" }, "fallback")).toThrow("replicate 429");
  });
});
