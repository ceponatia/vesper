import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyImageModelAdvancedCapabilities, type ImageModel } from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  buildRegistryModelInput,
  DATA_URL_BUDGET_BYTES,
  disableSafetyChecker,
  overlayControlInput,
  OUTPUT_TIMEOUT_MS,
  referenceDataUrl,
  replicatePredictionTarget,
  REQUEST_TIMEOUT_MS,
  runRegistryImageModel,
  unwrapReplicateImage,
  withinDataUrlBudget,
  type RegistryModelRequest,
  type ReplicateImageResult,
} from "./replicate";

const originalToken = process.env.REPLICATE_API_TOKEN;

beforeEach(() => {
  process.env.REPLICATE_API_TOKEN = "test-token";
  delete process.env.REPLICATE_PREDICTION_TIMEOUT_MS;
  delete process.env.REPLICATE_SAFE_MODE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.REPLICATE_PREDICTION_TIMEOUT_MS;
  delete process.env.REPLICATE_SAFE_MODE;
  if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = originalToken;
});

const model = (overrides: Partial<ImageModel> = {}): ImageModel => ({
  id: "m1",
  slug: "qwen/qwen-image-2512",
  label: "Qwen Image 2512",
  canGenerate: true,
  canEdit: true,
  referenceField: "image",
  referenceArity: "single",
  referenceTransport: "file",
  maxReferences: 1,
  aspectMode: "aspect_ratio",
  supportedAspects: ["1:1", "3:4"],
  outputFormat: "webp",
  extraInput: {},
  // Reviewed capabilities play no part in payload construction; these are the
  // ratings this slug carries so the fixture stays honest.
  probedVersionId: null,
  editKind: "img2img",
  identityPreservation: "weak",
  operatorWarning: null,
  advancedCapabilities: emptyImageModelAdvancedCapabilities(),
  forPortrait: true,
  forVariant: false,
  forScene: false,
  builtin: true,
  sort: 10,
  ...overrides,
});

/** Capture the prediction POST (url + init) for one succeeded-immediately generation. */
async function predictionCall(
  over: Partial<RegistryModelRequest> = {},
): Promise<{ url: string; init?: RequestInit } | undefined> {
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
  await runRegistryImageModel(model(), { prompt: "portrait", aspect: "3:4", ...over });
  return calls[0];
}

async function predictionRequest(over: Partial<RegistryModelRequest> = {}): Promise<RequestInit | undefined> {
  return (await predictionCall(over))?.init;
}

/** Run one generation against a scripted prediction body — the seam for asserting
 * what the adapter reads back OFF the provider's own response. A `succeeded`
 * body is given an output URL unless the case supplies its own. */
async function runWithPrediction(prediction: Record<string, unknown>): Promise<ReplicateImageResult> {
  const body =
    prediction.status === "succeeded" && !("output" in prediction)
      ? { ...prediction, output: ["https://replicate.delivery/o.webp"] }
      : prediction;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/predictions")) return Response.json(body);
      return new Response(Buffer.from("image-bytes"), { status: 200 });
    }),
  );
  return runRegistryImageModel(model(), { prompt: "portrait", aspect: "3:4" });
}

