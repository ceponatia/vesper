import { afterEach, describe, expect, it, vi } from "vitest";
import { imageModelSchema } from "@vesper/image-core";
import { CIVITAI_FLUX2_KLEIN4B_SLUG, FAL_QWEN3_EDIT_SLUG } from "@vesper/image-models";
import {
  DEFAULT_PREDICTION_TIMEOUT_MS,
  MAX_PREDICTION_TIMEOUT_MS,
  providerInputViolations,
} from "@vesper/image-replicate";
import { CIVITAI_KLEIN_LEGACY_VERSION_ID } from "./civitai-legacy-runtime";
import { CIVITAI_KLEIN_4B_VERSION_ID } from "./civitai-runtime";
import {
  disableSafetyChecker,
  hasReplicate,
  hasImageProviderForModel,
  providerInputRequest,
  previewImageModelRequest,
  qualifiedImageModelIdentity,
  replicateClient,
  resetReplicateRuntimeForTesting,
  resolveReplicateConfig,
} from "./replicate-runtime";

/**
 * Environment resolution is the APPLICATION's half of the Replicate split: the
 * transport package reads no `process.env` at all, so the rules for what an
 * unset, blank or nonsense variable means live here and are pinned here.
 *
 * `src/test/setup.ts` deletes the token for every application test, so each case
 * states the deployment it is about rather than inheriting one.
 */

const ENV_KEYS = [
  "REPLICATE_API_TOKEN",
  "REPLICATE_SAFE_MODE",
  "REPLICATE_PREDICTION_TIMEOUT_MS",
  "FAL_API_KEY",
  "CIVITAI_API_TOKEN",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetReplicateRuntimeForTesting();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetReplicateRuntimeForTesting();
});

describe("resolveReplicateConfig", () => {
  it("treats a missing or blank token as an unavailable provider", () => {
    withEnv({});
    expect(resolveReplicateConfig().apiToken).toBeNull();

    withEnv({ REPLICATE_API_TOKEN: "   " });
    expect(resolveReplicateConfig().apiToken).toBeNull();

    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    expect(resolveReplicateConfig().apiToken).toBe("r8_live");
  });

  it("keeps the safety checker on only for the exact string `true`", () => {
    // Every other value disables it, which is the controlled environment's
    // default and the behavior operators have today.
    withEnv({ REPLICATE_SAFE_MODE: "true" });
    expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(false);

    for (const value of ["false", "TRUE", "1", ""]) {
      withEnv({ REPLICATE_SAFE_MODE: value });
      expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(true);
    }

    withEnv({});
    expect(resolveReplicateConfig().safetyCheckerDisabled).toBe(true);
  });

  it("honours a sane prediction budget, clamps a huge one, and falls back otherwise", () => {
    withEnv({ REPLICATE_PREDICTION_TIMEOUT_MS: "900000" });
    expect(resolveReplicateConfig().predictionTimeoutMs).toBe(900_000);

    withEnv({ REPLICATE_PREDICTION_TIMEOUT_MS: "9999999999" });
    expect(resolveReplicateConfig().predictionTimeoutMs).toBe(MAX_PREDICTION_TIMEOUT_MS);

    // Below the 30s floor falls THROUGH to the default rather than clamping up —
    // an operator who wrote 5000 gets the five-minute default, which is the
    // behavior the transport had before the split.
    for (const value of [undefined, "not-a-number", "", "5000"]) {
      withEnv(value === undefined ? {} : { REPLICATE_PREDICTION_TIMEOUT_MS: value });
      expect(resolveReplicateConfig().predictionTimeoutMs).toBe(DEFAULT_PREDICTION_TIMEOUT_MS);
    }
  });
});

describe("the process runtime", () => {
  it("resolves once and reuses the same client", () => {
    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    const first = replicateClient();
    expect(replicateClient()).toBe(first);
    expect(hasReplicate()).toBe(true);
  });

  it("reports the deployment's posture through the same snapshot the payload uses", () => {
    // The fingerprint and the request must not be able to disagree: both read
    // this one client, so there is no second answer to give.
    withEnv({ REPLICATE_API_TOKEN: "r8_live", REPLICATE_SAFE_MODE: "true" });
    expect(disableSafetyChecker()).toBe(false);
    expect(replicateClient().safetyCheckerDisabled).toBe(false);

    withEnv({ REPLICATE_API_TOKEN: "r8_live" });
    expect(disableSafetyChecker()).toBe(true);
    expect(replicateClient().safetyCheckerDisabled).toBe(true);
  });

  it("reports an unconfigured deployment without any image-provider token", () => {
    withEnv({});
    expect(hasReplicate()).toBe(false);
    expect(replicateClient().configured).toBe(false);
  });
});

