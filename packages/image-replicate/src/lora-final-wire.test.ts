import {
  evaluateImageLoraForRender,
  type ImageLora,
  type ImageLoraRenderBinding,
  type ImageModel,
  type ImageModelProfile,
  imageLoraSchema,
  imageModelProfileSchema,
  imageModelSchema,
  type ImageRenderIntent,
  planImageRender,
  type PlannedImageRender,
  withReviewedImageQuality,
} from "@vesper/image-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplicateClient } from "./client";
import { DEFAULT_PREDICTION_TIMEOUT_MS } from "./config";
import { buildPayload, previewRegistryModelInput } from "./payload";

/**
 * The FINAL WIRE for a curated LoRA: a library row travels row → evaluation →
 * render intent → compiled plan → the payload builder the transport actually
 * POSTs, and the two provider fields arrive verbatim.
 *
 * It exists because of a specific incident. Every unit test on this path passed
 * for months — the row parsed, the evaluator resolved, the mapper wrote its two
 * fields, the plan recorded `appliedControls.lora` — while no real prediction
 * ever carried `lora_weights`. Each layer proved its own step against its own
 * fixture, and nobody held one row against the bytes that leave the process.
 * That is the one thing asserted here, and the reason this suite lives in the
 * transport package rather than beside the evaluator: this is the end of the
 * chain, and the end is where the claim was false.
 *
 * No real network, no database, no environment. Three cases end at the REAL
 * builders — `buildPayload` is what `runRegistryImageModel` calls to build the
 * body it posts, and `previewRegistryModelInput` (which delegates to it) is what
 * the Image Generator stores as its pre-spend record — and one case goes the
 * whole way: `runRegistryImageModel` itself against a stubbed `fetch`, asserted
 * on the JSON body of the prediction-create request. Nothing here re-implements
 * a payload rule.
 *
 * What each case kills:
 *
 * 1. any regression that leaves the two fields out of a bench render's payload —
 *    including the original defect, where the bench had to borrow a production
 *    task and the row's `allowedTasks` curation then refused mechanically
 *    perfect weights;
 * 2. a builder that writes LoRA keys uninvited, which would make an unLoRA'd
 *    render silently carry weights;
 * 3. a Civitai row reaching the provider as the bare catalogue id it is stored
 *    as, rather than as the download URL the evaluator now resolves.
 *
 * Deliberately token-free: credential completion is the application's step and
 * is covered by `lora-credentials.test.ts`. What travels through here is the
 * public locator.
 */

/** The deployment posture every case plans and builds under; not what is under test. */
const SAFETY_CHECKER_DISABLED = true;

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The registered Qwen Image Edit 2511 row — the model production intimate
 * scenes render on — carrying the LoRA bindings migration 0118 put on the
 * built-in row (`probe.test.ts` pins the same normalization against a published
 * Qwen edit schema).
 */
const QWEN_2511: ImageModel = imageModelSchema.parse({
  id: "imgmdlqwenedit2511aaaaaa",
  slug: "qwen/qwen-image-edit-2511",
  label: "Qwen Image Edit 2511",
  canGenerate: false,
  canEdit: true,
  editKind: "instruction_edit",
  referenceField: "image",
  referenceArity: "array",
  maxReferences: 3,
  advancedCapabilities: {
    controls: {
      loraWeights: { field: "lora_weights", type: "string" },
      loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
    },
    knownInputFields: ["lora_weights", "lora_scale"],
  },
});

/** The pinned 2511 version the built-in row is probed against (migration 0118). */
const VERSION_ID = "a0670a7f47d5975347c105b6ce71456c4377d511993975988127dee03ca6c729";

/**
 * The Image Generator's synthetic profile, as `imageGeneratorProfile` builds it.
 *
 * `task: "item"` is the load-bearing part: the bench has no real task and picks a
 * neutral nominal one, which is precisely NOT the answer the library is asked.
 */
