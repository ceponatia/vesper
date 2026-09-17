import { afterEach, describe, expect, it, vi } from "vitest";
import { civitaiAsyncFailure } from "./civitai-errors";
import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG } from "@vesper/image-models";

vi.mock("../images/lora-credentials", () => ({
  civitaiApiToken: () => "civitai-test-token",
}));

import {
  CIVITAI_KLEIN_4B_VERSION_ID,
  CIVITAI_LORA_STRENGTH_FIELD,
  CIVITAI_LORA_VERSION_FIELD,
  civitaiKleinDimensions,
  civitaiKleinWorkflow,
  parseCivitaiWorkflow,
  previewCivitaiKleinRequest,
  runCivitaiKleinImageModel,
  validateCivitaiKleinRequest,
  validateCivitaiPreflightEcho,
} from "./civitai-runtime";

const MODEL: ImageModel = imageModelSchema.parse({
  id: "civitai-klein",
  slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
  label: "Civitai Klein",
  canGenerate: true,
  canEdit: true,
  referenceArity: "array",
  maxReferences: 2,
  probedVersionId: CIVITAI_KLEIN_4B_VERSION_ID,
});

const request = {
  prompt: "an adult studio portrait",
  aspect: "2:3",
  versionId: CIVITAI_KLEIN_4B_VERSION_ID,
  controlInput: { seed: 1234 },
};

/** The blob-endpoint href the runtime fetches for a given output blob id (#630). */
function blobUrl(id: string): string {
  return `https://orchestration.civitai.com/v2/consumer/blobs/${encodeURIComponent(id)}`;
}

function workflowFrom(body: Record<string, unknown>, id: string, status: string, images: unknown[] = []): Record<string, unknown> {
  const steps = body.steps as [{ $type: "imageGen"; input: Record<string, unknown> }];
  const echoedInput = { ...steps[0].input };
  delete echoedInput.model;
  echoedInput.modelVariant = "klein";
  return {
    id,
    status,
    allowMatureContent: body.allowMatureContent,
    currencies: body.currencies,
    upgradeMode: body.upgradeMode,
    transactions: { insufficientBuzz: false },
    steps: [{ $type: "imageGen", input: echoedInput, output: { images } }],
  };
}

