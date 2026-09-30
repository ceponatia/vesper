import { afterEach, describe, expect, it, vi } from "vitest";
import { imageModelSchema, type ImageModel } from "@vesper/image-core";
import { CIVITAI_QWEN_IMAGE_21_SLUG } from "@vesper/image-models";

vi.mock("../images/lora-credentials", () => ({
  civitaiApiToken: () => "civitai-test-token",
}));

import {
  CIVITAI_QWEN21_ASPECTS,
  CIVITAI_QWEN21_RESOLUTION_TIERS,
  CIVITAI_QWEN_IMAGE_21_VERSION_ID,
  civitaiQwen21SentShape,
  civitaiQwen21Workflow,
  previewCivitaiQwen21Request,
  runCivitaiQwen21ImageModel,
  validateCivitaiQwen21PreflightEcho,
} from "./civitai-qwen21-runtime";
import { parseCivitaiWorkflow, type CivitaiWorkflow } from "./civitai-runtime";

const MODEL: ImageModel = imageModelSchema.parse({
  id: "civitai-qwen21",
  slug: CIVITAI_QWEN_IMAGE_21_SLUG,
  label: "Qwen Image 2.1 (Civitai)",
  canGenerate: true,
  canEdit: true,
  referenceField: "images",
  referenceArity: "array",
  maxReferences: 10,
  probedVersionId: CIVITAI_QWEN_IMAGE_21_VERSION_ID,
});

const PROMPT = "an adult studio portrait";
const request = { prompt: PROMPT, aspect: null, versionId: CIVITAI_QWEN_IMAGE_21_VERSION_ID };
const TWO_REFERENCES = ["data:image/jpeg;base64,Zmlyc3Q=", "data:image/jpeg;base64,c2Vjb25k"];
const QWEN21_LORA_AIR = "urn:air:qwen21:lora:civitai:3000001@3400001";

const WORKFLOW_POLICY = {
  allowMatureContent: true,
  currencies: ["yellow"],
  upgradeMode: "manual",
  tags: ["vesper", "image-generator"],
} as const;

function blobUrl(id: string): string {
  return `https://orchestration.civitai.com/v2/consumer/blobs/${encodeURIComponent(id)}`;
}

/**
 * The provider's what-if/submit answer for a sent workflow, shaped like the
 * measured 2026-09-30 echo: every sent field back verbatim, and on an edit the
 * read-only `width`/`height` the provider inferred from the reference — values
 * nobody sent, which the echo check must not compare.
 */
function echoOf(body: Record<string, unknown>, id: string, status: string, images: unknown[] = []): Record<string, unknown> {
  const steps = body.steps as [{ input: Record<string, unknown> }];
  const input = { ...steps[0].input };
  if (input.operation === "editImage") {
    input.width = 1184;
    input.height = 880;
  }
  return {
    id,
    status,
    allowMatureContent: body.allowMatureContent,
    currencies: body.currencies,
    upgradeMode: body.upgradeMode,
    transactions: { insufficientBuzz: false, list: [{ accountType: "yellow" }] },
    steps: [{ $type: "imageGen", input, output: { images } }],
  };
}