const BENCH_PROFILE: ImageModelProfile = imageModelProfileSchema.parse({
  id: "image-generator/run",
  imageModelId: QWEN_2511.id,
  key: "image-generator",
  label: "Image Generator",
  task: "item",
  operation: "edit",
  promptStrategy: "instruction_edit",
  referencePolicy: { allowedRoles: [], requiredRoles: [], roleOrder: [], identityStrategy: "canonical_only" },
  controlDefaults: { seedPolicy: "caller" },
});

/** Stands in for the short-lived Replicate file URL an uploaded reference becomes. */
const REFERENCE_URI = "https://replicate.delivery/pbxt/bench-reference.webp";

/**
 * The seeded intimate-scene row (migrations 0108, 0114, 0118 and 0127), parsed
 * through the real schema rather than hand-built: a fixture that could not be
 * stored would prove nothing about a render. Its compatibility list is the one
 * that chain leaves behind — the intimate endpoint alone — so the row this suite
 * drives is the row production drives.
 */
const LIBRARY_ROW: ImageLora = imageLoraSchema.parse({
  id: "imglorqwennsfwallinclv20",
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locatorType: "https_url",
  locator: "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor",
  compatibleModelSlugs: ["qwen/qwen-image-edit-2511"],
  compatibleVersionIds: [],
  defaultScale: 1,
  minimumScale: 0.5,
  maximumScale: 1.5,
  allowedTasks: ["scene", "variant"],
  enabled: true,
  builtin: true,
});

/** Step 1: the library's own decision, asked the way the bench asks it. */
function resolveBinding(row: ImageLora): ImageLoraRenderBinding {
  const evaluation = evaluateImageLoraForRender({
    lora: row,
    modelSlug: QWEN_2511.slug,
    versionId: VERSION_ID,
    // The Generator renders nothing a player sees, so the row's production task
    // curation does not apply here. This one argument is the whole defect: with a
    // borrowed `production` task the row is refused, and every payload that
    // follows carries no weights at all.
    context: { kind: "generator_bench" },
    bindings: QWEN_2511.advancedCapabilities.controls,
  });
  if (!evaluation.ok) {
    throw new Error(`[lora-final-wire] the row was refused: ${evaluation.code} — ${evaluation.message}`);
  }
  return evaluation.binding;
}

/** Step 2: the intent the bench builds, compiled into a plan. */
function planned(binding?: ImageLoraRenderBinding): PlannedImageRender {
  const intent: ImageRenderIntent = {
    profile: { model: QWEN_2511, profile: BENCH_PROFILE },
    prompt: "a bench render",
    references: [{ role: "reference", buffer: Buffer.from("bench-reference"), required: true }],
    target: { aspectRatio: null },
    ...(binding ? { resolvedLora: binding } : {}),
  };
  const result = planImageRender(intent, { safetyCheckerDisabled: SAFETY_CHECKER_DISABLED });
  if (!result.ok) {
    throw new Error(`[lora-final-wire] the plan was refused: ${result.refusal.code} — ${result.refusal.message}`);
  }
  return result.plan;
}

/**
 * Step 3: the body `runRegistryImageModel` posts for this plan — the same
 * builder, the same reviewed-quality seam `renderWithModel` applies, and the
 * reference standing where its uploaded URL would.
 */
function sentPayload(plan: PlannedImageRender): Record<string, unknown> {
  return buildPayload(
    withReviewedImageQuality(plan.model),
    { prompt: plan.prompt, aspect: null, controlInput: plan.controlInput, policy: plan.policy },
    plan.references.map(() => REFERENCE_URI),
    [],
    SAFETY_CHECKER_DISABLED,
  );
}

/** The same payload as the Generator RECORDS it before spending (`image-generator-provenance.ts` effective request record). */
function recordedPayload(plan: PlannedImageRender): Record<string, unknown> {
  return previewRegistryModelInput({
    model: withReviewedImageQuality(plan.model),
    prompt: plan.prompt,
    referenceCount: plan.references.length,
    aspect: null,
    controlInput: plan.controlInput,
    policy: plan.policy,
    safetyCheckerDisabled: SAFETY_CHECKER_DISABLED,
  });
}