function preflightWith(
  body: Record<string, unknown>,
  change: "mature-missing" | "mature-false" | "blue-currency" | "buzz-missing" | "variant-drift",
): Record<string, unknown> {
  const response = workflowFrom(body, "estimate-refused", "unassigned");
  if (change === "mature-missing") delete response.allowMatureContent;
  if (change === "mature-false") response.allowMatureContent = false;
  if (change === "blue-currency") response.currencies = ["blue"];
  if (change === "buzz-missing") {
    const transactions = response.transactions as Record<string, unknown>;
    delete transactions.insufficientBuzz;
  }
  if (change === "variant-drift") {
    const steps = response.steps as [{ input: Record<string, unknown> }];
    steps[0].input.modelVariant = "other";
  }
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Civitai Klein v2 payload", () => {
  it("maps the reviewed buckets and switches from create to edit for one or two references", () => {
    expect(civitaiKleinDimensions("1:1")).toEqual({ width: 1024, height: 1024 });
    expect(civitaiKleinDimensions("2:3")).toEqual({ width: 832, height: 1248 });
    expect(civitaiKleinDimensions("3:2")).toEqual({ width: 1248, height: 832 });

    for (const [count, operation] of [[0, "createImage"], [1, "editImage"], [2, "editImage"]] as const) {
      const references = Array.from({ length: count }, (_unused, index) => `data:image/png;base64,${String(index)}`);
      const body = civitaiKleinWorkflow(MODEL, request, references, {
        "urn:air:flux2:lora:civitai:2169780@2633618": 0.75,
      });
      expect(body).toMatchObject({
        allowMatureContent: true,
        currencies: ["yellow"],
        upgradeMode: "manual",
        steps: [{ $type: "imageGen", input: { engine: "flux2", model: "klein", modelVersion: "4b", operation } }],
      });
    }
  });

  it("sends the distilled checkpoint's own sampling recipe rather than a non-distilled one", () => {
    // Klein 4B is distilled: BFL's reference usage is guidance_scale 1.0 at 4
    // steps, and a controlled create/edit comparison showed a conventional CFG
    // 5 / 20-step recipe over-driving it into a stippled skin texture — present
    // with and without a LoRA — while also costing six times the Buzz. These two
    // values are the fix, so pin them rather than let a plausible-looking
    // "normal" sampling default creep back in.
    const expected = civitaiKleinWorkflow(MODEL, request);
    expect(expected.steps[0].input).toMatchObject({ cfgScale: 1, steps: 4 });

    // The preflight refuses a provider substitution by comparing the echo field
    // by field, so an echo carrying the old recipe must be REFUSED, not merely
    // differ from the request.
    // Round-trip as the transport does, so the echo is built from what actually
    // crosses the wire rather than from the in-process object.
    const sent = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    const faithful = parseCivitaiWorkflow(workflowFrom(sent, "estimate", "unassigned"));
    expect(validateCivitaiPreflightEcho(faithful, expected)).toBeNull();

    const drifted = workflowFrom(sent, "estimate", "unassigned");
    const driftedInput = (drifted.steps as [{ input: Record<string, unknown> }])[0].input;
    driftedInput.cfgScale = 5;
    driftedInput.steps = 20;
    expect(validateCivitaiPreflightEcho(parseCivitaiWorkflow(drifted), expected)).toContain("cfgScale");
  });

  it("carries operator sampling controls and refuses values outside the curated band", () => {
    const withControls = civitaiKleinWorkflow(MODEL, {
      ...request,
      controlInput: { seed: 1234, cfgScale: 2.5, steps: 8, negativePrompt: "deformed, clothing" },
    });
    expect(withControls.steps[0].input).toMatchObject({
      cfgScale: 2.5, steps: 8, negativePrompt: "deformed, clothing",
    });

    // Refusal, never clamping: a render nobody configured, billed under a record
    // claiming otherwise, is worse than a render that did not happen.
    for (const controlInput of [
      { cfgScale: 0.5 }, { cfgScale: 12 }, { cfgScale: "high" },
      { steps: 0 }, { steps: 200 }, { steps: 8.5 },
      { negativePrompt: 42 },
    ]) {
      expect(() => civitaiKleinWorkflow(MODEL, { ...request, controlInput }),
        `${JSON.stringify(controlInput)} must be refused`).toThrow();
    }
  });

  it("refuses a negative prompt at guidance 1, where the provider echoes it but ignores it", () => {
    // Measured: the same seed with and without a negative prompt at cfgScale 1
    // produced pixel-identical output while the preflight echoed the field back.
    // Accepting it would bill for a setting that demonstrably does nothing.
    expect(() => civitaiKleinWorkflow(MODEL, {
      ...request,
      controlInput: { negativePrompt: "deformed" },
    })).toThrow(/negative prompt at cfgScale 1/i);

    // Blank is not a request for negative guidance, so it stays legal and is
    // simply not sent.
    const blank = civitaiKleinWorkflow(MODEL, { ...request, controlInput: { negativePrompt: "   " } });
    expect(blank.steps[0].input.negativePrompt).toBeUndefined();
  });

  it("accepts the whole length the shared control contract offers the operator", () => {
    // `imageRenderControlsSchema.negativePrompt` is `z.string().max(2000)` and
    // the Generator textarea sets `maxLength={2000}`. A stricter transport bound
    // would fail, pre-provider, on a value the UI invited the operator to type.
    // The provider is not the constraint here: it echoed 1000, 2000 and 4000
    // characters back unchanged.
    const atLimit = civitaiKleinWorkflow(MODEL, {
      ...request,
      controlInput: { cfgScale: 2.5, negativePrompt: "d".repeat(2000) },
    });
    expect(atLimit.steps[0].input.negativePrompt).toHaveLength(2000);

    expect(() => civitaiKleinWorkflow(MODEL, {
      ...request,
      controlInput: { cfgScale: 2.5, negativePrompt: "d".repeat(2001) },
    })).toThrow(/2000 characters/i);
  });

  it("refuses a preflight that silently dropped the requested negative prompt", () => {
    const expected = civitaiKleinWorkflow(MODEL, {
      ...request,
      controlInput: { cfgScale: 2.5, steps: 8, negativePrompt: "deformed, clothing" },
    });
    const sent = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;

    const faithful = parseCivitaiWorkflow(workflowFrom(sent, "estimate", "unassigned"));
    expect(validateCivitaiPreflightEcho(faithful, expected)).toBeNull();

    // The provider discards an unrecognized negative-prompt spelling instead of
    // rejecting it, so an ABSENT field is the failure mode, not a changed one.
    const dropped = workflowFrom(sent, "estimate", "unassigned");
    delete (dropped.steps as [{ input: Record<string, unknown> }])[0].input.negativePrompt;
    expect(validateCivitaiPreflightEcho(parseCivitaiWorkflow(dropped), expected)).toContain("negative prompt");
  });

  it("rejects stale pins, unsupported controls, and more than two references before transport", () => {
    expect(() => validateCivitaiKleinRequest(MODEL, { ...request, versionId: "wrong-version" })).toThrow(/4b variant/i);
    expect(() => validateCivitaiKleinRequest(MODEL, {
      ...request,
      controlInput: { negative_prompt: "blur" },
    })).toThrow(/unsupported control/i);
    expect(() => civitaiKleinWorkflow(MODEL, request, ["one", "two", "three"])).toThrow(/at most 2/i);
  });

  it("keeps a curated LoRA download locator out of previews while declaring its unresolved AIR lookup", () => {
    const preview = previewCivitaiKleinRequest(MODEL, {
      ...request,
      controlInput: {
        [CIVITAI_LORA_VERSION_FIELD]: "https://civitai.com/api/download/models/2633618?token=super-secret",
        [CIVITAI_LORA_STRENGTH_FIELD]: 0.75,
      },
    }, 2);

    expect(preview).toMatchObject({
      loraAirResolution: { modelVersionId: "2633618", strength: 0.75 },
      steps: [{ input: { operation: "editImage" } }],
    });
    expect(JSON.stringify(preview)).not.toContain("super-secret");
    expect(JSON.stringify(preview)).not.toContain("api/download/models");
  });
});

