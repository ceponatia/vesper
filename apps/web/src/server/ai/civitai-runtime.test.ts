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
        output: { images: [{ url: "https://image.civitai.com/output.jpg", available: true }] },
      }],
    });

    expect(parsed.images).toEqual([{ url: "https://image.civitai.com/output.jpg", available: true, hidden: false, blocked: null }]);
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
          url: "https://image.civitai.com/output.jpg", available: true,
        }]));
      }
      if (href === "https://image.civitai.com/output.jpg") return new Response("image", { status: 200 });
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
            url: "https://image.civitai.com/output.jpg", available: true,
          }] } }],
        });
      }
      if (href === "https://image.civitai.com/output.jpg") return new Response("image", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: true, predictionId: "submit-retry" });
    expect(statusReads).toBe(3);
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true"), expect.stringContaining("whatif=false")]);
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
