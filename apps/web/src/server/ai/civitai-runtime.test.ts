import { afterEach, describe, expect, it, vi } from "vitest";
import { civitaiAsyncFailure } from "./civitai-errors";
import { classifyImageFailureMessage, imageModelSchema, type ImageModel } from "@vesper/image-core";
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
    expect(result.error).toContain("paths=steps[0].input.resolution");
    expect(result.error).not.toContain("private");
    expect(result.error).not.toContain("secret");
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
    expect(result).toMatchObject({ ok: false, predictionId: "submit-deadline", error: expect.stringContaining("civitai_async_timeout; retry=deliberate") });
    if (result.ok) throw new Error("expected the expired status retry to time out");
    expect(result.error).not.toContain("secret");
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
    if (submitFailure.ok) throw new Error("expected the submit failure to fail");
    expect(submitFailure.error).not.toContain("already reposted");
    expect(workflowUrls).toEqual([expect.stringContaining("whatif=true"), expect.stringContaining("whatif=false")]);
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
    /** A read-only workflow-list GET: present whenever `whatif` is absent from the query string. */
    function isLookupGet(href: string): boolean {
      return href.includes("/consumer/workflows?") && new URL(href).searchParams.get("whatif") === null;
    }

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
      ["a 5xx submit", () => Response.json({ detail: "prompt=private" }, { status: 503 }), "civitai_http_503"],
      ["a malformed 2xx submit", () => new Response("not json", { status: 200 }), "civitai_malformed_response"],
    ] as const)("leads to a lookup after %s, naming that code once the lookup gives up", async (_description, submitResponse, originalCode) => {
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

    it("bounds one round's pagination at the page cap instead of chasing an endless cursor", async () => {
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

  it("gives the preflight and the paid submit the same 120 s per-attempt timeout (#673)", async () => {
    // Proves the per-stage timeout split against the REAL AbortSignal.timeout
    // rather than faked wall time, since vitest's fake timers do not reliably
    // drive it. Nothing in this test actually waits out a timeout: the mocked
    // fetch resolves immediately, and the assertion is on which budget each
    // call's signal was built with. The submit response reports insufficient
    // Buzz so the lane throws right after that POST, without a status poll or
    // output download — each of which would add its own 30 s
    // AbortSignal.timeout call and make the exact-equality assertion below
    // fragile for reasons unrelated to what this test is proving.
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
    // Preflight (120 s), then the paid submit — now on the SAME 120 s budget
    // (#673) rather than the default 30 s one; no status poll or download
    // followed because the submit itself already reported insufficient Buzz.
    expect(timeoutCalls).toEqual([120_000, 120_000]);
  });

  it("also gives the preflight's automatic retry its own 120 s, while a lora_metadata GET stays at 30 s", async () => {
    // Companion to the test above, exercising every stage's timeout in one
    // request: the lora_metadata GET (30 s), a failed first preflight
    // attempt (120 s), its automatic retry (120 s), then the paid submit
    // (120 s, #673). The insufficient-Buzz trick again keeps the submit from
    // reaching a status poll or output download, so these four calls are the
    // complete sequence — proving the retry attempt is not silently left on
    // the shared 30 s budget.
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