describe("buildRegistryModelInput", () => {
  it("omits the reference key entirely when there are no references", () => {
    // An absent key and an empty array are not the same to every backend, and a
    // model whose reference input is optional should see the former.
    const input = buildRegistryModelInput(model(), "a portrait", [], "3:4");
    expect("image" in input).toBe(false);
    expect(input).toMatchObject({ prompt: "a portrait", aspect_ratio: "3:4", output_format: "webp" });
  });

  it("writes a single-arity reference as a bare string and an array-arity one as a list", () => {
    const single = buildRegistryModelInput(model(), "p", ["u1"], "3:4");
    expect(single.image).toBe("u1");

    // Same field NAME, different arity — the two Qwen models really do differ here.
    const array = buildRegistryModelInput(
      model({ slug: "qwen/qwen-image-edit-2511", referenceArity: "array", maxReferences: 3 }),
      "p",
      ["u1", "u2"],
      "3:4",
    );
    expect(array.image).toEqual(["u1", "u2"]);
  });

  it("honours each model's own reference field name", () => {
    expect(buildRegistryModelInput(model({ referenceField: "image_input", referenceArity: "array" }), "p", ["u"], null))
      .toHaveProperty("image_input", ["u"]);
    expect(buildRegistryModelInput(model({ referenceField: "images", referenceArity: "array" }), "p", ["u"], null))
      .toHaveProperty("images", ["u"]);
  });

  it("writes the shape to `size` for a size-mode model and `aspect_ratio` otherwise", () => {
    const sized = buildRegistryModelInput(model({ aspectMode: "size" }), "p", [], "1536*2048");
    expect(sized).toMatchObject({ size: "1536*2048" });
    expect("aspect_ratio" in sized).toBe(false);

    const ratio = buildRegistryModelInput(model(), "p", [], "3:4");
    expect(ratio).toMatchObject({ aspect_ratio: "3:4" });
    expect("size" in ratio).toBe(false);
  });

  it("omits the aspect key when no shape was chosen", () => {
    const input = buildRegistryModelInput(model(), "p", [], null);
    expect("aspect_ratio" in input).toBe(false);
    expect("size" in input).toBe(false);
  });

  it("omits output_format for a model that has no such input", () => {
    expect("output_format" in buildRegistryModelInput(model({ outputFormat: null }), "p", [], "3:4")).toBe(false);
  });

  it("overrides the value of a declared safety toggle but never introduces the key", () => {
    // Replicate rejects unknown inputs, so a model without the field must not
    // receive it — this is why the key lives in extraInput rather than being
    // added unconditionally.
    const withToggle = buildRegistryModelInput(model({ extraInput: { disable_safety_checker: true } }), "p", [], null);
    expect(withToggle.disable_safety_checker).toBe(true);
    // The exported resolver is the SAME answer the builder writes. Anything that
    // fingerprints what a render sends has to be able to ask it, or the
    // fingerprint describes the stored placeholder instead of the env's value.
    expect(withToggle.disable_safety_checker).toBe(disableSafetyChecker());

    process.env.REPLICATE_SAFE_MODE = "true";
    const safe = buildRegistryModelInput(model({ extraInput: { disable_safety_checker: true } }), "p", [], null);
    expect(safe.disable_safety_checker).toBe(false);
    expect(disableSafetyChecker()).toBe(false);

    const without = buildRegistryModelInput(model({ extraInput: {} }), "p", [], null);
    expect("disable_safety_checker" in without).toBe(false);
  });

  it("passes other per-model constants through untouched", () => {
    const input = buildRegistryModelInput(
      model({ extraInput: { size: "2K", max_images: 1, sequential_image_generation: "disabled" } }),
      "p",
      [],
      "3:4",
    );
    expect(input).toMatchObject({ size: "2K", max_images: 1, sequential_image_generation: "disabled" });
  });
});

describe("per-call deadlines", () => {
  it("exports the two request budgets callers have to reason about", () => {
    // Exported so the identity trial can size its stale-claim window off the
    // real numbers rather than a hand-copied approximation that stops matching
    // the first time either moves. Sanity rails, not a restatement.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(OUTPUT_TIMEOUT_MS).toBeGreaterThan(30_000);
  });
});