describe("Civitai Klein v2 workflow responses", () => {
  it("parses output.images and redacts arbitrary provider error text", () => {
    const parsed = parseCivitaiWorkflow({
      id: "workflow-1",
      status: "succeeded",
      allowMatureContent: true,
      currencies: ["yellow"],
      upgradeMode: "manual",
      transactions: { insufficientBuzz: false },
      errors: ["the submitted prompt must not appear in diagnostics"],
      steps: [{
        $type: "imageGen",
        input: { engine: "flux2" },
        output: { images: [{ id: "1e9a21c3-4961-459b-8401-b0908289560f-0.jpg", available: true }] },
      }],
    });

    expect(parsed.images).toEqual([{ id: "1e9a21c3-4961-459b-8401-b0908289560f-0.jpg", available: true, hidden: false, blocked: null }]);
    expect(parsed.errors).toEqual(["provider_error"]);
  });
});

describe("Civitai Klein v2 transport", () => {
  it("preflights then submits the same two-reference LoRA workflow with a fresh external id", async () => {
    const workflowBodies: Record<string, unknown>[] = [];
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/model-versions/2633618")) {
        return Response.json({ id: 2633618, baseModel: "Flux.2 Klein 4B", model: { type: "LORA" }, modelId: 2169780 });
      }
      if (href.includes("/consumer/workflows?")) {
        workflowUrls.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        workflowBodies.push(body);
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-1" : "submit-1", whatif === "true" ? "unassigned" : "succeeded", [{
          id: "output.jpg", available: true,
        }]));
      }
      if (href === blobUrl("output.jpg")) return new Response("image", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, {
      ...request,
      controlInput: {
        seed: 1234,
        [CIVITAI_LORA_VERSION_FIELD]: "2633618",
        [CIVITAI_LORA_STRENGTH_FIELD]: 0.75,
      },
      references: [
        { bytes: Buffer.from("first"), mediaType: "image/png", extension: "png" },
        { bytes: Buffer.from("second"), mediaType: "image/png", extension: "png" },
      ],
    });

    expect(result).toMatchObject({ ok: true, predictionId: "submit-1", executedVersionId: "4b", sentReferenceCount: 2 });
    expect(workflowBodies).toHaveLength(2);
    expect(workflowUrls).toEqual([
      expect.stringContaining("whatif=true"),
      expect.stringContaining("whatif=false"),
    ]);
    const [preflight, submitted] = workflowBodies;
    if (!preflight || !submitted) throw new Error("expected preflight and submitted workflow bodies");
    expect(preflight.externalId).not.toBe(submitted.externalId);
    expect({ ...preflight, externalId: "same" }).toEqual({ ...submitted, externalId: "same" });
    expect(submitted).toMatchObject({
      allowMatureContent: true,
      currencies: ["yellow"],
      upgradeMode: "manual",
      steps: [{ input: {
        operation: "editImage",
        images: ["data:image/png;base64,Zmlyc3Q=", "data:image/png;base64,c2Vjb25k"],
        loras: { "urn:air:flux2:lora:civitai:2169780@2633618": 0.75 },
      } }],
    });
  });

  it("collects documented job reasons without retaining job prose", () => {
    const parsed = parseCivitaiWorkflow({
      id: "workflow-failed", status: "failed", steps: [{
        $type: "imageGen", input: {}, jobs: [{
          reason: "no_provider_available",
          blockedReason: "prompt=private&token=secret",
        }], output: {},
      }],
    });

    expect(parsed.errors).toEqual(["no_provider_available", "provider_error"]);
    expect(parsed.blocked).toBe(true);
    expect(JSON.stringify(parsed.errors)).not.toContain("secret");
  });

  it("does not classify a null job blockedReason as a blocked workflow", () => {
    const parsed = parseCivitaiWorkflow({
      id: "workflow-unavailable", status: "failed", steps: [{
        $type: "imageGen", input: {}, jobs: [{ reason: "no_provider_available", blockedReason: null }], output: {},
      }],
    });

    expect(parsed.blocked).toBe(false);
    expect(civitaiAsyncFailure(parsed.status, parsed.errors, parsed.blocked)).toMatchObject({
      code: "civitai_async_no_provider_available", retry: "deliberate",
    });
  });

  it("retries a transient workflow-status read without repeating the paid submit", async () => {
    vi.useFakeTimers();
    let statusReads = 0;
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowUrls.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-retry" : "submit-retry", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-retry")) {
        statusReads += 1;
        if (statusReads < 3) return Response.json({ code: "provider says prompt=private" }, { status: 503 });
        return Response.json({
          id: "submit-retry", status: "succeeded", allowMatureContent: true,
          currencies: ["yellow"], upgradeMode: "manual", transactions: { insufficientBuzz: false },
          steps: [{ $type: "imageGen", input: {}, output: { images: [{
            id: "output.jpg", available: true,
          }] } }],
        });
      }
      if (href === blobUrl("output.jpg")) return new Response("image", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: true, predictionId: "submit-retry" });
    expect(statusReads).toBe(3);
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true"), expect.stringContaining("whatif=false")]);
  });

  it("stops transient workflow-status retries after the bounded third read", async () => {
    vi.useFakeTimers();
    let statusReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-exhausted" : "submit-exhausted", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-exhausted")) {
        statusReads += 1;
        return Response.json({ detail: "prompt=private", errors: { "steps[0].input.resolution": ["token=secret"] } }, { status: 503 });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(statusReads).toBe(3);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-exhausted", error: expect.stringContaining("civitai_http_503; retry=automatic") });
    if (result.ok) throw new Error("expected the exhausted workflow-status read to fail");
    expect(result.error).toContain("paths=steps[0].input.resolution");
    expect(result.error).not.toContain("private");
    expect(result.error).not.toContain("secret");
  });

  it("ends a near-deadline workflow-status retry at the minimum 30-second budget without repeating the paid POST", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(1);
    const startedAt = Date.now();
    let workflowPosts = 0;
    let statusReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowPosts += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-deadline" : "submit-deadline", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-deadline")) {
        statusReads += 1;
        if (statusReads < 14) {
          return Response.json({ id: "submit-deadline", status: "processing", steps: [{
            $type: "imageGen", input: {}, output: {},
          }] });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1750));
        return Response.json({ detail: "provider token=secret" }, { status: 503 });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, { ...request, timeoutMs: 1 });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(statusReads).toBe(14);
    expect(workflowPosts).toBe(2);
    expect(Date.now() - startedAt).toBe(30_000);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-deadline", error: expect.stringContaining("civitai_async_timeout; retry=deliberate") });
    if (result.ok) throw new Error("expected the expired status retry to time out");
    expect(result.error).not.toContain("secret");
  });

  it("never retries a transient preflight or paid-submission POST", async () => {
    const workflowUrls: string[] = [];
    let phase: "preflight" | "submit" = "preflight";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (phase === "preflight") return Response.json({ detail: "prompt=private" }, { status: 503 });
      return Response.json(workflowFrom(body, whatif === "true" ? "estimate-post" : "submit-post", whatif === "true" ? "unassigned" : "processing"));
    });

    const preflightFailure = await runCivitaiKleinImageModel(MODEL, request);
    expect(preflightFailure).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_503; retry=deliberate") });
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);

    phase = "submit";
    workflowUrls.length = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") return Response.json(workflowFrom(body, "estimate-post", "unassigned"));
      return Response.json({ detail: "prompt=private" }, { status: 503 });
    });

    const submitFailure = await runCivitaiKleinImageModel(MODEL, request);
    expect(submitFailure).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_503; retry=deliberate") });
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true"), expect.stringContaining("whatif=false")]);
  });

  it("returns a stable non-retryable code for a malformed successful Civitai response", async () => {
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      return new Response("prompt=private", { status: 200 });
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_malformed_response; retry=never") });
    if (result.ok) throw new Error("expected malformed Civitai JSON to fail");
    expect(result.error).not.toContain("private");
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);
  });

  it.each(["fetch", "response text"] as const)("redacts a thrown preflight %s failure without retrying its POST", async (sentinel) => {
    let workflowPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowPosts += 1;
      if (sentinel === "fetch") throw new Error("provider token=secret prompt=private");
      const response = Response.json({ id: "unused" });
      vi.spyOn(response, "text").mockRejectedValue(new Error("provider token=secret prompt=private"));
      return response;
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(workflowPosts).toBe(1);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_transport_failure; retry=deliberate") });
    if (result.ok) throw new Error("expected the preflight transport failure to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
  });

  it.each(["fetch", "response text"] as const)("retries a thrown workflow-status %s failure as a bounded read", async (sentinel) => {
    vi.useFakeTimers();
    let statusReads = 0;
    let workflowPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowPosts += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-transport" : "submit-transport", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-transport")) {
        statusReads += 1;
        if (statusReads === 1) {
          if (sentinel === "fetch") throw new Error("provider token=secret prompt=private");
          const response = Response.json({ id: "unused" });
          vi.spyOn(response, "text").mockRejectedValue(new Error("provider token=secret prompt=private"));
          return response;
        }
        return Response.json({
          id: "submit-transport", status: "succeeded", allowMatureContent: true,
          currencies: ["yellow"], transactions: { insufficientBuzz: false },
          steps: [{ $type: "imageGen", input: {}, output: { images: [{ id: "output.jpg", available: true }] } }],
        });
      }
      if (href === blobUrl("output.jpg")) return new Response("image", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: true, predictionId: "submit-transport" });
    expect(statusReads).toBe(2);
    expect(workflowPosts).toBe(2);
  });

  it("redacts output-download transport sentinels without retrying the download", async () => {
    let outputReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-output" : "submit-output", whatif === "true" ? "unassigned" : "succeeded", [{
          id: "output-secret.jpg", available: true,
        }]));
      }
      if (href === blobUrl("output-secret.jpg")) {
        outputReads += 1;
        throw new Error("provider token=secret signed-url=private");
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(outputReads).toBe(1);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-output", error: expect.stringContaining("civitai_output_transport_failure; retry=deliberate") });
    if (result.ok) throw new Error("expected the output download to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
  });

  it.each([
    ["a missing output id", null, "civitai_output_unavailable; retry=deliberate", 0, undefined],
    ["an output HTTP failure", "output.jpg", "civitai_output_http_503; retry=deliberate", 1, () => new Response("token=secret", { status: 503 })],
    ["an oversized declared output", "output.jpg", "civitai_output_too_large; retry=never", 1, () => new Response("unused", { headers: { "content-length": "33554433" } })],
    ["an oversized output stream", "output.jpg", "civitai_output_too_large; retry=never", 1, () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: { byteLength: 32 * 1024 * 1024 + 1 } }),
          cancel: async () => undefined,
        }),
      },
    }) as unknown as Response],
    ["an absent output body", "output.jpg", "civitai_output_empty; retry=deliberate", 1, () => new Response(null)],
    ["an empty output stream", "output.jpg", "civitai_output_empty; retry=deliberate", 1, () => new Response("")],
    ["a thrown output stream read", "output.jpg", "civitai_output_transport_failure; retry=deliberate", 1, () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => { throw new Error("provider token=secret prompt=private"); },
          cancel: async () => undefined,
        }),
      },
    }) as unknown as Response],
  ] as const)("redacts %s", async (_description, blobId, expectedError, expectedOutputReads, outputResponse) => {
    let outputReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-output-boundary" : "submit-output-boundary", whatif === "true" ? "unassigned" : "succeeded", [
          blobId === null ? { available: true } : { id: blobId, available: true },
        ]));
      }
      if (blobId !== null && href === blobUrl(blobId)) {
        outputReads += 1;
        if (!outputResponse) throw new Error(`Unexpected output fetch ${href}`);
        return outputResponse();
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(outputReads).toBe(expectedOutputReads);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-output-boundary", error: expect.stringContaining(expectedError) });
    if (result.ok) throw new Error("expected the output boundary to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
  });

  it("ignores blank job failures on a successful workflow", () => {
    const parsed = parseCivitaiWorkflow({ id: "workflow-blank", status: "succeeded", steps: [{
      $type: "imageGen", input: {}, jobs: [{ reason: " ", blockedReason: "\t" }],
      output: { images: [{ id: "output.jpg", available: true }] },
    }] });
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocked).toBe(false);
  });

  it("returns a stable preflight refusal without a paid POST", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url); urls.push(href);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ...workflowFrom(body, "estimate-blocked", "failed"), steps: [{ $type: "imageGen", input: {}, jobs: [{ reason: "no_provider_available" }], output: {} }] });
    });
    const result = await runCivitaiKleinImageModel(MODEL, request);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_async_no_provider_available; retry=deliberate") });
    expect(urls).toEqual([expect.stringContaining("whatif=true")]);
  });

  it("does not make a paid submission after an insufficient-Buzz preflight", async () => {
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowUrls.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ...workflowFrom(body, "estimate-insufficient", "processing"), transactions: { insufficientBuzz: true } });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/insufficient yellow Buzz/i) });
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);
  });

  it.each([
    ["a missing mature-content echo", "mature-missing"],
    ["a false mature-content echo", "mature-false"],
    ["a blue-currency echo", "blue-currency"],
    ["a missing sufficient-Buzz echo", "buzz-missing"],
    ["a model-variant drift", "variant-drift"],
  ] as const)("does not make a paid submission after %s", async (_description, change) => {
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowUrls.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(preflightWith(body, change));
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result.ok).toBe(false);
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);
  });
});