describe("a curated LoRA row reaching the Replicate payload", () => {
  it("sends the row's locator and scale verbatim on a bench render", () => {
    // Fixture honesty, not ceremony: the case only proves the bench exemption
    // while the row's curation genuinely excludes the bench profile's nominal
    // task. Widen `allowedTasks` to include `item` and this stops being a test.
    expect(LIBRARY_ROW.allowedTasks).not.toContain(BENCH_PROFILE.task);

    const plan = planned(resolveBinding(LIBRARY_ROW));
    const payload = sentPayload(plan);
    // The query string travels untouched — it is part of the address the row was
    // reviewed with — and no credential is added at this layer.
    expect(payload.lora_weights).toBe(LIBRARY_ROW.locator);
    expect(payload.lora_scale).toBe(LIBRARY_ROW.defaultScale);
    // The Generator grades runs against a STORED copy of this payload, assembled
    // by a second function. The two must agree about the LoRA, or a graded run's
    // evidence names weights the prediction never fetched.
    const recorded = recordedPayload(plan);
    expect(recorded.lora_weights).toBe(payload.lora_weights);
    expect(recorded.lora_scale).toBe(payload.lora_scale);
  });

  it("writes neither field when the render resolved no LoRA", () => {
    // The control the first case needs to mean anything: the fields must come
    // from the library row, never from the model's own LoRA bindings existing.
    const payload = sentPayload(planned());
    expect("lora_weights" in payload).toBe(false);
    expect("lora_scale" in payload).toBe(false);
  });

  it("posts the row's locator and scale in the real prediction request body", async () => {
    // The previous cases end at the builder; this one ends at the POST. The
    // full transport runs — upload, payload assembly, strict validation, the
    // prediction create — against a stubbed `fetch`, and the assertion reads
    // the JSON body of the create request itself. This is the literal claim
    // the incident falsified: not "a builder would include the fields", but
    // "the bytes that left the process carried them".
    const plan = planned(resolveBinding(LIBRARY_ROW));
    const posted: { input?: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/files")) {
          return Response.json({ id: "file-1", urls: { get: "https://replicate.delivery/f/bench-reference.webp" } });
        }
        if (init?.method === "POST" && url.includes("/predictions")) {
          posted.push(JSON.parse(String(init.body)) as { input?: Record<string, unknown> });
          return Response.json({
            id: "pred-wire",
            status: "succeeded",
            output: ["https://replicate.delivery/o/out.webp"],
          });
        }
        return new Response(Buffer.from("image-bytes"), { status: 200 });
      }),
    );

    const result = await createReplicateClient({
      apiToken: "test-token",
      safetyCheckerDisabled: SAFETY_CHECKER_DISABLED,
      predictionTimeoutMs: DEFAULT_PREDICTION_TIMEOUT_MS,
    }).runRegistryImageModel(withReviewedImageQuality(plan.model), {
      prompt: plan.prompt,
      references: plan.references.map((buffer) => ({ bytes: buffer, mediaType: "image/webp", extension: "webp" })),
      aspect: null,
      controlInput: plan.controlInput,
      typedControlFields: plan.typedControlFields,
      policy: plan.policy,
    });

    expect(result.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.input?.lora_weights).toBe(LIBRARY_ROW.locator);
    expect(posted[0]?.input?.lora_scale).toBe(LIBRARY_ROW.defaultScale);
  });

  it("sends a civitai_model_version row as its resolved download URL", () => {
    // Stored as the bare catalogue id; only the evaluator's resolution step makes
    // it an address a provider can fetch. The URL is spelled out here on purpose:
    // it is a wire format, and the whole point of the row type is that a render
    // never sends the id itself.
    const row = imageLoraSchema.parse({ ...LIBRARY_ROW, locatorType: "civitai_model_version", locator: "3160956" });
    const payload = sentPayload(planned(resolveBinding(row)));
    expect(payload.lora_weights).toBe("https://civitai.com/api/download/models/3160956");
    expect(payload.lora_scale).toBe(row.defaultScale);
  });
});