/** The echo of what actually crosses the wire, with `change` applied to its step input. */
function echoFor(expected: CivitaiWorkflow, change: (input: Record<string, unknown>) => void = () => undefined) {
  const sent = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
  const echo = echoOf(sent, "estimate", "unassigned");
  change((echo.steps as [{ input: Record<string, unknown> }])[0].input);
  return parseCivitaiWorkflow(echo);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Civitai Qwen Image 2.1 workflow", () => {
  it("builds a prompt-only create on the comfy lane at the official defaults", () => {
    // Literal: this IS the wire contract, measured by the preflight. No
    // `diffusionModel` (the hosted default), and none of Klein's flux2 fields.
    expect(civitaiQwen21Workflow(MODEL, request)).toEqual({
      externalId: expect.any(String) as unknown,
      ...WORKFLOW_POLICY,
      steps: [{
        $type: "imageGen",
        input: {
          engine: "comfy",
          ecosystem: "qwen",
          model: "2.1",
          operation: "createImage",
          prompt: PROMPT,
          width: 1024,
          height: 1024,
          quantity: 1,
          cfgScale: 1,
          steps: 40,
          sampler: "euler",
          scheduler: "simple",
          outputFormat: "jpeg",
          loras: {},
        },
      }],
    });
  });

  it("sizes a create from the aspect and the resolution tier", () => {
    const sizes: Record<string, Record<string, [number, number]>> = {
      "1K": {
        "1:1": [1024, 1024], "4:3": [1024, 768], "3:4": [768, 1024], "3:2": [1216, 832],
        "2:3": [832, 1216], "16:9": [1024, 576], "9:16": [576, 1024],
      },
      "2K": {
        "1:1": [2048, 2048], "4:3": [2048, 1536], "3:4": [1536, 2048], "3:2": [2048, 1344],
        "2:3": [1344, 2048], "16:9": [2048, 1152], "9:16": [1152, 2048],
      },
    };
    for (const tier of CIVITAI_QWEN21_RESOLUTION_TIERS) {
      for (const aspect of CIVITAI_QWEN21_ASPECTS) {
        const input = civitaiQwen21Workflow(MODEL, { ...request, aspect, controlInput: { resolution: tier } }).steps[0].input;
        const expected = sizes[tier]?.[aspect];
        expect(expected, `${tier} ${aspect} must have a size`).toBeDefined();
        expect([input.width, input.height], `${tier} ${aspect}`).toEqual(expected);
        // The lane's own bounds: multiples of 32, never above 2048.
        expect(Number(input.width) % 32).toBe(0);
        expect(Number(input.height) % 32).toBe(0);
        expect(Math.max(Number(input.width), Number(input.height))).toBeLessThanOrEqual(2048);
        // A pixel budget is an edit field; create sends a size.
        expect(input).not.toHaveProperty("resolution");
      }
    }
  });

  it("edits with the references, a pixel budget from the tier, and no width or height", () => {
    const body = civitaiQwen21Workflow(
      MODEL,
      { ...request, controlInput: { resolution: "2K", seed: 7 } },
      TWO_REFERENCES,
      { [QWEN21_LORA_AIR]: 0.8 },
    );
    // The provider sizes an edit from the reference and ignores an explicit
    // width/height pair, so none is sent.
    expect(body.steps[0].input).toEqual({
      engine: "comfy",
      ecosystem: "qwen",
      model: "2.1",
      operation: "editImage",
      prompt: PROMPT,
      resolution: 2048,
      images: TWO_REFERENCES,
      quantity: 1,
      cfgScale: 1,
      steps: 40,
      sampler: "euler",
      scheduler: "simple",
      outputFormat: "jpeg",
      loras: { [QWEN21_LORA_AIR]: 0.8 },
      seed: 7,
    });
    expect(civitaiQwen21Workflow(MODEL, request, TWO_REFERENCES.slice(0, 1)).steps[0].input).toMatchObject({
      operation: "editImage", resolution: 1024,
    });
  });

  /**
   * PROTECTS: a shape the operator chose on an edit is refused before spend
   * rather than recorded and silently not applied. An edit sends no size, and
   * a ratio in the row's supported set needs no local crop, so the output kept
   * the reference's aspect while the run record claimed the chosen one.
   */
  it("refuses a chosen output shape on an edit, in the workflow and the preview, while a create still sizes from it", () => {
    const refusal = /sizes an edit from its reference; clear the output shape or remove the references/;
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, aspect: "16:9" }, TWO_REFERENCES)).toThrow(refusal);
    // The row's own default ratio is still a choice: only "no shape" passes.
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, aspect: "1:1" }, TWO_REFERENCES.slice(0, 1))).toThrow(refusal);
    expect(() => previewCivitaiQwen21Request(MODEL, { ...request, aspect: "16:9" }, 2)).toThrow(refusal);

    expect(civitaiQwen21Workflow(MODEL, { ...request, aspect: null }, TWO_REFERENCES).steps[0].input)
      .toMatchObject({ operation: "editImage", resolution: 1024 });
    expect(previewCivitaiQwen21Request(MODEL, { ...request, aspect: null }, 2))
      .toMatchObject({ steps: [{ input: { operation: "editImage", resolution: 1024 } }] });
    expect(civitaiQwen21Workflow(MODEL, { ...request, aspect: "3:4" }).steps[0].input)
      .toMatchObject({ operation: "createImage", width: 768, height: 1024 });
    expect(previewCivitaiQwen21Request(MODEL, { ...request, aspect: "3:4" }, 0))
      .toMatchObject({ steps: [{ input: { operation: "createImage", width: 768, height: 1024 } }] });
  });

  it("carries every operator sampling control under its wire name", () => {
    const input = civitaiQwen21Workflow(MODEL, {
      ...request,
      controlInput: {
        seed: 42, cfgScale: 2.5, steps: 30, sampler: "dpmpp_2m", scheduler: "karras", negativePrompt: "blurry",
      },
    }).steps[0].input;
    expect(input).toMatchObject({
      seed: 42, cfgScale: 2.5, steps: 30, sampler: "dpmpp_2m", scheduler: "karras", negativePrompt: "blurry",
    });
    // The bands' own edges are legal values, not refusals.
    for (const controlInput of [{ cfgScale: 0 }, { cfgScale: 30 }, { steps: 1 }, { steps: 60 }]) {
      expect(() => civitaiQwen21Workflow(MODEL, { ...request, controlInput })).not.toThrow();
    }
  });

  it.each([
    ["cfgScale below 0", { cfgScale: -0.5 }, /cfgScale must be a number between 0 and 30/],
    ["cfgScale above 30", { cfgScale: 30.5 }, /cfgScale/],
    ["a non-numeric cfgScale", { cfgScale: "high" }, /cfgScale/],
    ["zero steps", { steps: 0 }, /steps must be an integer between 1 and 60/],
    ["steps above the 60 cost rail", { steps: 61 }, /steps/],
    ["fractional steps", { steps: 8.5 }, /steps/],
    ["a sampler outside Comfy's enum", { sampler: "euler_a" }, /sampler must be one of/],
    ["a scheduler outside Comfy's enum", { scheduler: "linear" }, /scheduler must be one of/],
    ["a 4K tier", { resolution: "4K" }, /resolution must be one of: 1K, 2K/],
    ["a pixel count in place of a tier", { resolution: 1024 }, /resolution/],
    ["a non-string negative prompt", { cfgScale: 2, negativePrompt: 42 }, /negative prompt must be a string/],
    ["a negative prompt past the shared 2000-character contract", { cfgScale: 2, negativePrompt: "d".repeat(2001) }, /2000 characters/],
    ["Klein's sampleMethod field", { sampleMethod: "euler" }, /unsupported control sampleMethod/],
    ["a snake_case negative prompt", { negative_prompt: "x" }, /unsupported control negative_prompt/],
    ["a fractional seed", { seed: 1.5 }, /seed must be a safe integer/],
    ["a LoRA strength above 4", { civitai_lora_version: "3400001", civitai_lora_strength: 4.5 }, /LoRA strength must be between 0 and 4/],
  ] as const)("refuses %s rather than clamping it", (_description, controlInput, message) => {
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, controlInput })).toThrow(message);
  });

  it("refuses an unsupported aspect, prompt, version, slug, or reference count", () => {
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, aspect: "21:9" })).toThrow(/aspect ratios 1:1, 4:3/);
    // Validated on edit too, although only create sends it.
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, aspect: "21:9" }, TWO_REFERENCES)).toThrow(/aspect ratios/);
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, prompt: "p".repeat(10_001) })).toThrow(/10000 characters/);
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, versionId: "4b" })).toThrow(/hosted 3352534 checkpoint/);
    expect(() => civitaiQwen21Workflow({ slug: "civitai/flux-2-klein-4b" }, request)).toThrow(/Unsupported Civitai image model/);
    const eleven = Array.from({ length: 11 }, (_unused, index) => `data:image/jpeg;base64,${String(index)}`);
    expect(() => civitaiQwen21Workflow(MODEL, request, eleven)).toThrow(/at most 10 reference images/);
    expect(() => civitaiQwen21Workflow(MODEL, request, eleven.slice(0, 10))).not.toThrow();
  });

  it("refuses a negative prompt at cfgScale 1 or below, where the model ignores it, and names the fix", () => {
    // Blank cfgScale resolves to the official 1, so a bare negative prompt is the
    // inert pair — the most likely way an operator reaches it.
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, controlInput: { negativePrompt: "blurry" } }))
      .toThrow(/ignores a negative prompt at cfgScale 1 or below; raise cfgScale above 1 or clear the negative prompt/);
    expect(() => civitaiQwen21Workflow(MODEL, { ...request, controlInput: { cfgScale: 0.5, negativePrompt: "blurry" } }))
      .toThrow(/raise cfgScale above 1/);
    // Blank is not a request for negative guidance: legal, and not sent.
    const blank = civitaiQwen21Workflow(MODEL, { ...request, controlInput: { negativePrompt: "   " } });
    expect(blank.steps[0].input).not.toHaveProperty("negativePrompt");
    const acting = civitaiQwen21Workflow(MODEL, { ...request, controlInput: { cfgScale: 1.5, negativePrompt: "blurry" } });
    expect(acting.steps[0].input.negativePrompt).toBe("blurry");
  });

  it("previews with placeholder references and an unresolved LoRA dependency, never the locator", () => {
    const preview = previewCivitaiQwen21Request(MODEL, {
      ...request,
      controlInput: {
        civitai_lora_version: "https://civitai.com/api/download/models/3400001?token=super-secret",
        civitai_lora_strength: 0.8,
      },
    }, 3);
    expect(preview).toMatchObject({
      externalId: "generated-for-each-request",
      loraAirResolution: { modelVersionId: "3400001", strength: 0.8 },
      steps: [{ input: {
        operation: "editImage",
        resolution: 1024,
        images: [
          "https://placeholder.invalid/reference-1",
          "https://placeholder.invalid/reference-2",
          "https://placeholder.invalid/reference-3",
        ],
        loras: {},
      } }],
    });
    expect(JSON.stringify(preview)).not.toContain("super-secret");
    expect(() => previewCivitaiQwen21Request(MODEL, request, 11)).toThrow(/zero to 10 reference images/);
  });

  it("reports a create's size and an edit's pixel budget as the sent shape", () => {
    expect(civitaiQwen21SentShape({ aspect: "3:2", controlInput: { resolution: "2K" }, referenceCount: 0 }))
      .toEqual({ field: "width,height", value: "2048x1344" });
    expect(civitaiQwen21SentShape({ aspect: null, referenceCount: 0 }))
      .toEqual({ field: "width,height", value: "1024x1024" });
    expect(civitaiQwen21SentShape({ aspect: "3:2", controlInput: { resolution: "2K" }, referenceCount: 2 }))
      .toEqual({ field: "resolution", value: 2048 });
  });
});

