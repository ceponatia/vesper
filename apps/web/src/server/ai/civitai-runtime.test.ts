import { afterEach, describe, expect, it, vi } from "vitest";
import { civitaiAsyncFailure } from "./civitai-errors";
import { classifyImageFailureMessage, declaresNonAutomaticRetry, declaresSpentProviderWork, imageModelSchema, type ImageModel } from "@vesper/image-core";
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
  civitaiWorkflowPostTimeoutMs,
  parseCivitaiWorkflow,
  previewCivitaiKleinRequest,
  recoverCivitaiOutput,
  runCivitaiKleinImageModel,
  validateCivitaiKleinRequest,
  validateCivitaiPreflightEcho,
} from "./civitai-runtime";
import { withPaidRenderOutputRecorder, type PaidRenderOutput } from "./paid-render-output";

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

/**
 * A read-only workflow-list GET: present whenever `whatif` is absent from
 * the query string. Hoisted to module scope (second correction round, #673)
 * so every test can tell the lost-answer lookup's GET apart from the
 * preflight/submit POSTs BEFORE touching `init.body` — the lookup has none,
 * and `JSON.parse`-ing it unconditionally throws.
 */
function isLookupGet(href: string): boolean {
  return href.includes("/consumer/workflows?") && new URL(href).searchParams.get("whatif") === null;
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

    // The prompt is compared verbatim too: a normalized or truncated prompt in
    // the zero-Buzz answer must refuse the paid submit rather than pass through.
    const reworded = workflowFrom(sent, "estimate", "unassigned");
    (reworded.steps as [{ input: Record<string, unknown> }])[0].input.prompt = `${request.prompt}, rewritten`;
    expect(validateCivitaiPreflightEcho(parseCivitaiWorkflow(reworded), expected)).toMatch(/field prompt/);
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

/**
 * PROTECTS (#680): the preflight and the paid submit share ONE per-attempt
 * POST budget, scaled to the body's own reference count rather than a flat
 * constant. This table pins the pure function directly; the end-to-end cases
 * below and in civitai-qwen21-runtime.test.ts (which can exercise more than
 * Klein's own 2-reference cap) prove the transport actually uses it.
 */
describe("Civitai workflow POST budget (#680)", () => {
  it.each([
    [0, 120_000],
    [1, 160_000],
    [4, 280_000],
    // The cap (owner ruling 2026-10-02) binds from 5 references, not 10: the
    // linear formula alone would reach 320_000 there, above Node fetch's
    // (undici) 300 s default header/body timeout.
    [5, 290_000],
    [10, 290_000], // Qwen 2.1's own MAX_REFERENCES — still capped.
    [11, 290_000], // one count above that maximum — still capped.
  ] as const)("gives a body carrying %i reference image(s) a %i ms per-attempt budget", (referenceCount, expectedMs) => {
    expect(civitaiWorkflowPostTimeoutMs(referenceCount)).toBe(expectedMs);
  });

  it("floors a non-integer count and clamps a negative or non-finite one to zero, rather than refusing", () => {
    expect(civitaiWorkflowPostTimeoutMs(2.9)).toBe(civitaiWorkflowPostTimeoutMs(2));
    expect(civitaiWorkflowPostTimeoutMs(-5)).toBe(civitaiWorkflowPostTimeoutMs(0));
    expect(civitaiWorkflowPostTimeoutMs(Number.NaN)).toBe(civitaiWorkflowPostTimeoutMs(0));
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

  it("does not retry a 404 LoRA metadata read, so no what-if or submit ever follows", async () => {
    // #672 regression: requestJson's retry gate now checks
    // civitaiRetryableStatus(status) directly instead of reading back
    // civitaiHttpFailure's computed `retry` field. A 404 sits outside the
    // 429/5xx retryable band, so this GET — made before any preflight or
    // spend — must still fail on its first attempt, the same as before the
    // refactor that introduced the preflight's own retry.
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("/model-versions/2633618")) return new Response("not found", { status: 404 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, {
      ...request,
      controlInput: {
        seed: 1234,
        [CIVITAI_LORA_VERSION_FIELD]: "2633618",
        [CIVITAI_LORA_STRENGTH_FIELD]: 0.75,
      },
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_404; retry=never") });
    expect(urls).toEqual(["https://civitai.com/api/v1/model-versions/2633618"]);
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

  it("stops transient workflow-status retries after the bounded third read, reporting reconcile rather than automatic (#673)", async () => {
    // Pre-#673 this read's exhausted disposition was `retry=automatic`,
    // worded "temporarily unavailable" — which `classifyImageFailureMessage`
    // read as transient and let `executeSceneChain` rerun the rung, sending
    // a SECOND paid submit while the first, already billed, might still
    // finish (the "Related double-spend path" issue comment on #673). A
    // workflow-status read only ever runs once a submit already exists, so
    // it now reports `reconcile` instead.
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
    expect(result).toMatchObject({ ok: false, predictionId: "submit-exhausted", error: expect.stringContaining("civitai_http_503; retry=reconcile") });
    if (result.ok) throw new Error("expected the exhausted workflow-status read to fail");
    if (result.error === undefined) throw new Error("expected the exhausted workflow-status read to carry an error");
    expect(result.error).toContain("paths=steps[0].input.resolution");
    expect(result.error).not.toContain("private");
    expect(result.error).not.toContain("secret");
    expect(classifyImageFailureMessage(result.error)).not.toBe("transient");
    // Third correction round (#673 / Codex on PR #684): this CivitaiError
    // already declares `retry=reconcile` on its own, so runCivitaiLane's
    // outer catch must not also append the fixed "was already submitted"
    // sentence — that would be redundant, never safer.
    expect(result.error).not.toContain("was already submitted");
  });

  /**
   * PROTECTS (third correction round, #673 / Codex on PR #684): a plain
   * `Error` thrown once a workflow id exists carries no `retry=` marker of
   * its own, so the selfie retry's own guard (`declaresNonAutomaticRetry`)
   * would otherwise mistake it for an ordinary failure and repost a SECOND
   * paid submit. `runCivitaiLane`'s outer catch appends a fixed reconcile
   * sentence naming the id whenever `predictionId` is set and the thrown
   * message does not already declare a disposition.
   */
  it("names the workflow id and declares reconcile when polling returns a different workflow", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-swap" : "submit-swap", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-swap")) {
        return Response.json({
          id: "submit-swap-impostor", status: "processing", allowMatureContent: true,
          currencies: ["yellow"], upgradeMode: "manual", transactions: { insufficientBuzz: false },
          steps: [{ $type: "imageGen", input: {}, output: {} }],
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, predictionId: "submit-swap" });
    if (result.ok) throw new Error("expected the workflow-id mismatch to fail");
    if (result.error === undefined) throw new Error("expected the workflow-id mismatch to carry an error");
    expect(result.error).toBe(
      "Civitai returned a different workflow while polling Civitai workflow submit-swap was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.",
    );
    expect(declaresNonAutomaticRetry(result.error)).toBe(true);
    expect(classifyImageFailureMessage(result.error)).not.toBe("transient");
  });

  it("names the workflow id and declares reconcile when the mature/yellow retention check fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") return Response.json(workflowFrom(body, "estimate-retention", "unassigned"));
      const submitted = workflowFrom(body, "submit-retention", "succeeded", [{ id: "output.jpg", available: true }]);
      // The submit's own terminal answer silently dropped mature permission
      // — the retention check's own failure mode, independent of the
      // lost-answer lookup.
      submitted.allowMatureContent = false;
      return Response.json(submitted);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, predictionId: "submit-retention" });
    if (result.ok) throw new Error("expected the retention check to fail");
    if (result.error === undefined) throw new Error("expected the retention check to carry an error");
    expect(result.error).toBe(
      "Civitai workflow did not retain mature-content permission and yellow-only payment Civitai workflow submit-retention was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.",
    );
    expect(declaresNonAutomaticRetry(result.error)).toBe(true);
    expect(classifyImageFailureMessage(result.error)).not.toBe("transient");
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
    // Vesper's own deadline cut the retry short, not a provider verdict: the
    // billed workflow may still finish, so it reconciles (see below).
    expect(result).toMatchObject({ ok: false, predictionId: "submit-deadline", error: expect.stringContaining("civitai_async_timeout; retry=reconcile") });
    if (result.ok) throw new Error("expected the expired status retry to time out");
    expect(result.error).not.toContain("secret");
  });

  /**
   * PROTECTS: Vesper's OWN poll deadline running out on a submitted, billed
   * workflow declares `retry=reconcile` at `workflow_status` — Vesper only
   * stopped watching, and the workflow may still finish and bill (one
   * measured run succeeded 90 s after a 300 s local deadline). The bad
   * implementation reports it as the provider's own `retry=deliberate`
   * expiry, whose disposition suppresses the post-submit reconcile sentence,
   * so the scene chain's paid stop (`declaresSpentProviderWork`) never fires
   * and the next rung pays for a second render while the first may still
   * deliver.
   */
  it("reports its own poll deadline on a submitted workflow as reconcile, never as the provider's deliberate expiry", async () => {
    vi.useFakeTimers();
    let workflowPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        workflowPosts += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-slow" : "submit-slow", whatif === "true" ? "unassigned" : "processing"));
      }
      if (href.endsWith("/submit-slow")) {
        return Response.json({ id: "submit-slow", status: "processing", steps: [{ $type: "imageGen", input: {}, output: {} }] });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, { ...request, timeoutMs: 1 });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(workflowPosts).toBe(2);
    if (result.ok) throw new Error("expected the local poll deadline to end the render");
    expect(result.predictionId).toBe("submit-slow");
    expect(result.error).toContain("Civitai workflow status failed (civitai_async_timeout; retry=reconcile)");
    expect(declaresSpentProviderWork(result.error ?? "")).toBe(true);
  });

  it("keeps a timeout Civitai itself reports as the deliberate terminal expiry", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-expired" : "submit-expired", whatif === "true" ? "unassigned" : "expired"));
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    if (result.ok) throw new Error("expected the provider's expiry to fail the render");
    expect(result.predictionId).toBe("submit-expired");
    expect(result.error).toContain("Civitai workflow terminal failed (civitai_async_timeout; retry=deliberate)");
    expect(declaresSpentProviderWork(result.error ?? "")).toBe(false);
  });

  it("retries a transient preflight exactly once, then still posts the paid submission only once", async () => {
    // #672: the preflight gets ONE automatic repeat after a transient failure;
    // the paid submit's behavior is unchanged by that change and still gets
    // none.
    vi.useFakeTimers();
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

    const preflightPending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const preflightFailure = await preflightPending;
    expect(preflightFailure).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_503; retry=deliberate") });
    if (preflightFailure.ok) throw new Error("expected the repeated preflight failure to fail");
    expect(preflightFailure.error).toContain("already reposted this preflight once automatically");
    expect(preflightFailure.error).not.toContain("read retries");
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true"), expect.stringContaining("whatif=true")]);

    // #673: a 503 on the paid submit is now an UNKNOWN outcome that triggers
    // the read-only lost-answer lookup (settle delay, then a bounded GET)
    // rather than failing immediately, so this phase must drive the call
    // through fake-timer advancement and must answer the lookup's GET
    // (which carries no body) before touching `init.body`.
    phase = "submit";
    const paidPosts: string[] = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      if (isLookupGet(href)) return Response.json({ items: [], next: null });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") return Response.json(workflowFrom(body, "estimate-post", "unassigned"));
      paidPosts.push(href);
      return Response.json({ detail: "prompt=private" }, { status: 503 });
    });

    const submitPending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const submitFailure = await submitPending;
    expect(submitFailure).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
    if (submitFailure.ok) throw new Error("expected the submit failure to fail");
    expect(submitFailure.error).toContain("civitai_http_503");
    expect(submitFailure.error).not.toContain("already reposted");
    // The invariant this test exists to protect: still exactly one paid POST.
    expect(paidPosts).toHaveLength(1);
  });

  /**
   * PROTECTS (#673): a submit whose own answer Vesper could not read is
   * looked up read-only, by its own externalId, across the workflow list —
   * never by reposting the paid workflow. These cases cover item 2's three
   * "unknown outcome" triggers (transport failure, HTTP 5xx, an unparsable
   * 2xx body) and item 2's "known not accepted" exclusion (429/4xx), plus
   * the adopt-vs-unconfirmed and readable-vs-unreadable outcomes.
   */
  describe("Civitai Klein v2 lost-submit-answer lookup (#673)", () => {
    it.each(["fetch", "response text"] as const)(
      "adopts the workflow the lookup finds, polls and downloads it, after a thrown transport %s failure — still exactly one paid POST",
      async (sentinel) => {
        // #672 regression guard, carried forward: requestJson's transport-catch
        // retry gate for the submit stage is still just `attempt < maxRetries`
        // with `maxRetries` 0, so a widened gate that reposted the PAID
        // submission would show up here as more than one `whatif=false` POST.
        vi.useFakeTimers();
        const paidPosts: string[] = [];
        const lookupGets: string[] = [];
        let submitExternalId = "";
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          const href = String(url);
          if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
          if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
          if (isLookupGet(href)) {
            lookupGets.push(href);
            return Response.json({
              items: [{
                id: "adopted-workflow",
                externalId: `5910720-${submitExternalId}`,
                status: "succeeded",
                allowMatureContent: true,
                currencies: ["yellow"],
                upgradeMode: "manual",
                transactions: { insufficientBuzz: false },
                steps: [{ $type: "imageGen", input: {}, output: { images: [{ id: "output.jpg", available: true }] } }],
              }],
              next: null,
            });
          }
          const whatif = new URL(href).searchParams.get("whatif");
          if (whatif === "true") {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
          }
          paidPosts.push(href);
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          submitExternalId = body.externalId as string;
          if (sentinel === "fetch") throw new Error("provider token=secret prompt=private");
          const response = Response.json({ id: "unused" });
          vi.spyOn(response, "text").mockRejectedValue(new Error("provider token=secret prompt=private"));
          return response;
        });

        const pending = runCivitaiKleinImageModel(MODEL, request);
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(paidPosts).toHaveLength(1);
        expect(lookupGets.length).toBeGreaterThanOrEqual(1);
        expect(result).toMatchObject({ ok: true, predictionId: "adopted-workflow" });
        if (!result.ok) throw new Error("expected the adopted workflow to succeed");
        expect(result.image?.toString()).toBe("image-bytes");
      },
    );

    /**
     * PROTECTS (test gap, second correction round, #673): adoption must
     * resume the ORDINARY poll on the ADOPTED id, not the submit's own
     * (never-confirmed) one — a still-`processing` adopted workflow has to
     * keep being polled by `GET /workflows/{adopted id}` until it reaches a
     * terminal status, exactly as an ordinary submit-confirmed workflow
     * would be.
     */
    it("polls a still-pending adopted workflow by its own id until it succeeds", async () => {
      vi.useFakeTimers();
      let submitExternalId = "";
      let statusReads = 0;
      const statusUrls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
        if (href.includes("/consumer/workflows?")) {
          if (isLookupGet(href)) {
            return Response.json({
              items: [{
                id: "adopted-pending",
                externalId: `5910720-${submitExternalId}`,
                status: "processing",
                allowMatureContent: true,
                currencies: ["yellow"],
                upgradeMode: "manual",
                transactions: { insufficientBuzz: false },
                steps: [{ $type: "imageGen", input: {}, output: {} }],
              }],
              next: null,
            });
          }
          const whatif = new URL(href).searchParams.get("whatif");
          if (whatif === "true") {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
          }
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          submitExternalId = body.externalId as string;
          throw new Error("provider token=secret prompt=private");
        }
        if (href.endsWith("/adopted-pending")) {
          statusUrls.push(href);
          statusReads += 1;
          if (statusReads === 1) {
            return Response.json({
              id: "adopted-pending", status: "processing", allowMatureContent: true,
              currencies: ["yellow"], upgradeMode: "manual", transactions: { insufficientBuzz: false },
              steps: [{ $type: "imageGen", input: {}, output: {} }],
            });
          }
          return Response.json({
            id: "adopted-pending", status: "succeeded", allowMatureContent: true,
            currencies: ["yellow"], upgradeMode: "manual", transactions: { insufficientBuzz: false },
            steps: [{ $type: "imageGen", input: {}, output: { images: [{ id: "output.jpg", available: true }] } }],
          });
        }
        throw new Error(`Unexpected fetch ${href}`);
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(statusReads).toBe(2);
      expect(statusUrls.every((url) => url.endsWith("/adopted-pending"))).toBe(true);
      expect(result).toMatchObject({ ok: true, predictionId: "adopted-pending" });
      if (!result.ok) throw new Error("expected the adopted-then-polled workflow to succeed");
      expect(result.image?.toString()).toBe("image-bytes");
    });

    it("throws civitai_submit_unconfirmed naming the externalId and the original code when the lookup never finds the workflow, after exactly one paid POST", async () => {
      vi.useFakeTimers();
      const paidPosts: string[] = [];
      let lookupRounds = 0;
      let submitExternalId = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupRounds += 1;
          return Response.json({ items: [], next: null });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        paidPosts.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        submitExternalId = body.externalId as string;
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(paidPosts).toHaveLength(1);
      expect(lookupRounds).toBe(2);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed; retry=deliberate") });
      if (result.ok) throw new Error("expected the unconfirmed submit to fail");
      expect(result.predictionId).toBeUndefined();
      expect(result.error).toContain("civitai_transport_failure");
      expect(result.error).toContain(submitExternalId);
      expect(result.error).toContain("no workflow in the list carried this externalId after 2 lookup rounds");
      expect(result.error).not.toContain("secret");
      expect(result.error).not.toContain("private");
    });

    it.each([
      ["a 5xx submit", () => Response.json({ detail: "prompt=private" }, { status: 503 }), "civitai_http_503", undefined],
      ["a malformed 2xx submit", () => new Response("not json", { status: 200 }), "civitai_malformed_response", undefined],
      // Distinct from both rows above: a 2xx body that IS valid JSON -- so
      // `requestJson` returns it with no throw of its own -- but is not a
      // usable workflow shape (no `status`), so `parseCivitaiWorkflow` throws
      // a plain `Error`, never a `CivitaiError`. This is the only path that
      // exercises the catch block's `instanceof CivitaiError` fallback to
      // `civitai_submit_response_invalid`, and the only path proving a
      // non-CivitaiError thrown here still reaches the lookup rather than
      // skipping it -- `isDefinitelyRejectedSubmit` requires a CivitaiError
      // with an httpStatus, so a bug that let a bare Error through
      // unconditionally (or crashed deriving its code) would leave this
      // submit a silent orphan instead of naming the workflow (#673). Its
      // body DOES carry an id, so unlike the two rows above — whose own
      // responses never resolve to anything with an id — this is also the
      // case that proves the pre-#673 contract (second correction round):
      // predictionId is set from that raw id BEFORE the parse that fails,
      // and survives all the way through the lookup giving up too.
      ["a 2xx submit whose valid-JSON body is not a usable workflow", () => Response.json({ id: "shapeless" }), "civitai_submit_response_invalid", "shapeless"],
    ] as const)("leads to a lookup after %s, naming that code once the lookup gives up", async (_description, submitResponse, originalCode, expectedPredictionId) => {
      vi.useFakeTimers();
      const paidPosts: string[] = [];
      let lookupRounds = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupRounds += 1;
          return Response.json({ items: [], next: null });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        paidPosts.push(href);
        return submitResponse();
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(paidPosts).toHaveLength(1);
      expect(lookupRounds).toBe(2);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the lookup to give up");
      expect(result.error).toContain(originalCode);
      expect(result.predictionId).toBe(expectedPredictionId);
    });

    it.each([429, 400, 404])(
      "never looks up the workflow list after an HTTP %i submit, which already proves Civitai rejected it",
      async (status) => {
        let paidPosts = 0;
        let lookupCalls = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          const href = String(url);
          if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
          if (isLookupGet(href)) {
            lookupCalls += 1;
            return Response.json({ items: [], next: null });
          }
          const whatif = new URL(href).searchParams.get("whatif");
          if (whatif === "true") {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json(workflowFrom(body, "estimate-rejected", "unassigned"));
          }
          paidPosts += 1;
          return Response.json({ detail: "prompt=private" }, { status });
        });

        const result = await runCivitaiKleinImageModel(MODEL, request);

        expect(paidPosts).toBe(1);
        expect(lookupCalls).toBe(0);
        expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`civitai_http_${String(status)}`) });
        if (result.ok) throw new Error("expected the rejected submit to fail");
        expect(result.predictionId).toBeUndefined();
      },
    );

    it("reports the lookup as unreadable, not merely absent, when every round's own read fails", async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) throw new Error("provider token=secret prompt=private");
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the unreadable lookup to fail");
      expect(result.error).toContain("the lookup itself could not be read");
      expect(result.error).not.toContain("no workflow in the list carried this externalId");
      expect(result.error).not.toContain("secret");
      expect(result.error).not.toContain("private");
    });

    /**
     * PROTECTS (second correction round, #673): a list item that MATCHES the
     * externalId suffix must be treated as FOUND even if its shape then
     * fails `parseCivitaiWorkflow` — the round's own try/catch must not
     * swallow that parse failure as "this round's read failed", which would
     * misreport `civitai_submit_unconfirmed` ("no workflow carries this
     * key") for a key a workflow demonstrably DOES carry. The found id must
     * also still reach `predictionId`, matching the pre-#673 behavior for an
     * ordinary 2xx submit body that carried an id but failed to parse.
     */
    it("surfaces a parse failure on a found workflow with its id attached, never as civitai_submit_unconfirmed", async () => {
      vi.useFakeTimers();
      const paidPosts: string[] = [];
      let submitExternalId = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          return Response.json({
            items: [{
              id: "found-but-broken",
              externalId: `5910720-${submitExternalId}`,
              status: "not-a-real-status",
            }],
            next: null,
          });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        paidPosts.push(href);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        submitExternalId = body.externalId as string;
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(paidPosts).toHaveLength(1);
      expect(result).toMatchObject({ ok: false, predictionId: "found-but-broken" });
      if (result.ok) throw new Error("expected the found-but-unparseable workflow to fail");
      if (result.error === undefined) throw new Error("expected the found-but-unparseable workflow to carry an error");
      expect(result.error).not.toContain("civitai_submit_unconfirmed");
      // Third correction round (#673 / Codex on PR #684): this plain Error
      // carries no `retry=` marker of its own, so runCivitaiLane's outer
      // catch appends the fixed reconcile sentence, naming the FOUND id —
      // which is what keeps the selfie retry's own guard
      // (`declaresNonAutomaticRetry`) from reposting a second paid submit
      // over a workflow that was found, just not parseable.
      expect(result.error).toBe(
        "Civitai workflow lookup returned an invalid workflow identity or status Civitai workflow found-but-broken was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.",
      );
      expect(declaresNonAutomaticRetry(result.error)).toBe(true);
      expect(classifyImageFailureMessage(result.error)).not.toBe("transient");
    });

    it("follows the list's next cursor within one round to find a match on a later page", async () => {
      vi.useFakeTimers();
      const lookupUrls: string[] = [];
      const cursorsSeen: (string | null)[] = [];
      let submitExternalId = "";
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupUrls.push(href);
          const cursor = new URL(href).searchParams.get("cursor");
          cursorsSeen.push(cursor);
          if (cursor === null) return Response.json({ items: [{ id: "other", externalId: "5910720-not-this-one" }], next: "page-2" });
          return Response.json({
            items: [{
              id: "adopted-page-2", externalId: `5910720-${submitExternalId}`, status: "succeeded",
              allowMatureContent: true, currencies: ["yellow"], upgradeMode: "manual",
              transactions: { insufficientBuzz: false },
              steps: [{ $type: "imageGen", input: {}, output: { images: [{ id: "output.jpg", available: true }] } }],
            }],
            next: null,
          });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        submitExternalId = body.externalId as string;
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(lookupUrls).toHaveLength(2);
      expect(cursorsSeen).toEqual([null, "page-2"]);
      expect(result).toMatchObject({ ok: true, predictionId: "adopted-page-2" });
    });

    it("bounds one round's pagination at the page cap, and names that cap in the failure", async () => {
      vi.useFakeTimers();
      let lookupGets = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupGets += 1;
          // Never carries a match and never stops offering another page.
          return Response.json({ items: [], next: `cursor-${String(lookupGets)}` });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      // 2 rounds * the page cap, never more, despite `next` always being present.
      expect(lookupGets).toBe(2 * 3);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the capped pagination to still give up");
      expect(result.error).toContain("no workflow in the list carried this externalId after 2 lookup rounds");
      // Both rounds DID read successfully (just capped), so the message must
      // not claim a partial search — only that the cap, not absence, is what
      // ended each round (second correction round, #673).
      expect(result.error).not.toContain("that could be read");
      expect(result.error).toContain("the list was only searched up to its page cap");
    });

    it("counts only rounds that actually read successfully, and says so when some did not", async () => {
      // Round 1's read fails outright (unreadable): requestJson's own
      // bounded GET retry exhausts after 3 attempts (1 initial + 2 retries,
      // MAX_GET_RETRIES), so the first 3 lookup fetches must all throw before
      // round 2's first attempt can succeed. Round 2 then reads cleanly and
      // finds nothing. roundsSearched must be 1, not the configured 2, and
      // the message must say the round that WAS read, qualified as such —
      // never silently inflated to "2 lookup rounds" (second correction
      // round, #673).
      vi.useFakeTimers();
      let lookupAttempts = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupAttempts += 1;
          if (lookupAttempts <= 3) throw new Error("provider token=secret prompt=private");
          return Response.json({ items: [], next: null });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the partially-unreadable lookup to fail");
      expect(result.error).toContain("1 lookup round that could be read");
      expect(result.error).not.toContain("the lookup itself could not be read");
      expect(result.error).not.toContain("2 lookup round");
    });

    it("pins the lookup URL's tags, fromDate, take, and hideMatureContent", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const lookupUrls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupUrls.push(href);
          return Response.json({ items: [], next: null });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      await pending;

      expect(lookupUrls.length).toBeGreaterThan(0);
      const first = lookupUrls[0];
      if (!first) throw new Error("expected at least one lookup URL");
      const params = new URL(first).searchParams;
      expect(params.get("tags")).toBe("vesper");
      expect(params.get("take")).toBe("100");
      expect(params.get("hideMatureContent")).toBe("false");
      // The preflight and submit POSTs resolve without any real or faked
      // delay in this mock, so the submit still starts at the pinned system
      // time; fromDate is that time minus the clock-skew margin.
      expect(params.get("fromDate")).toBe(new Date(Date.parse("2026-01-01T00:00:00.000Z") - 5 * 60 * 1000).toISOString());
    });

    /**
     * PROTECTS (third correction round, #673 / Codex on PR #684): a list
     * response this process cannot actually interpret must count as
     * UNREADABLE, never as a clean "searched, this page carried no match" —
     * coercing a missing/non-array `items` or a malformed `next` to an
     * empty result would misreport the search as more thorough than it was.
     */
    it.each([
      ["a body with no items array", { foo: "bar" }],
      ["a non-array items field", { items: "x" }],
      ["a non-string, non-nullish next", { items: [], next: 5 }],
    ] as const)("treats %s as an unreadable round, not a clean search", async (_description, malformedBody) => {
      vi.useFakeTimers();
      let lookupRounds = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupRounds += 1;
          return Response.json(malformedBody);
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(lookupRounds).toBe(2);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the malformed envelope to be treated as unreadable");
      if (result.error === undefined) throw new Error("expected an error message");
      expect(result.error).toContain("the lookup itself could not be read");
      expect(result.error).not.toContain("no workflow in the list carried this externalId");
    });

    /**
     * PROTECTS: the provider's OpenAPI marks `next` required, but a live
     * probe (2026-10-01, zero Buzz) found the LAST page omits the key
     * entirely. That omission must stay the ordinary end-of-list reading —
     * a round that read it counts as searched, not unreadable.
     */
    it("treats a body with no `next` key as a clean end of the list, not malformed", async () => {
      vi.useFakeTimers();
      let lookupRounds = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
        if (isLookupGet(href)) {
          lookupRounds += 1;
          return Response.json({ items: [] });
        }
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "true") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json(workflowFrom(body, "estimate-lost", "unassigned"));
        }
        throw new Error("provider token=secret prompt=private");
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(lookupRounds).toBe(2);
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_submit_unconfirmed") });
      if (result.ok) throw new Error("expected the omitted-next body to end the search cleanly");
      if (result.error === undefined) throw new Error("expected an error message");
      expect(result.error).toContain("no workflow in the list carried this externalId after 2 lookup rounds");
      expect(result.error).not.toContain("the lookup itself could not be read");
      expect(result.error).not.toContain("that could be read");
    });
  });

  it.each([429, 503])("recovers a preflight that fails once with HTTP %i by reposting the identical body, then submits under a fresh externalId", async (status) => {
    vi.useFakeTimers();
    const workflowUrls: string[] = [];
    const preflightBodies: Record<string, unknown>[] = [];
    let submitBody: Record<string, unknown> | undefined;
    let preflightAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href === blobUrl("output.jpg")) return new Response("image", { status: 200 });
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      workflowUrls.push(href);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") {
        preflightAttempts += 1;
        preflightBodies.push(body);
        if (preflightAttempts === 1) return Response.json({ detail: "prompt=private" }, { status });
        return Response.json(workflowFrom(body, "estimate-recovered", "unassigned"));
      }
      submitBody = body;
      return Response.json(workflowFrom(body, "submit-recovered", "succeeded", [{ id: "output.jpg", available: true }]));
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(preflightAttempts).toBe(2);
    expect(result).toMatchObject({ ok: true, predictionId: "submit-recovered" });
    expect(workflowUrls.filter((href) => href.includes("whatif=true"))).toHaveLength(2);
    expect(workflowUrls.filter((href) => href.includes("whatif=false"))).toHaveLength(1);

    // The retry reposts the IDENTICAL preflight body — including its
    // externalId, which #672 requires reusing rather than minting fresh for
    // the retry — while the paid submit still gets its own fresh one.
    const [firstPreflight, secondPreflight] = preflightBodies;
    if (!firstPreflight || !secondPreflight) throw new Error("expected two preflight bodies");
    expect(secondPreflight).toEqual(firstPreflight);
    if (!submitBody) throw new Error("expected a submit body");
    expect(submitBody.externalId).not.toBe(firstPreflight.externalId);
  });

  it("posts a plain preflight 400 only once, with no automatic retry", async () => {
    let preflightPosts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      preflightPosts += 1;
      return Response.json({
        title: "One or more validation errors occurred.",
        errors: { messages: ["prompt must not exceed 10000 characters"] },
      }, { status: 400 });
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(preflightPosts).toBe(1);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_http_400; retry=never") });
    if (result.ok) throw new Error("expected the plain 400 to fail");
    expect(result.error).not.toContain("already reposted");
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

  it.each(["fetch", "response text"] as const)("redacts a thrown preflight %s failure after one automatic retry", async (sentinel) => {
    // #672: a thrown transport failure is retried once automatically, with
    // the same preflight body (and externalId), before the render fails.
    vi.useFakeTimers();
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

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(workflowPosts).toBe(2);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_transport_failure; retry=deliberate") });
    if (result.ok) throw new Error("expected the preflight transport failure to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
    expect(result.error).toContain("already reposted this preflight once automatically");
    expect(result.error).not.toContain("read retries");
  });

  it("gives the preflight and the paid submit the same per-attempt timeout, scaled to the body's reference count (#680)", async () => {
    // Proves the per-stage timeout split against the REAL AbortSignal.timeout
    // rather than faked wall time, since vitest's fake timers do not reliably
    // drive it. Nothing in this test actually waits out a timeout: the mocked
    // fetch resolves immediately, and the assertion is on which budget each
    // call's signal was built with. The submit response reports insufficient
    // Buzz so the lane throws right after that POST, without a status poll or
    // output download — each of which would add its own 30 s
    // AbortSignal.timeout call and make the exact-equality assertion below
    // fragile for reasons unrelated to what this test is proving.
    //
    // `request` sends zero references, so both calls resolve to the 120 s
    // BASE rate (#672) rather than the flat constant it used to be — the
    // scaling itself (#680) is covered by the pure-function table above and
    // by the 4-reference end-to-end case in civitai-qwen21-runtime.test.ts,
    // since Klein's own cap is 2 references.
    const timeoutCalls: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") return Response.json(workflowFrom(body, "estimate-timeout", "unassigned"));
      const submitted = workflowFrom(body, "submit-timeout", "succeeded");
      (submitted.transactions as Record<string, unknown>).insufficientBuzz = true;
      return Response.json(submitted);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_async_insufficient_buzz") });
    // Preflight (120 s base, zero references), then the paid submit — still
    // the SAME budget (#673) rather than the default 30 s one; no status
    // poll or download followed because the submit itself already reported
    // insufficient Buzz.
    expect(timeoutCalls).toEqual([120_000, 120_000]);
  });

  it("also gives the preflight's automatic retry its own scaled budget, while a lora_metadata GET stays at 30 s", async () => {
    // Companion to the test above, exercising every stage's timeout in one
    // request: the lora_metadata GET (30 s), a failed first preflight
    // attempt (120 s base, zero references), its automatic retry (120 s —
    // #680's rule is computed once per `sendWorkflow` call and threaded
    // through every attempt inside `requestJson`, so a retry can never
    // silently fall back to a smaller budget than the attempt it repeats),
    // then the paid submit (120 s, #673). The insufficient-Buzz trick again
    // keeps the submit from reaching a status poll or output download, so
    // these four calls are the complete sequence.
    vi.useFakeTimers();
    const timeoutCalls: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    let preflightAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/model-versions/2633618")) {
        return Response.json({ id: 2633618, baseModel: "Flux.2 Klein 4B", model: { type: "LORA" }, modelId: 2169780 });
      }
      if (!href.includes("/consumer/workflows?")) throw new Error(`Unexpected fetch ${href}`);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const whatif = new URL(href).searchParams.get("whatif");
      if (whatif === "true") {
        preflightAttempts += 1;
        if (preflightAttempts === 1) return Response.json({ detail: "prompt=private" }, { status: 503 });
        return Response.json(workflowFrom(body, "estimate-sequence", "unassigned"));
      }
      const submitted = workflowFrom(body, "submit-sequence", "succeeded");
      (submitted.transactions as Record<string, unknown>).insufficientBuzz = true;
      return Response.json(submitted);
    });

    const pending = runCivitaiKleinImageModel(MODEL, {
      ...request,
      controlInput: {
        seed: 1234,
        [CIVITAI_LORA_VERSION_FIELD]: "2633618",
        [CIVITAI_LORA_STRENGTH_FIELD]: 0.75,
      },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(preflightAttempts).toBe(2);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("civitai_async_insufficient_buzz") });
    expect(timeoutCalls).toEqual([30_000, 120_000, 120_000, 120_000]);
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

  it("gives each output-download attempt its own 120 s budget, independent of the scaled POST budget (#682)", async () => {
    // Date is frozen, not full fake timers: the mocked fetches resolve
    // immediately and need no timer advancement. Freezing it keeps
    // `deadline - Date.now()` inside fetchOutput exactly 120_000 rather than
    // occasionally 119_999 under real wall-clock time, since the deadline is
    // computed a few async frames before it is read back (review P3-2).
    vi.useFakeTimers({ toFake: ["Date"] });
    const timeoutCalls: number[] = [];
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeoutCalls.push(ms);
      return realTimeout(ms);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-download-budget" : "submit-download-budget", whatif === "true" ? "unassigned" : "succeeded", [{
          id: "output.jpg", available: true,
        }]));
      }
      if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, {
      ...request,
      references: [{ bytes: Buffer.from("one"), mediaType: "image/png", extension: "png" }],
    });

    expect(result).toMatchObject({ ok: true, predictionId: "submit-download-budget" });
    // One reference scales the preflight and submit to 160 s each
    // (civitaiWorkflowPostTimeoutMs(1), #680); the output download that
    // follows still gets its OWN, independent 120 s attempt budget (#682) —
    // not the 30 s REQUEST_TIMEOUT_MS every other GET uses, and not the
    // 160 s the POSTs just used.
    expect(timeoutCalls).toEqual([160_000, 160_000, 120_000]);
  });

  it.each(["a transport failure", "a 503"] as const)(
    "retries %s output-download attempt from hop 0, with the bearer on each attempt's own first hop and none on a redirect hop (#682)",
    async (sentinel) => {
      vi.useFakeTimers();
      let attempts = 0;
      const hops: string[] = [];
      const authorizations: (string | null)[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const href = String(url);
        if (href.includes("/consumer/workflows?")) {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          const whatif = new URL(href).searchParams.get("whatif");
          return Response.json(workflowFrom(body, whatif === "true" ? "estimate-retry-output" : "submit-retry-output", whatif === "true" ? "unassigned" : "succeeded", [{
            id: "output.jpg", available: true,
          }]));
        }
        if (href === blobUrl("output.jpg")) {
          hops.push(href);
          authorizations.push(new Headers(init?.headers).get("authorization"));
          attempts += 1;
          if (attempts === 1) {
            if (sentinel === "a transport failure") throw new Error("provider token=secret signed-url=private");
            return new Response("token=secret", { status: 503 });
          }
          // The retry's own redirect hop: no bearer belongs here either,
          // same as a first attempt's own redirect would get.
          return new Response(null, { status: 301, headers: { location: "/v2/consumer/blobs/content/retried.jpg" } });
        }
        if (href === "https://orchestration.civitai.com/v2/consumer/blobs/content/retried.jpg") {
          hops.push(href);
          authorizations.push(new Headers(init?.headers).get("authorization"));
          return new Response("image-bytes", { status: 200 });
        }
        throw new Error(`Unexpected fetch ${href}`);
      });

      const pending = runCivitaiKleinImageModel(MODEL, request);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(attempts).toBe(2);
      expect(result).toMatchObject({ ok: true, predictionId: "submit-retry-output" });
      if (!result.ok) throw new Error("expected the retried download to succeed");
      expect(result.image?.toString()).toBe("image-bytes");
      // Every attempt restarts at the blob endpoint with the bearer on ITS
      // OWN first hop; the redirect hop that follows the successful retry
      // carries none — the retry never continues from wherever the failed
      // attempt left off.
      expect(hops).toEqual([
        blobUrl("output.jpg"), blobUrl("output.jpg"), "https://orchestration.civitai.com/v2/consumer/blobs/content/retried.jpg",
      ]);
      expect(authorizations).toEqual(["Bearer civitai-test-token", "Bearer civitai-test-token", null]);
    },
  );

  /**
   * PROTECTS (Codex review, PR #688): a refused attempt's body is released —
   * `cancel()`, best effort — before the retry's own request starts. The
   * implementation this kills throws on a 429/5xx without consuming or
   * cancelling the response body first, so during a provider outage every
   * concurrent render leaves up to CIVITAI_OUTPUT_DOWNLOAD_ATTEMPTS unread
   * response streams open for the timeout or garbage collection to reap.
   */
  it("releases a retryable refused attempt's body before the retry's own request, instead of leaking it through an outage (#682)", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const events: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-release-body" : "submit-release-body", whatif === "true" ? "unassigned" : "succeeded", [{
          id: "output.jpg", available: true,
        }]));
      }
      if (href === blobUrl("output.jpg")) {
        attempts += 1;
        events.push("request");
        if (attempts === 1) {
          // A refused attempt's response, with a body whose release this
          // test can observe — the production code calls only `.cancel()`
          // on it, never `.getReader()`, so a duck-typed body is enough.
          return {
            ok: false,
            status: 503,
            body: { cancel: async () => { events.push("cancel"); } },
          } as unknown as Response;
        }
        return new Response("image-bytes", { status: 200 });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: true, predictionId: "submit-release-body" });
    expect(attempts).toBe(2);
    // Released between the two blob-endpoint requests: not skipped, and not
    // deferred until after the retry had already started.
    expect(events).toEqual(["request", "cancel", "request"]);
  });

  it("redacts output-download transport sentinels, retrying from hop 0 up to the attempt cap, then reports the output as undelivered rather than lost, after exactly one paid POST (#682)", async () => {
    vi.useFakeTimers();
    let outputReads = 0;
    let paidPosts = 0;
    const authorizations: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        if (whatif === "false") paidPosts += 1;
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-output" : "submit-output", whatif === "true" ? "unassigned" : "succeeded", [{
          id: "output-undelivered.jpg", available: true,
        }]));
      }
      if (href === blobUrl("output-undelivered.jpg")) {
        outputReads += 1;
        authorizations.push(new Headers(init?.headers).get("authorization"));
        throw new Error("provider token=secret signed-url=private");
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(paidPosts).toBe(1);
    expect(outputReads).toBe(4);
    expect(authorizations).toEqual([
      "Bearer civitai-test-token", "Bearer civitai-test-token", "Bearer civitai-test-token", "Bearer civitai-test-token",
    ]);
    expect(result).toMatchObject({
      ok: false, predictionId: "submit-output", undeliveredOutputId: "output-undelivered.jpg",
      error: expect.stringContaining("civitai_output_undelivered; retry=reconcile"),
    });
    if (result.ok) throw new Error("expected the output download to end as undelivered");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
    // The blob id rides the structured undeliveredOutputId field above
    // (review P3-5), never the free text: a provider-supplied id could
    // otherwise misclassify the failure as billing or content rejection.
    expect(result.error).not.toContain("output-undelivered.jpg");
  });

  it.each([
    ["a missing output id", null, "civitai_output_unavailable; retry=deliberate", 0, undefined],
    // A retryable HTTP status now exhausts all 4 attempts before reporting
    // the output as undelivered, rather than failing on first occurrence
    // (#682) — the retry-then-succeed case above already proves a 503
    // retries; this proves exhaustion converts it.
    ["an output HTTP failure that exhausts every retry", "output.jpg", "civitai_output_undelivered; retry=reconcile", 4, () => new Response("token=secret", { status: 503 })],
    ["a 404 output", "output.jpg", "civitai_output_http_404; retry=deliberate", 1, () => new Response("not found", { status: 404 })],
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
    // A thrown body-stream read becomes civitai_output_transport_failure
    // (downloadOutputAttempt's own catch-all), which is retryable — so this
    // also now exhausts every attempt rather than failing on the first.
    ["a thrown output stream read that exhausts every retry", "output.jpg", "civitai_output_undelivered; retry=reconcile", 4, () => ({
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
    vi.useFakeTimers();
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

    const pending = runCivitaiKleinImageModel(MODEL, request);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(outputReads).toBe(expectedOutputReads);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-output-boundary", error: expect.stringContaining(expectedError) });
    if (result.ok) throw new Error("expected the output boundary to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
  });

  /**
   * PROTECTS: the output-selection predicate (`available && !hidden &&
   * !blocked && id`, unchanged in shape by #630's id/url rekey) actually
   * excludes an id-bearing image that is not yet safe to download, rather
   * than downloading the first id it sees.
   */
  it("skips an image that is not yet available in favor of one that is", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-pending" : "submit-pending", whatif === "true" ? "unassigned" : "succeeded", [
          { id: "pending.jpg", available: false },
          { id: "output.jpg", available: true },
        ]));
      }
      if (href === blobUrl("output.jpg")) return new Response("image-bytes", { status: 200 });
      if (href === blobUrl("pending.jpg")) throw new Error("must not fetch an unavailable image");
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: true, predictionId: "submit-pending" });
    expect(result.image?.toString()).toBe("image-bytes");
  });

  it("does not download a hidden image and fails as unavailable when no other image qualifies", async () => {
    let outputReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-hidden" : "submit-hidden", whatif === "true" ? "unassigned" : "succeeded", [
          { id: "hidden.jpg", available: true, hidden: true },
        ]));
      }
      if (href === blobUrl("hidden.jpg")) { outputReads += 1; return new Response("image-bytes", { status: 200 }); }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(outputReads).toBe(0);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-hidden", error: expect.stringContaining("civitai_output_unavailable; retry=deliberate") });
  });

  /**
   * PROTECTS: a per-image `blockedReason` (distinct from the job-level
   * `blocked` classification covered above) is excluded from selection and
   * reported as `civitai_async_blocked`, not the generic `civitai_output_unavailable`
   * a caller would otherwise get for "no image found" — the two need different
   * retry handling (never vs. deliberate).
   */
  it("reports a per-image blockedReason as civitai_async_blocked rather than a generic unavailable", async () => {
    let outputReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-image-blocked" : "submit-image-blocked", whatif === "true" ? "unassigned" : "succeeded", [
          { id: "blocked.jpg", available: true, blockedReason: "blocked" },
        ]));
      }
      if (href === blobUrl("blocked.jpg")) { outputReads += 1; return new Response("image-bytes", { status: 200 }); }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(outputReads).toBe(0);
    expect(result).toMatchObject({ ok: false, predictionId: "submit-image-blocked", error: expect.stringContaining("civitai_async_blocked; retry=never") });
  });

  /**
   * PROTECTS: the blob id is percent-encoded into the request path
   * (`encodeURIComponent`, #630) rather than interpolated raw, so an id
   * containing reserved URL characters still resolves to exactly the
   * blob it names instead of a mis-split path, a stray query string, or a
   * URL that `civitaiOutputLocation` rejects as invalid.
   */
  it("URL-encodes a blob id containing reserved characters", async () => {
    const blobId = "two words/with#hash?query.jpg";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(body, whatif === "true" ? "estimate-encoded" : "submit-encoded", whatif === "true" ? "unassigned" : "succeeded", [
          { id: blobId, available: true },
        ]));
      }
      if (href === blobUrl(blobId)) return new Response("image-bytes", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await runCivitaiKleinImageModel(MODEL, request);

    expect(result).toMatchObject({ ok: true, predictionId: "submit-encoded" });
    expect(result.image?.toString()).toBe("image-bytes");
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
 * PROTECTS (#687): a workflow that succeeded and was billed has its ids
 * recorded BEFORE its output download starts, so a process that dies during
 * the download (up to four 120 s attempts) leaves the render's row offering
 * the paid output for recovery instead of nothing. The bad implementations
 * this kills: recording after the download (a restart mid-download loses the
 * ids exactly as before), recording the wrong ids (the preflight's estimate
 * id, or no output id), and recording for a workflow that produced nothing
 * fetchable — a failed or blocked workflow, or a hidden output — which would
 * offer a recovery that can never succeed.
 */
describe("Civitai Klein v2 paid output recorded before its download (#687)", () => {
  /** A full render whose submit answers `status` with `images`; every blob fetch is logged into `events`. */
  function stubWorkflow(status: string, images: unknown[], events: string[]): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      if (href.includes("/consumer/workflows?")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const whatif = new URL(href).searchParams.get("whatif");
        return Response.json(workflowFrom(
          body,
          whatif === "true" ? "estimate-paid" : "submit-paid",
          whatif === "true" ? "unassigned" : status,
          images,
        ));
      }
      events.push(`fetch ${href}`);
      return new Response("image-bytes", { status: 200 });
    });
  }

  it("records the workflow, the chosen output and the model before the download's first fetch", async () => {
    const events: string[] = [];
    const recorded: PaidRenderOutput[] = [];
    stubWorkflow("succeeded", [{ id: "pending.jpg", available: false }, { id: "output.jpg", available: true }], events);

    const result = await withPaidRenderOutputRecorder(async (output) => {
      recorded.push(output);
      events.push("record");
    }, () => runCivitaiKleinImageModel(MODEL, request));

    expect(result).toMatchObject({ ok: true, predictionId: "submit-paid" });
    expect(recorded).toEqual([{ predictionId: "submit-paid", outputId: "output.jpg", modelSlug: CIVITAI_FLUX2_KLEIN4B_SLUG }]);
    expect(events).toEqual(["record", `fetch ${blobUrl("output.jpg")}`]);
  });

  it.each([
    ["a failed workflow", "failed", [{ id: "output.jpg", available: true }]],
    ["a workflow whose only output is blocked", "succeeded", [{ id: "blocked.jpg", available: true, blockedReason: "blocked" }]],
    ["a workflow whose only output is hidden", "succeeded", [{ id: "hidden.jpg", available: true, hidden: true }]],
  ] as const)("records nothing for %s", async (_description, status, images) => {
    const events: string[] = [];
    const recorder = vi.fn(async () => undefined);
    stubWorkflow(status, [...images], events);

    const result = await withPaidRenderOutputRecorder(recorder, () => runCivitaiKleinImageModel(MODEL, request));

    expect(result).toMatchObject({ ok: false, predictionId: "submit-paid" });
    expect(recorder).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("downloads the output all the same when the record fails", async () => {
    const events: string[] = [];
    stubWorkflow("succeeded", [{ id: "output.jpg", available: true }], events);

    const result = await withPaidRenderOutputRecorder(async () => {
      throw new Error("the database is not answering");
    }, () => runCivitaiKleinImageModel(MODEL, request));

    expect(result).toMatchObject({ ok: true, predictionId: "submit-paid" });
    expect(result.image?.toString()).toBe("image-bytes");
    expect(events).toEqual([`fetch ${blobUrl("output.jpg")}`]);
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

/**
 * PROTECTS (#682): `recoverCivitaiOutput` recovers the output of a workflow
 * that already succeeded and was already paid for, WITHOUT POSTing anything
 * — never a fresh workflow, never a charge. It distinguishes `permanent:
 * true` (positive evidence the output can never be fetched this way) from
 * `permanent: false` (try again later) exactly per the rule on the function
 * itself: a withdrawn "permanent" costs the owner their one free recovery
 * for good, while a wrong "transient" only costs them retrying.
 */
describe("Civitai Klein v2 output recovery (recoverCivitaiOutput, #682)", () => {
  const WORKFLOW_ID = "recover-workflow-1";
  const BLOB_ID = "recover-blob-1";

  function workflowReadUrl(id: string): string {
    return `https://orchestration.civitai.com/v2/consumer/workflows/${encodeURIComponent(id)}`;
  }

  function succeededWorkflow(images: unknown[]): Record<string, unknown> {
    return {
      id: WORKFLOW_ID, status: "succeeded", allowMatureContent: true, currencies: ["yellow"],
      upgradeMode: "manual", transactions: { insufficientBuzz: false },
      steps: [{ $type: "imageGen", input: {}, output: { images } }],
    };
  }

  it("recovers the output with no POST at all", async () => {
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const href = String(url);
      methods.push(init?.method ?? "GET");
      if (href === workflowReadUrl(WORKFLOW_ID)) {
        return Response.json(succeededWorkflow([{ id: BLOB_ID, available: true }]));
      }
      if (href === blobUrl(BLOB_ID)) return new Response("image-bytes", { status: 200 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected recovery to succeed");
    expect(result.image.toString()).toBe("image-bytes");
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("reports permanent for a workflow the provider answers 404 for", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: false, permanent: true });
    if (result.ok) throw new Error("expected a 404 workflow read to fail");
    expect(result.error).toContain("civitai_http_404");
  });

  it("reports permanent for a workflow that did not succeed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      id: WORKFLOW_ID, status: "processing", allowMatureContent: true, currencies: ["yellow"],
      upgradeMode: "manual", transactions: { insufficientBuzz: false },
      steps: [{ $type: "imageGen", input: {}, output: {} }],
    }));

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: false, permanent: true });
    if (result.ok) throw new Error("expected a non-succeeded workflow to fail");
    expect(result.error).toContain("processing");
  });

  it("reports permanent for a workflow that answers with a different id", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      id: "a-different-workflow", status: "succeeded", allowMatureContent: true, currencies: ["yellow"],
      upgradeMode: "manual", transactions: { insufficientBuzz: false },
      steps: [{ $type: "imageGen", input: {}, output: { images: [{ id: BLOB_ID, available: true }] } }],
    }));

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: false, permanent: true });
  });

  it.each([
    ["an unavailable blob", { id: BLOB_ID, available: false }],
    ["a hidden blob", { id: BLOB_ID, available: true, hidden: true }],
    ["a blocked blob", { id: BLOB_ID, available: true, blockedReason: "blocked" }],
    ["a workflow that does not list the blob at all", { id: "some-other-blob", available: true }],
  ] as const)("reports permanent for %s", async (_description, image) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(succeededWorkflow([image])));

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: false, permanent: true });
  });

  it("reports NOT permanent for a transport failure on the workflow read, without leaking its text", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("provider token=secret prompt=private"); });

    const result = await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(result).toMatchObject({ ok: false, permanent: false });
    if (result.ok) throw new Error("expected the transport failure to fail");
    expect(result.error).not.toContain("secret");
    expect(result.error).not.toContain("private");
  });

  it("reports NOT permanent after the download itself exhausts every retry (503)", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = String(url);
      if (href === workflowReadUrl(WORKFLOW_ID)) {
        return Response.json(succeededWorkflow([{ id: BLOB_ID, available: true }]));
      }
      if (href === blobUrl(BLOB_ID)) return new Response("token=secret", { status: 503 });
      throw new Error(`Unexpected fetch ${href}`);
    });

    const pending = recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, permanent: false });
    if (result.ok) throw new Error("expected the exhausted download retry to fail");
    expect(result.error).toContain("civitai_output_undelivered");
    expect(result.error).not.toContain("secret");
  });

  it("never POSTs, even on its own GET failures", async () => {
    const methods = new Set<string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      methods.add(init?.method ?? "GET");
      return new Response("not found", { status: 404 });
    });

    await recoverCivitaiOutput({ workflowId: WORKFLOW_ID, blobId: BLOB_ID });

    expect(methods.has("POST")).toBe(false);
  });
});