describe("control input overlay", () => {
  it("merges mapped fields over the built payload, later winning", () => {
    // The capabilities spec's merge order: model `extraInput` first, the
    // profile's resolved controls after it.
    const built = buildRegistryModelInput(model({ extraInput: { guidance_scale: 3 } }), "p", [], "3:4");
    const merged = overlayControlInput(built, { guidance_scale: 7, negative_prompt: "blurry" }, model());
    expect(merged).toMatchObject({ prompt: "p", aspect_ratio: "3:4", guidance_scale: 7, negative_prompt: "blurry" });
  });

  it("refuses to let control input rewrite the prompt, reference, or aspect field", () => {
    // A stored profile row must not be able to redirect where the prompt goes.
    const target = model({ referenceField: "image_input", referenceArity: "array" });
    const built = buildRegistryModelInput(target, "the real prompt", ["u1"], "3:4");
    const sink = new DiagnosticCollector();
    const merged = overlayControlInput(
      built,
      { prompt: "hijacked", image_input: ["evil"], aspect_ratio: "16:9", guidance_scale: 4 },
      target,
      sink,
    );
    expect(merged).toMatchObject({ prompt: "the real prompt", image_input: ["u1"], aspect_ratio: "3:4", guidance_scale: 4 });
    expect(sink.items.map((entry) => entry.code)).toEqual(["image_model.reserved_field_ignored"]);
  });

  it("returns the built payload untouched when there is no control input", () => {
    const built = buildRegistryModelInput(model(), "p", [], null);
    expect(overlayControlInput(built, undefined, model())).toBe(built);
  });
});