/**
 * PROTECTS: the output download uses the authenticated blob endpoint instead
 * of the workflow's signed `url` (#630), and still follows the provider's own
 * redirect by hand rather than trusting either runtime redirect mode (#628).
 *
 * `GET {BLOBS_URL}/{id}` answers `301` with a RELATIVE `Location` to a signed
 * content path on the same host. A prior version of this download fetched the
 * signed `url` directly and, before that, refused any redirect outright;
 * either one lost a workflow that had rendered and been billed — the signed
 * `url` redirects some mature outputs to a `blocked` path that 403s with or
 * without the bearer token. Following the blob endpoint's own redirect cannot
 * mean trusting the runtime to land anywhere: each hop is revalidated, so
 * these cover the refusals and the blocked-content case as well as the
 * success, and prove the bearer travels on the first request only.
 *
 * The stub answers whatever these cases say, so it pins Vesper's follow-and-
 * revalidate logic, not the runtime's own `manual` semantics — that half is a
 * live measurement, recorded on the model's page.
 */
describe("Civitai Klein v2 blob download", () => {
  const BLOB_ID = "abc.jpg";
  const SIGNED_URL = "https://orchestration-new.civitai.com/v2/consumer/blobs/content/signed-at-render.jpg";

  /** A full render whose workflow succeeds; `output` answers the blob fetches. */
  function stubRender(output: (href: string, hop: number) => Response): { fetched: string[]; authorization: (string | null)[] } {
    const fetched: string[] = [];
    const authorization: (string | null)[] = [];
    let hop = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(
          body,
          whatif === "true" ? "estimate-1" : "submit-1",
          whatif === "true" ? "unassigned" : "succeeded",
          // The image carries both an id and a signed url: the runtime must
          // download through the id and must never fetch the url.
          [{ id: BLOB_ID, url: SIGNED_URL, available: true }],
        ));
      }
      fetched.push(href);
      authorization.push(new Headers(init?.headers).get("authorization"));
      const response = output(href, hop);
      hop += 1;
      return response;
    });
    return { fetched, authorization };
  }

  it("fetches the blob endpoint with the bearer, follows its redirect with none, and never fetches the signed url", async () => {
    const { fetched, authorization } = stubRender((_href, hop) => hop === 0
      ? new Response(null, { status: 301, headers: { location: "/v2/consumer/blobs/content/signed.jpg" } })
      : new Response("image-bytes", { status: 200 }));

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: true, predictionId: "submit-1" });
    expect(result.image?.toString()).toBe("image-bytes");
    // Resolved against the blob endpoint that sent it, not against the
    // workflow endpoint or the signed url the workflow also carried.
    expect(fetched).toEqual([
      blobUrl(BLOB_ID),
      "https://orchestration.civitai.com/v2/consumer/blobs/content/signed.jpg",
    ]);
    expect(fetched).not.toContain(SIGNED_URL);
    expect(authorization).toEqual(["Bearer civitai-test-token", null]);
  });

  it("reports a blocked content path as an ordinary 403 without leaking its body or location", async () => {
    const { fetched } = stubRender((_href, hop) => hop === 0
      ? new Response(null, { status: 301, headers: { location: "/v2/consumer/blobs/blocked/opaque-token" } })
      : new Response("blocked-sentinel-body", { status: 403 }));

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({
      ok: false, predictionId: "submit-1",
      error: expect.stringContaining("civitai_output_http_403; retry=deliberate"),
    });
    if (result.ok) throw new Error("expected the blocked content path to fail");
    expect(result.error).not.toContain("blocked-sentinel-body");
    expect(result.error).not.toContain("opaque-token");
    expect(fetched).toEqual([
      blobUrl(BLOB_ID),
      "https://orchestration.civitai.com/v2/consumer/blobs/blocked/opaque-token",
    ]);
  });

  it("refuses a redirect off the Civitai hosts without fetching it", async () => {
    const { fetched } = stubRender(() =>
      new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/output.jpg" } }));

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_output_invalid") });
    // The refused location is never requested: a paid render is worth less than
    // a download Vesper cannot account for.
    expect(fetched).toEqual([blobUrl(BLOB_ID)]);
  });

  it("refuses a redirect to a credentialed URL, Civitai host or not", async () => {
    const { fetched } = stubRender(() =>
      new Response(null, { status: 302, headers: { location: "https://user:pass@image.civitai.com/output.jpg" } }));

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_output_invalid") });
    expect(fetched).toEqual([blobUrl(BLOB_ID)]);
  });

  it("refuses a chain longer than the bound instead of chasing it", async () => {
    const { fetched } = stubRender((_href, hop) =>
      new Response(null, { status: 302, headers: { location: `/v2/consumer/blobs/hop-${String(hop)}.jpg` } }));

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_output_invalid") });
    // The original request plus MAX_OUTPUT_REDIRECTS hops, and no more.
    expect(fetched).toHaveLength(4);
  });
});