describe("Civitai Qwen Image 2.1 preflight echo", () => {
  const create = civitaiQwen21Workflow(MODEL, {
    ...request,
    controlInput: { seed: 42, cfgScale: 2.5, steps: 30, sampler: "dpmpp_2m", scheduler: "karras", negativePrompt: "blurry" },
  });
  const edit = civitaiQwen21Workflow(MODEL, request, TWO_REFERENCES, { [QWEN21_LORA_AIR]: 0.8 });

  it("admits a faithful echo, ignoring an edit's inferred width and height", () => {
    expect(validateCivitaiQwen21PreflightEcho(echoFor(create), create)).toBeNull();
    expect(validateCivitaiQwen21PreflightEcho(echoFor(edit), edit)).toBeNull();
  });

  it.each([
    ["a dropped negative prompt", "create", (input: Record<string, unknown>) => { delete input.negativePrompt; }, /negative prompt/],
    ["a changed sampler", "create", (input: Record<string, unknown>) => { input.sampler = "euler"; }, /field sampler/],
    ["a changed scheduler", "create", (input: Record<string, unknown>) => { input.scheduler = "simple"; }, /field scheduler/],
    ["a changed step count", "create", (input: Record<string, unknown>) => { input.steps = 25; }, /field steps/],
    ["a changed create size", "create", (input: Record<string, unknown>) => { input.width = 1216; }, /field width/],
    ["a changed seed", "create", (input: Record<string, unknown>) => { input.seed = 43; }, /seed/],
    ["the 20B engine", "create", (input: Record<string, unknown>) => { input.engine = "sdcpp"; }, /field engine/],
    ["another model on the lane", "create", (input: Record<string, unknown>) => { input.model = "20b"; }, /field model/],
    ["a missing LoRA key", "edit", (input: Record<string, unknown>) => { input.loras = {}; }, /LoRA AIR map/],
    ["a changed LoRA strength", "edit", (input: Record<string, unknown>) => { input.loras = { [QWEN21_LORA_AIR]: 1 }; }, /LoRA AIR map/],
    ["a changed image count", "edit", (input: Record<string, unknown>) => { input.images = TWO_REFERENCES.slice(0, 1); }, /reference-image count/],
    ["a changed edit pixel budget", "edit", (input: Record<string, unknown>) => { input.resolution = 2048; }, /field resolution/],
  ] as const)("refuses %s before the paid submit", (_description, operation, change, message) => {
    const expected = operation === "create" ? create : edit;
    expect(validateCivitaiQwen21PreflightEcho(echoFor(expected, change), expected)).toMatch(message);
  });
});