describe("inline reference transport", () => {
  it("stamps the stored webp media type into the URI", () => {
    expect(referenceDataUrl(Buffer.from("bytes"))).toBe(`data:image/webp;base64,${Buffer.from("bytes").toString("base64")}`);
  });

  // These assert by identity (`toBe`) rather than value: a deep-equality check
  // over a multi-megabyte buffer walks it byte by byte and blows the 5s budget.
  it("keeps the references that fit the byte budget, in order", () => {
    const small = Buffer.alloc(1_000);
    const huge = Buffer.alloc(7 * 1024 * 1024);
    expect(withinDataUrlBudget([small, small])).toHaveLength(2);

    const trimmed = withinDataUrlBudget([small, huge, small]);
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toBe(small);
  });

  it("keeps the anchor reference even when it alone exceeds the budget", () => {
    // Dropping every reference would render a stranger rather than the
    // character; let the provider be the one to refuse an oversized request.
    const huge = Buffer.alloc(7 * 1024 * 1024);
    const kept = withinDataUrlBudget([huge]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(huge);
  });
});

describe("replicatePredictionTarget", () => {
  it("routes a bare slug to the model's own prediction endpoint", () => {
    expect(replicatePredictionTarget("qwen/qwen-image-2512")).toEqual({
      path: "/models/qwen/qwen-image-2512/predictions",
    });
  });

  it("routes a pinned slug to /predictions carrying the version", () => {
    expect(replicatePredictionTarget("qwen/qwen-image-2512:abc123")).toEqual({
      path: "/predictions",
      version: "abc123",
    });
  });

  it("routes a BARE slug with an explicit version to /predictions carrying it", () => {
    // The controlled-trial case: a bare slug would otherwise run whatever
    // `latest_version` is that hour, which is not a comparison.
    expect(replicatePredictionTarget("qwen/qwen-image-2512", "v-probed")).toEqual({
      path: "/predictions",
      version: "v-probed",
    });
  });

  it("lets an explicit version win over one pinned in the slug", () => {
    expect(replicatePredictionTarget("qwen/qwen-image-2512:slugpin", "explicit")).toEqual({
      path: "/predictions",
      version: "explicit",
    });
  });

  it("rejects malformed slugs", () => {
    expect(() => replicatePredictionTarget("qwen")).toThrow(/invalid Replicate model id/);
    expect(() => replicatePredictionTarget("a/b/c")).toThrow(/invalid Replicate model id/);
    expect(() => replicatePredictionTarget("a/b:c:d")).toThrow(/invalid Replicate model id/);
    expect(() => replicatePredictionTarget("qwen", "explicit")).toThrow(/invalid Replicate model id/);
  });
});

describe("runRegistryImageModel", () => {
  it("fails clearly when the token is absent", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    expect(await runRegistryImageModel(model(), { prompt: "portrait" })).toEqual({
      ok: false,
      error: "REPLICATE_API_TOKEN not configured",
    });
  });

  it("refuses to run an edit-only model with no reference", async () => {
    const editOnly = model({ slug: "qwen/qwen-image-edit-2511", canGenerate: false });
    expect(await runRegistryImageModel(editOnly, { prompt: "portrait" })).toEqual({
      ok: false,
      error: "qwen/qwen-image-edit-2511 requires at least one reference image",
    });
  });

  it("submits a model prediction and downloads its output", async () => {
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

    const result = await runRegistryImageModel(model(), { prompt: "a portrait", aspect: "3:4" });
    expect(result.ok).toBe(true);
    expect(result.image?.toString()).toBe("image-bytes");

    const prediction = calls[0];
    expect(prediction?.init?.headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      Prefer: "wait=60",
      "Cancel-After": "300s",
    });
    const body = JSON.parse(String(prediction?.init?.body)) as { input: Record<string, unknown> };
    expect(body.input).toMatchObject({ prompt: "a portrait", aspect_ratio: "3:4", output_format: "webp" });
  });

  it("uploads references, runs the model, downloads output, and removes temporary files", async () => {
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

    const result = await runRegistryImageModel(
      model({ slug: "qwen/qwen-image-edit-2511", referenceArity: "array", maxReferences: 3 }),
      { prompt: "keep both people recognizable", references: [Buffer.from("one"), Buffer.from("two")] },
    );
    expect(result.ok).toBe(true);
    expect(result.image?.toString()).toBe("edited-image");
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
  });

  it("inlines references as data URIs for a data_url model, uploading nothing", async () => {
    // Wan 2.7 reads the file extension off whatever it is handed and rejects
    // Replicate's own upload URLs, which reach the model container without one
    // (`Invalid image format ''`). A data URI carries the type inline.
    const calls: Array<{ url: string; method: string }> = [];
    let sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.includes("/models/wan-video/wan-2.7-image-pro/predictions")) {
          const body = JSON.parse(String(init?.body)) as { input: { images: string[] } };
          sent = body.input.images;
          return Response.json({ id: "p", status: "succeeded", output: ["https://replicate.delivery/o.webp"] });
        }
        if (url === "https://replicate.delivery/o.webp") return new Response(Buffer.from("wan-image"), { status: 200 });
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    const result = await runRegistryImageModel(
      model({
        slug: "wan-video/wan-2.7-image-pro",
        referenceField: "images",
        referenceArity: "array",
        referenceTransport: "data_url",
        maxReferences: 9,
      }),
      { prompt: "a scene", references: [Buffer.from("one"), Buffer.from("two")] },
    );

    expect(result.ok).toBe(true);
    expect(sent).toEqual([
      `data:image/webp;base64,${Buffer.from("one").toString("base64")}`,
      `data:image/webp;base64,${Buffer.from("two").toString("base64")}`,
    ]);
    // No upload means no orphaned file to clean up either.
    expect(calls.some((call) => call.url.endsWith("/v1/files"))).toBe(false);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("uploads only as many references as the model accepts", async () => {
    // A single-reference model handed three used to receive all three and
    // silently ignore two; `fitReferences` trims before the upload cost.
    let uploads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/v1/files") && method === "POST") {
          uploads += 1;
          return Response.json({ id: `f${uploads}`, urls: { get: `https://api.replicate.com/v1/files/f${uploads}` } });
        }
        if (url.includes("/predictions")) {
          return Response.json({ id: "p", status: "succeeded", output: ["https://replicate.delivery/o.webp"] });
        }
        if (url.includes("/v1/files/")) return new Response(null, { status: 204 });
        return new Response(Buffer.from("bytes"), { status: 200 });
      }),
    );

    await runRegistryImageModel(model({ referenceArity: "single", maxReferences: 1 }), {
      prompt: "p",
      references: [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
    });
    expect(uploads).toBe(1);
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

  it("prefers the request's own prediction budget over the env value", async () => {
    // The capabilities spec's order: profile timeout, then env, then default.
    process.env.REPLICATE_PREDICTION_TIMEOUT_MS = "600000";
    expect(await predictionRequest({ timeoutMs: 90_000 })).toMatchObject({ headers: { "Cancel-After": "90s" } });
  });

  it("clamps a request budget outside the sane band", async () => {
    expect(await predictionRequest({ timeoutMs: 1_000 })).toMatchObject({ headers: { "Cancel-After": "30s" } });
    expect(await predictionRequest({ timeoutMs: 99_999_999 })).toMatchObject({ headers: { "Cancel-After": "1800s" } });
  });

  it("posts an explicitly pinned version to /predictions even for a bare slug", async () => {
    const call = await predictionCall({ versionId: "version-abc" });
    expect(call?.url).toBe("https://api.replicate.com/v1/predictions");
    const body = JSON.parse(String(call?.init?.body)) as { version?: string; input: Record<string, unknown> };
    expect(body.version).toBe("version-abc");
    expect(body.input).toMatchObject({ prompt: "portrait" });
  });

  it("merges control input into the posted payload without touching the prompt", async () => {
    const call = await predictionCall({ controlInput: { guidance_scale: 6, prompt: "hijacked" } });
    const body = JSON.parse(String(call?.init?.body)) as { input: Record<string, unknown> };
    expect(body.input).toMatchObject({ prompt: "portrait", guidance_scale: 6 });
  });

  it("reports the version the provider says it RAN, and stays silent when it says nothing", async () => {
    // A pin states intent; only the echo states outcome. A bare slug resolves
    // `latest_version` server-side and a pinned id can be re-pointed, so a
    // controlled comparison that cannot tell those apart is grading whatever
    // shipped that hour under a pin's name.
    const echoed = await runWithPrediction({ id: "pred-v", status: "succeeded", version: "version-actually-ran" });
    expect(echoed).toMatchObject({ ok: true, predictionId: "pred-v", executedVersionId: "version-actually-ran" });

    // No echo means "the provider did not say", which must not become a field —
    // a caller comparing against a pin has to be able to see the difference
    // between disagreement and silence.
    const silent = await runWithPrediction({ id: "pred-s", status: "succeeded" });
    expect(silent.ok).toBe(true);
    expect("executedVersionId" in silent).toBe(false);

    // And it rides a FAILED prediction too: which version produced a failure is
    // exactly what an operator needs when the pin is under suspicion.
    const failed = await runWithPrediction({ id: "pred-f", status: "failed", output: null, version: "version-bad" });
    expect(failed).toMatchObject({ ok: false, predictionId: "pred-f", executedVersionId: "version-bad" });
  });

  it("unwraps bytes and preserves provider error text", () => {
    const image = Buffer.from("image");
    expect(unwrapReplicateImage({ ok: true, image }, "fallback")).toBe(image);
    expect(() => unwrapReplicateImage({ ok: false, error: "replicate 429" }, "fallback")).toThrow("replicate 429");
  });
});