describe("provider-aware image routing", () => {
  const falModel = imageModelSchema.parse({
    id: "fal-edit",
    slug: FAL_QWEN3_EDIT_SLUG,
    label: "fal edit",
    canGenerate: false,
    canEdit: true,
  });
  const civitaiModel = imageModelSchema.parse({
    id: "civitai-klein",
    slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
    label: "Civitai Klein",
    canGenerate: true,
    canEdit: true,
    probedVersionId: CIVITAI_KLEIN_4B_VERSION_ID,
  });
  const legacyCivitaiModel = imageModelSchema.parse({
    id: "civitai-klein-legacy",
    slug: CIVITAI_FLUX2_KLEIN4B_SLUG,
    label: "Civitai Klein legacy",
    canGenerate: true,
    canEdit: false,
    probedVersionId: CIVITAI_KLEIN_LEGACY_VERSION_ID,
  });

  it("checks the credential for the selected model and qualifies its persisted identity", () => {
    withEnv({ FAL_API_KEY: "fal_live" });
    expect(hasImageProviderForModel(falModel)).toBe(true);
    expect(hasImageProviderForModel(civitaiModel)).toBe(false);
    expect(hasImageProviderForModel("owner/replicate-model")).toBe(false);
    expect(qualifiedImageModelIdentity(falModel)).toBe(`fal/${FAL_QWEN3_EDIT_SLUG}`);

    withEnv({ CIVITAI_API_TOKEN: "civitai_live" });
    expect(hasImageProviderForModel(civitaiModel)).toBe(true);
    expect(hasImageProviderForModel(falModel)).toBe(false);
    expect(qualifiedImageModelIdentity(civitaiModel)).toBe(`civitai/${CIVITAI_FLUX2_KLEIN4B_SLUG}`);
    expect(qualifiedImageModelIdentity(null)).toBe("replicate/none");
  });

  it("previews the same fal wire shape as send, with ordered placeholder references", () => {
    const preview = previewImageModelRequest({
      model: falModel,
      prompt: "change the jacket",
      referenceCount: 2,
      aspect: "3:4",
      controlInput: { image_size: "2K", seed: 7 },
    });
    expect(preview.request).toMatchObject({
      prompt: "change the jacket",
      image_size: { width: 1536, height: 2048 },
      seed: 7,
      image_urls: [
        "https://placeholder.invalid/reference-1",
        "https://placeholder.invalid/reference-2",
      ],
    });
    expect(preview.request).not.toHaveProperty("aspect_ratio");
    expect(preview.sentShape).toEqual({ field: "image_size", value: { width: 1536, height: 2048 } });
  });

  it("previews Civitai's v2 Klein workflow rather than a Replicate payload", () => {
    const preview = previewImageModelRequest({
      model: civitaiModel,
      prompt: "studio portrait",
      referenceCount: 2,
      aspect: "2:3",
      controlInput: {
        seed: 7,
        civitai_lora_version: "https://civitai.com/api/download/models/2633618?token=secret",
        civitai_lora_strength: 0.8,
      },
    });
    expect(preview.request).toMatchObject({
      allowMatureContent: true,
      currencies: ["yellow"],
      upgradeMode: "manual",
      loraAirResolution: { modelVersionId: "2633618", strength: 0.8 },
      steps: [{
        $type: "imageGen",
        input: {
          engine: "flux2",
          model: "klein",
          modelVersion: "4b",
          operation: "editImage",
          prompt: "studio portrait",
          width: 832,
          height: 1248,
          seed: 7,
          images: [
            "https://placeholder.invalid/reference-1",
            "https://placeholder.invalid/reference-2",
          ],
        },
      }],
    });
    expect(JSON.stringify(preview.request)).not.toContain("secret");
    expect(preview.sentShape).toEqual({ field: "width,height", value: "832x1248" });
  });

  it("passes Civitai v2's nested required prompt to the generic descriptor gate", () => {
    const preview = previewImageModelRequest({
      model: civitaiModel,
      prompt: "studio portrait",
      referenceCount: 0,
      aspect: "1:1",
    });

    const descriptorModel = imageModelSchema.parse({
      ...civitaiModel,
      advancedCapabilities: {
        ...civitaiModel.advancedCapabilities,
        providerInputs: [{ field: "prompt", type: "string", required: true, reserved: true }],
      },
    });
    const providerInput = providerInputRequest(descriptorModel, preview.request);

    expect(providerInput).toMatchObject({
      prompt: "studio portrait",
      model: "klein",
      modelVersion: "4b",
    });
    // `steps` is the image generator's sampling count here. The workflow
    // envelope instead owns `steps: [{ input: ... }]`, plus these top-level
    // payment/request fields.
    expect(providerInput["steps"]).toBe(20);
    expect(providerInput).not.toHaveProperty("allowMatureContent");
    expect(providerInput).not.toHaveProperty("externalId");
    expect(providerInputViolations(descriptorModel, providerInput)).toEqual([]);
    expect(providerInputViolations(descriptorModel, preview.request)).toEqual([
      expect.objectContaining({ field: "prompt", reason: "required_missing" }),
    ]);
  });

  it("keeps the captured legacy preview on Civitai's text-only website graph", () => {
    const preview = previewImageModelRequest({
      model: legacyCivitaiModel,
      prompt: "adult studio portrait",
      referenceCount: 0,
      aspect: "2:3",
      controlInput: { seed: 7 },
    });

    expect(preview.request).toEqual({
      workflow: "txt2img",
      ecosystem: "Flux2Klein_4B",
      prompt: "adult studio portrait",
      quantity: 1,
      aspectRatio: "2:3",
      model: { id: 2612557 },
      seed: 7,
    });
    expect(preview.sentShape).toEqual({ field: "aspectRatio", value: "2:3" });
    expect(() => previewImageModelRequest({
      model: legacyCivitaiModel,
      prompt: "adult studio portrait",
      referenceCount: 1,
      aspect: "2:3",
    })).toThrow(/text-to-image generation only on its legacy version/i);
  });

  it("refuses a request whose captured Civitai version does not match before any provider call", async () => {
    withEnv({ CIVITAI_API_TOKEN: "civitai_live" });
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await replicateClient().runRegistryImageModel(civitaiModel, {
      prompt: "studio portrait",
      versionId: CIVITAI_KLEIN_LEGACY_VERSION_ID,
    });

    expect(result).toEqual({ ok: false, error: "Civitai request version does not match its captured catalog version" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatches the legacy capture to Civitai's website graph and the 4b capture to v2", async () => {
    withEnv({ CIVITAI_API_TOKEN: "civitai_live" });
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/api/trpc/orchestrator.whatIfFromGraph")) {
        return Response.json({ result: { data: { json: { ready: false, modelSubstitutions: [] } } } });
      }
      if (href.includes("/v2/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as {
          allowMatureContent: boolean;
          currencies: string[];
          upgradeMode: string;
          steps: { input: Record<string, unknown> }[];
        };
        const step = body.steps[0];
        if (!step) throw new Error("expected Civitai v2 image step");
        return Response.json({
          id: "estimate-insufficient",
          status: "unassigned",
          allowMatureContent: body.allowMatureContent,
          currencies: body.currencies,
          upgradeMode: body.upgradeMode,
          transactions: { insufficientBuzz: true },
          steps: [{ $type: "imageGen", input: { ...step.input, modelVariant: "klein" }, output: { images: [] } }],
        });
      }
      throw new Error(`unexpected Civitai URL: ${href}`);
    });

    const legacy = await replicateClient().runRegistryImageModel(legacyCivitaiModel, {
      prompt: "adult studio portrait",
      aspect: "2:3",
      versionId: CIVITAI_KLEIN_LEGACY_VERSION_ID,
    });
    const current = await replicateClient().runRegistryImageModel(civitaiModel, {
      prompt: "adult studio portrait",
      aspect: "2:3",
      versionId: CIVITAI_KLEIN_4B_VERSION_ID,
    });

    expect(legacy).toMatchObject({ ok: false, error: expect.stringMatching(/not currently generatable/i) });
    expect(current).toMatchObject({ ok: false, error: expect.stringMatching(/insufficient yellow Buzz/i) });
    expect(urls).toHaveLength(2);

    const legacyUrl = new URL(urls[0] ?? "");
    expect(legacyUrl.pathname).toBe("/api/trpc/orchestrator.whatIfFromGraph");
    expect(JSON.parse(legacyUrl.searchParams.get("input") ?? "{}")).toEqual({
      json: {
        workflow: "txt2img",
        ecosystem: "Flux2Klein_4B",
        quantity: 1,
        aspectRatio: "2:3",
        model: { id: 2612557 },
      },
    });
    expect(urls[1]).toContain("https://orchestration.civitai.com/v2/consumer/workflows?whatif=true&wait=0");
  });
});