describe("Civitai Qwen Image 2.1 transport", () => {
  const references = [
    { bytes: Buffer.from("first"), mediaType: "image/jpeg", extension: "jpg" },
    { bytes: Buffer.from("second"), mediaType: "image/jpeg", extension: "jpg" },
  ];

  it("renders a prompt-only create at the defaults and claims no executed checkpoint", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const whatif = new URL(href).searchParams.get("whatif") === "true";
        return Response.json(echoOf(body, whatif ? "estimate-create" : "submit-create", whatif ? "unassigned" : "succeeded", [
          { id: "output.jpg", available: true },
        ]));
      }
      if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiQwen21ImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: true, predictionId: "submit-create", sentReferenceCount: 0 });
    expect(result.image?.toString()).toBe("image-bytes");
    // The echo names the lane, not a checkpoint, so nothing is claimed as run.
    expect(result).not.toHaveProperty("executedVersionId");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ steps: [{ input: { operation: "createImage", width: 1024, height: 1024, steps: 40 } }] });
  });

  it("sends a Qwen 2.1 LoRA as its AIR beside two references in the literal preflight body, then submits it unchanged", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      urls.push(href);
      if (href === "https://civitai.com/api/v1/model-versions/3400001") {
        return Response.json({ id: 3400001, baseModel: "Qwen 2.1", model: { type: "LORA" }, modelId: 3000001 });
      }
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const whatif = new URL(href).searchParams.get("whatif") === "true";
        return Response.json(echoOf(body, whatif ? "estimate-21" : "submit-21", whatif ? "unassigned" : "succeeded", [
          { id: "output.jpg", available: true },
        ]));
      }
      if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiQwen21ImageModel(MODEL, {
      ...request,
      controlInput: {
        seed: 9, cfgScale: 2, sampler: "dpmpp_2m", scheduler: "karras", negativePrompt: "blurry",
        civitai_lora_version: "3400001", civitai_lora_strength: 0.8,
      },
      references,
    });

    expect(result).toMatchObject({ ok: true, predictionId: "submit-21", sentReferenceCount: 2 });
    // Family gate first, then the free preflight, then the paid submit.
    expect(urls).toEqual([
      "https://civitai.com/api/v1/model-versions/3400001",
      expect.stringContaining("whatif=true"),
      expect.stringContaining("whatif=false"),
      blobUrl("output.jpg"),
    ]);
    const [preflight, submitted] = bodies;
    if (!preflight || !submitted) throw new Error("expected preflight and submitted workflow bodies");
    // The LoRA map and the reference count travel in ONE request — the fact the
    // preflight echo check then proves back before any Buzz moves.
    expect(preflight).toEqual({
      externalId: expect.any(String) as unknown,
      ...WORKFLOW_POLICY,
      steps: [{
        $type: "imageGen",
        input: {
          engine: "comfy",
          ecosystem: "qwen",
          model: "2.1",
          operation: "editImage",
          prompt: PROMPT,
          resolution: 1024,
          images: TWO_REFERENCES,
          quantity: 1,
          cfgScale: 2,
          steps: 40,
          sampler: "dpmpp_2m",
          scheduler: "karras",
          outputFormat: "jpeg",
          loras: { [QWEN21_LORA_AIR]: 0.8 },
          negativePrompt: "blurry",
          seed: 9,
        },
      }],
    });
    expect(preflight.externalId).not.toBe(submitted.externalId);
    expect({ ...preflight, externalId: "same" }).toEqual({ ...submitted, externalId: "same" });
  });

  it.each([
    [
      "a Qwen-Image 20B LoRA",
      { id: 3160956, baseModel: "Qwen", model: { type: "LORA" }, modelId: 2800001 },
      /Civitai LoRA 3160956 is a `Qwen` \(20B-family\) LoRA; the Civitai Qwen Image 2\.1 lane needs baseModel "Qwen 2\.1"; refusing before spend/,
    ],
    [
      "another family's LoRA",
      { id: 3160956, baseModel: "Flux.2 Klein 4B", model: { type: "LORA" }, modelId: 2800001 },
      /is a `Flux\.2 Klein 4B` LoRA; the Civitai Qwen Image 2\.1 lane needs baseModel "Qwen 2\.1"/,
    ],
    [
      "a checkpoint rather than a LoRA",
      { id: 3160956, baseModel: "Qwen 2.1", model: { type: "Checkpoint" }, modelId: 2800001 },
      /is a `Checkpoint` resource, not a LoRA; refusing before spend/,
    ],
    [
      "metadata for a different version",
      { id: 1, baseModel: "Qwen 2.1", model: { type: "LORA" }, modelId: 2800001 },
      /did not describe LoRA model version 3160956; refusing before spend/,
    ],
  ] as const)("refuses %s before any preflight or spend, naming what it is", async (_description, metadata, message) => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      urls.push(href);
      if (href === "https://civitai.com/api/v1/model-versions/3160956") return Response.json(metadata);
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiQwen21ImageModel(MODEL, {
      ...request,
      controlInput: { civitai_lora_version: "3160956", civitai_lora_strength: 1 },
      references,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
    // The provider accepts a 20B LoRA on this lane, so this read is the only
    // request that may happen: no what-if, no submit.
    expect(urls).toEqual(["https://civitai.com/api/v1/model-versions/3160956"]);
  });

  it("refuses an edit with a chosen output shape before any provider request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await runCivitaiQwen21ImageModel(MODEL, { ...request, aspect: "16:9", references });

    expect(result).toEqual({
      ok: false,
      error: "Civitai Qwen Image 2.1 sizes an edit from its reference; clear the output shape or remove the references",
    });
    // No preflight and no submit. (A selected LoRA's free metadata read runs
    // before the workflow is built, so this case selects none.)
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not submit when the preflight echoes a different sampler", async () => {
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const echo = echoOf(body, "estimate-drift", "unassigned");
      (echo.steps as [{ input: Record<string, unknown> }])[0].input.sampler = "euler";
      return Response.json(echo);
    });

    const result = await runCivitaiQwen21ImageModel(MODEL, { ...request, controlInput: { sampler: "dpmpp_2m" } });

    expect(result).toMatchObject({ ok: false, error: "Civitai preflight changed or omitted requested field sampler" });
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);
  });

  it("reports a resource Civitai has not enabled as resource_not_enabled, without its prose or a paid submit", async () => {
    const workflowUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href === "https://civitai.com/api/v1/model-versions/3400001") {
        return Response.json({ id: 3400001, baseModel: "Qwen 2.1", model: { type: "LORA" }, modelId: 3000001 });
      }
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      return Response.json({
        title: "One or more validation errors occurred.",
        errors: {
          messages: [
            "Private Qwen LoRA - v1.0 is not enabled for generation. Please contact support@civitai.com if you believe this to be an error.",
          ],
        },
      }, { status: 400 });
    });

    const result = await runCivitaiQwen21ImageModel(MODEL, {
      ...request,
      controlInput: { civitai_lora_version: "3400001", civitai_lora_strength: 0.8 },
      references,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_400; retry=never") as unknown });
    if (result.ok) throw new Error("expected the not-enabled preflight to fail");
    expect(result.error).toContain("reason=resource_not_enabled");
    expect(result.error).not.toContain("Private Qwen LoRA");
    expect(result.error).not.toContain("support@civitai.com");
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true")]);
  });
});