describe("bound control images", () => {
  /**
   * Run one request through a stub that fakes uploads, the prediction, and the
   * output download, and hand back the posted input.
   */
  async function postedInput(
    request: RegistryModelRequest,
    over: Partial<ImageModel> = {},
  ): Promise<Record<string, unknown>> {
    let uploadNumber = 0;
    let input: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
        const url = String(target);
        const method = init?.method ?? "GET";
        if (url.endsWith("/v1/files") && method === "POST") {
          uploadNumber += 1;
          return Response.json({ id: `f${uploadNumber}`, urls: { get: `https://files.test/${uploadNumber}` } });
        }
        if (url.includes("/predictions")) {
          input = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
          return Response.json({ id: "p", status: "succeeded", output: ["https://replicate.delivery/o.webp"] });
        }
        if (url.includes("/v1/files/") && method === "DELETE") return new Response(null, { status: 204 });
        return new Response(Buffer.from("bytes"), { status: 200 });
      }),
    );
    await runRegistryImageModel(model(over), request);
    return input;
  }

  it("writes a bound control to its own field, leaving the reference array alone", async () => {
    const input = await postedInput(
      {
        prompt: "portrait",
        references: [Buffer.from("face")],
        controlReferences: [{ field: "pose_image", arity: "single", buffers: [Buffer.from("skeleton")] }],
      },
      { referenceArity: "array", maxReferences: 2 },
    );
    // Uploads are numbered references-first, so the face is file 1 and the
    // skeleton file 2 — and the skeleton is NOT in the `image` list.
    expect(input.image).toEqual(["https://files.test/1"]);
    expect(input.pose_image).toBe("https://files.test/2");
  });

  it("writes an array-arity control field as a list even at one image", async () => {
    const input = await postedInput({
      prompt: "portrait",
      controlReferences: [{ field: "edges", arity: "array", buffers: [Buffer.from("e1")] }],
    });
    expect(input.edges).toEqual(["https://files.test/1"]);
  });

  it("keeps two byte-identical control images apart", async () => {
    // The positional split exists for exactly this: a lookup keyed by buffer
    // would collapse these onto one URL and silently send half the images.
    const input = await postedInput({
      prompt: "portrait",
      controlReferences: [
        { field: "pose_image", arity: "single", buffers: [Buffer.from("same")] },
        { field: "depth_image", arity: "single", buffers: [Buffer.from("same")] },
      ],
    });
    expect(input.pose_image).toBe("https://files.test/1");
    expect(input.depth_image).toBe("https://files.test/2");
  });

  it("inlines bound controls for a data_url model, uploading nothing", async () => {
    const input = await postedInput(
      {
        prompt: "a scene",
        references: [Buffer.from("face")],
        controlReferences: [{ field: "pose_image", arity: "single", buffers: [Buffer.from("skeleton")] }],
      },
      { referenceField: "images", referenceArity: "array", referenceTransport: "data_url", maxReferences: 4 },
    );
    expect(input.images).toEqual([referenceDataUrl(Buffer.from("face"))]);
    expect(input.pose_image).toBe(referenceDataUrl(Buffer.from("skeleton")));
  });

  it("lets an edit-only model run on a control image alone", async () => {
    // Without this the dedicated-input path would be unusable on the very models
    // it exists for: a pose map IS an input image.
    const input = await postedInput(
      {
        prompt: "portrait",
        controlReferences: [{ field: "pose_image", arity: "single", buffers: [Buffer.from("skeleton")] }],
      },
      { canGenerate: false },
    );
    expect(input.pose_image).toBe("https://files.test/1");
  });

  it("refuses a control bound to a field the render path owns", async () => {
    const sink = new DiagnosticCollector();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: string | URL | Request, init?: RequestInit) => {
        const url = String(target);
        if (url.endsWith("/v1/files")) return Response.json({ id: "f1", urls: { get: "https://files.test/1" } });
        if (url.includes("/predictions")) {
          const body = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
          expect(body.prompt).toBe("portrait");
          return Response.json({ id: "p", status: "succeeded", output: ["https://replicate.delivery/o.webp"] });
        }
        if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 204 });
        return new Response(Buffer.from("bytes"), { status: 200 });
      }),
    );
    await runRegistryImageModel(
      model(),
      { prompt: "portrait", controlReferences: [{ field: "prompt", arity: "single", buffers: [Buffer.from("x")] }] },
      sink,
    );
    expect(sink.items.map((entry) => entry.code)).toContain("image_model.control_field_reserved");
  });

  it("charges bound controls against the inline byte budget before optional references", () => {
    // A control was bound to a field the version declared; an optional trailing
    // style reference is what a byte budget should give up instead.
    //
    // The reservation must leave room for SOME references, or this measures the
    // anchor-preservation fallback (which returns the first reference whatever
    // the budget says) instead of the reservation. Room for two of three is the
    // case with an unambiguous answer.
    const small = Buffer.alloc(16);
    expect(withinDataUrlBudget([small, small, small])).toHaveLength(3);
    expect(withinDataUrlBudget([small, small, small], DATA_URL_BUDGET_BYTES - 40)).toHaveLength(2);
  });

  it("still sends the anchor when the reservation alone exhausts the budget", () => {
    // Sending no identity reference renders a stranger, so the anchor survives a
    // blown budget and the provider is left to accept or refuse it.
    const small = Buffer.alloc(16);
    expect(withinDataUrlBudget([small, small], DATA_URL_BUDGET_BYTES)).toEqual([small]);
  });
});
