import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  type ImageGeneratorCreateRunRequest,
  imageGeneratorDiagnosticCode,
} from "@/contracts/images/image-generator";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { db, imageGeneratorRuns, imageModels, images } from "../db";
import { createImageAsset, imageMeta, saveImageBuffer, type ImageKind } from "./assets";
import { setImageGeneratorRendererForTesting, type GeneratorRenderRequest } from "./image-generator-render";
import { runImageGeneratorRun } from "./image-generator-run";
import {
  createImageGeneratorRun,
  deleteImageGeneratorRun,
  getImageGeneratorRunDetail,
  type ImageGeneratorRunRow,
} from "./image-generator-store";

/**
 * The Image Generator's server half end to end against DATABASE_URL and a
 * sandboxed DATA_ROOT (image-lab-general-model-trials.spec.md §"Fixtures and
 * tests"). The renderer seam is always injected — Replicate is never called —
 * so what is under test is the Generator's own machinery: the run lifecycle,
 * every pre-spend refusal with its exact code, the provider-vs-storage failure
 * distinction, output cleanup, and owner scoping.
 *
 * Every refusal case asserts the settled failure code AND that the seam was
 * never reached (`captured` stays empty) — "refused before spend" is the
 * invariant, and a run that rendered anyway would pass a code-only check.
 * Registry rows are global, so this suite plants its own by id, delete-first,
 * exactly as the lab suite does.
 */

const ready = await probeIntegrationDb("image generator.int.test", "image_generator_runs");

const PINNED_MODEL_ID = "imgmdlgenpinnedaaaaaaaaa";
const UNPINNED_MODEL_ID = "imgmdlgenfloataaaaaaaaaa";
const CAPPED_MODEL_ID = "imgmdlgencappedaaaaaaaaa";
const GENERATE_ONLY_MODEL_ID = "imgmdlgentextonlyaaaaaaa";
const DEDICATED_MODEL_ID = "imgmdlgendedicatedaaaaaa";
const DISPOSABLE_MODEL_ID = "imgmdlgendisposableaaaaa";
const EDIT_ONLY_MODEL_ID = "imgmdlgeneditonlyaaaaaaa";
const ADVANCED_MODEL_ID = "imgmdlgenadvancedaaaaaaa";
const FIXTURE_MODEL_IDS = [
  PINNED_MODEL_ID,
  UNPINNED_MODEL_ID,
  CAPPED_MODEL_ID,
  GENERATE_ONLY_MODEL_ID,
  DEDICATED_MODEL_ID,
  DISPOSABLE_MODEL_ID,
  EDIT_ONLY_MODEL_ID,
  ADVANCED_MODEL_ID,
];

const PINNED_SLUG = "vesper-test/generator-pinned";
const UNPINNED_SLUG = "vesper-test/generator-floating";
const CAPPED_SLUG = "vesper-test/generator-one-reference";
const GENERATE_ONLY_SLUG = "vesper-test/generator-text-only";
const DEDICATED_SLUG = "vesper-test/generator-dedicated";
const DISPOSABLE_SLUG = "vesper-test/generator-disposable";
const EDIT_ONLY_SLUG = "vesper-test/generator-edit-only";
const ADVANCED_SLUG = "vesper-test/generator-advanced";
const PINNED_VERSION = "generatorversionaaaaaaaa";
const EXECUTED_VERSION = PINNED_VERSION;

let temp: TempDataRoot | undefined;
let ownerId = "";
let otherOwnerId = "";
/** Exactly what the renderer seam was handed, per test. */
let captured: GeneratorRenderRequest[] = [];

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-image-generator-int");
  ownerId = (await seedTestUser("image-generator-int")).id;
  otherOwnerId = (await seedTestUser("image-generator-int-b")).id;

  await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  await db()
    .insert(imageModels)
    .values([
      {
        id: PINNED_MODEL_ID,
        slug: PINNED_SLUG,
        label: "Generator Pinned Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
      },
      {
        // No probed version and none in the slug: nothing can say what this
        // row executes — the whole `version_unpinned` refusal.
        id: UNPINNED_MODEL_ID,
        slug: UNPINNED_SLUG,
        label: "Generator Floating Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
      },
      {
        // ONE reference slot, so an over-selected run refuses instead of
        // silently trimming an explicit input.
        id: CAPPED_MODEL_ID,
        slug: CAPPED_SLUG,
        label: "Generator One-Reference Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 1,
        probedVersionId: PINNED_VERSION,
      },
      {
        // Takes no image input at all: any selected reference is an edit the
        // model cannot run.
        id: GENERATE_ONLY_MODEL_ID,
        slug: GENERATE_ONLY_SLUG,
        label: "Generator Text-Only Fixture",
        canGenerate: true,
        canEdit: false,
        maxReferences: 0,
        probedVersionId: PINNED_VERSION,
      },
      {
        // The only fixture whose probed capabilities bind a structural role to
        // its own provider field — the shape a dedicated selection requires.
        id: DEDICATED_MODEL_ID,
        slug: DEDICATED_SLUG,
        label: "Generator Dedicated-Input Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
        advancedCapabilities: {
          additionalImageInputs: [
            { roleHint: "pose", binding: { field: "pose_image", arity: "single", required: false } },
          ],
        },
      },
      {
        // Editing only — prompt-only on it exercises the GENERATE arm of
        // `operation_unsupported` (the text-only fixture owns the edit arm).
        id: EDIT_ONLY_MODEL_ID,
        slug: EDIT_ONLY_SLUG,
        label: "Generator Edit-Only Fixture",
        canGenerate: false,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
      },
      {
        // The one fixture the pre-spend provider-input gate can prove things
        // about: a curated-LoRA control binding, a reviewed extraInput pin,
        // and a typed/ranged descriptor for one declared provider field.
        id: ADVANCED_MODEL_ID,
        slug: ADVANCED_SLUG,
        label: "Generator Advanced-Input Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
        extraInput: { go_fast: true },
        advancedCapabilities: {
          controls: {
            loraWeights: { field: "lora_weights", type: "string" },
            loraScale: { field: "lora_scale", type: "number" },
          },
          providerInputs: [
            { field: "num_inference_steps", type: "integer", required: false, minimum: 1, maximum: 50, reserved: false },
          ],
        },
      },
      {
        // Registered only to be deleted mid-test: the `model_missing` case is
        // a registration that vanished between create and run.
        id: DISPOSABLE_MODEL_ID,
        slug: DISPOSABLE_SLUG,
        label: "Generator Disposable Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
      },
    ]);
});

afterAll(async () => {
  if (ready) await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  await temp?.cleanup();
  await purgeOwnerRows([ownerId, otherOwnerId]);
  await endTestPool();
});

beforeEach(() => {
  captured = [];
});

afterEach(async () => {
  setImageGeneratorRendererForTesting(null);
  if (!ready) return;
  await db().delete(imageGeneratorRuns).where(eq(imageGeneratorRuns.ownerId, ownerId));
  await db().delete(images).where(eq(images.ownerId, ownerId));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready image row with real bytes on the sandboxed data root. */
async function seedReadyImage(kind: ImageKind = "avatar"): Promise<string> {
  const asset = await createImageAsset({ ownerId, kind, prompt: "generator source fixture" });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer());
  expect(saved?.status).toBe("ready");
  return asset.id;
}

/** A renderer that succeeds, recording what it was handed. */
function stubSuccessfulRenderer(): void {
  setImageGeneratorRendererForTesting(async (request) => {
    captured.push(request);
    return {
      ok: true,
      image: await testPngBuffer(),
      predictionId: "pred_generator_1",
      executedVersionId: EXECUTED_VERSION,
      attempt: {
        modelId: PINNED_MODEL_ID,
        modelSlug: PINNED_SLUG,
        profileId: "image-generator/run",
        task: "item",
        promptStrategy: "text_to_image_description",
        requestedVersionId: PINNED_VERSION,
        seed: null,
        appliedControls: {},
        droppedControls: [],
        sentReferenceRoles: [],
        predictionId: "pred_generator_1",
        executedVersionId: EXECUTED_VERSION,
      },
    };
  });
}

async function createRun(
  overrides: Partial<ImageGeneratorCreateRunRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector }> {
  const sink = new DiagnosticCollector();
  const request: ImageGeneratorCreateRunRequest = {
    modelId: PINNED_MODEL_ID,
    prompt: "A red lighthouse on a granite point, storm light.",
    ...overrides,
  };
  const created = await createImageGeneratorRun({ ownerId, request, sink });
  if (!created.ok) throw new Error(`unexpected create refusal: ${created.refusal.code}`);
  return { id: created.run.id, sink };
}

async function storedRow(runId: string): Promise<ImageGeneratorRunRow | undefined> {
  const [row] = await db().select().from(imageGeneratorRuns).where(eq(imageGeneratorRuns.id, runId)).limit(1);
  return row;
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator runs", () => {
  it("renders prompt-only, records provenance, and stores a hidden generator output", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();

    const payload = await runImageGeneratorRun(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");
    expect(payload.providerOutcome).toBe(true);

    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    expect(run?.status).toBe("succeeded");
    expect(run?.failureCode).toBeNull();
    expect(run?.requestedVersionId).toBe(PINNED_VERSION);
    expect(run?.executedVersionId).toBe(EXECUTED_VERSION);
    expect(run?.predictionId).toBe("pred_generator_1");
    // The admin's prompt is the whole positive prompt; a prompt-only run on an
    // unreviewed fixture model crosses only the shared boundary, unchanged.
    expect(run?.finalPrompt).toBe(run?.prompt);
    expect(run?.attempt).not.toBeNull();

    // The pin travels INSIDE the intent — the seam has no version parameter.
    const request = captured[0];
    expect(request?.mode).toBe("intent");
    expect(request?.intent.versionId).toBe(PINNED_VERSION);
    expect(request?.intent.references).toHaveLength(0);
    expect(request?.intent.profile.profile.promptStrategy).toBe("text_to_image_description");

    const outputId = run?.resultImageId ?? "";
    const [output] = await db().select().from(images).where(eq(images.id, outputId)).limit(1);
    expect(output?.kind).toBe("generator_output");
    expect(output?.status).toBe("ready");
    expect(imageMeta(output?.meta).hidden).toBe(true);
    expect(imageMeta(output?.meta).imageGeneratorRunId).toBe(id);
    // No entity or chat association — bench evidence, not a library asset.
    expect(output?.entityId).toBeNull();
    expect(output?.chatId).toBeNull();
  });

  it("sends a primary reference under the neutral role, with purpose as provenance only", async () => {
    stubSuccessfulRenderer();
    const sourceId = await seedReadyImage();
    const { id, sink } = await createRun({
      inputs: { primary: [{ imageId: sourceId, purpose: "identity" }], dedicated: [] },
    });

    const payload = await runImageGeneratorRun(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    // The purpose never routes: the planner sees `reference`, in caller order.
    const request = captured[0];
    expect(request?.intent.references.map((reference) => reference.role)).toEqual(["reference"]);
    expect(request?.intent.references[0]?.required).toBe(true);
    expect(request?.intent.profile.profile.promptStrategy).toBe("instruction_edit");

    // The stored record keeps the purpose the admin chose.
    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    expect(run?.inputs.primary[0]?.purpose).toBe("identity");
  });

  it("routes a dedicated input by its structural role when the version binds one", async () => {
    stubSuccessfulRenderer();
    const sourceId = await seedReadyImage();
    const poseId = await seedReadyImage("scene");
    const { id, sink } = await createRun({
      modelId: DEDICATED_MODEL_ID,
      inputs: { primary: [{ imageId: sourceId }], dedicated: [{ role: "pose", imageId: poseId }] },
    });

    const payload = await runImageGeneratorRun(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");
    expect(captured[0]?.intent.references.map((reference) => reference.role)).toEqual(["reference", "pose"]);

    // The settled row ends with BOTH meta records: the pre-spend outcome
    // (written before the seam) and the attempt (written by the settle). The
    // settle merges over the row carrying the outcome write — settling from
    // the pre-write row object would erase `outcome` on every rendered run.
    const row = await storedRow(id);
    expect(imageMeta(row?.meta)).toMatchObject({
      outcome: { sentRoles: ["reference"], dedicatedFields: ["pose_image"], renumbered: false },
      attempt: { predictionId: "pred_generator_1" },
    });
  });
});

// ---------------------------------------------------------------------------
// Pre-spend refusals — each settles its exact code and never reaches the seam
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator pre-spend refusals", () => {
  it("refuses a model whose registration vanished after create", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: DISPOSABLE_MODEL_ID });
    await db().delete(imageModels).where(eq(imageModels.id, DISPOSABLE_MODEL_ID));

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.providerOutcome).toBeNull();
    const row = await storedRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("model_missing"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a model with no exact provider version to pin", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: UNPINNED_MODEL_ID });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.providerOutcome).toBeNull();
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("version_unpinned"));
    expect(codes(sink)).toContain(imageGeneratorDiagnosticCode("version_unpinned"));
    expect(captured).toHaveLength(0);
  });

  it("refuses references on a model that takes no image input", async () => {
    stubSuccessfulRenderer();
    const sourceId = await seedReadyImage();
    const { id, sink } = await createRun({
      modelId: GENERATE_ONLY_MODEL_ID,
      inputs: { primary: [{ imageId: sourceId }], dedicated: [] },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("operation_unsupported"));
    expect(captured).toHaveLength(0);
  });

  it("refuses prompt-only on a model that cannot generate from text", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: EDIT_ONLY_MODEL_ID });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("operation_unsupported"));
    expect(captured).toHaveLength(0);
  });

  it("refuses an unreadable input image, with the pin already on the record", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({
      inputs: { primary: [{ imageId: "imgnotarealimageaaaaaaaa" }], dedicated: [] },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("input_missing"));
    // Resolved and persisted BEFORE the read, so the failed attempt still says
    // what weights it asked for.
    expect(row?.requestedVersionId).toBe(PINNED_VERSION);
    expect(captured).toHaveLength(0);
  });

  it("refuses stored inputs that no longer parse — fail closed, both halves recorded", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();
    // A malformed selection reaches the runner exactly as a bad deploy would
    // leave it. Degrading to "no inputs" would run prompt-only as if the admin
    // selected nothing — the positive-claim fallback resilience forbids.
    await db()
      .update(imageGeneratorRuns)
      .set({ inputs: { primary: [{ imageId: 42 }] } })
      .where(eq(imageGeneratorRuns.id, id));

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("input_missing"));
    expect(codes(sink)).toContain("parse.boundary_failed");
    expect(codes(sink)).toContain(imageGeneratorDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
  });

  it("refuses explicit references beyond the model's capacity — never a trim", async () => {
    stubSuccessfulRenderer();
    const first = await seedReadyImage();
    const second = await seedReadyImage();
    const { id, sink } = await createRun({
      modelId: CAPPED_MODEL_ID,
      inputs: { primary: [{ imageId: first }, { imageId: second }], dedicated: [] },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("capacity_exceeded"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a dedicated role the version binds no field for — no numbered fallback", async () => {
    stubSuccessfulRenderer();
    const poseId = await seedReadyImage("scene");
    const { id, sink } = await createRun({
      inputs: { primary: [], dedicated: [{ role: "pose", imageId: poseId }] },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("dedicated_input_unbound"));
    expect(captured).toHaveLength(0);
  });

  it("refuses an explicit control the version cannot represent", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ controls: { steps: 30 } });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("control_refused"));
    expect(captured).toHaveLength(0);
  });

  it("refuses an advanced provider value against an empty known-fields list — fail closed", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ providerInputs: { magic_knob: 1 } });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("provider_input_rejected"));
    expect(captured).toHaveLength(0);
  });

  // The pre-spend gate over the raw bag: a key another path owns, or a value
  // the probed descriptor can prove wrong, refuses with the OWNING layer's
  // message — the error text is asserted because the generic unknown-field
  // fallback above settles the same code, and the transport writes the bag
  // LAST, so a collision it let through would silently overwrite the admin's
  // own dedicated image, a curated-LoRA selection, or a reviewed pin.
  const ownedBagCases: {
    rejects: string;
    modelId: string;
    providerInputs: Record<string, string | number | boolean>;
    detail: string;
  }[] = [
    {
      rejects: "a dedicated image-input field",
      modelId: DEDICATED_MODEL_ID,
      providerInputs: { pose_image: "x" },
      detail: "dedicated image input",
    },
    {
      rejects: "a reviewed extraInput pin",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { go_fast: false },
      detail: "pinned by the model's reviewed configuration",
    },
    {
      rejects: "a curated-LoRA control binding",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { lora_weights: "https://example.com/weights.safetensors" },
      detail: "curated LoRA library",
    },
    {
      rejects: "a descriptor type violation",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { num_inference_steps: "thirty" },
      detail: "expects an integer",
    },
    {
      rejects: "a descriptor range violation",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { num_inference_steps: 200 },
      detail: "must be at most 50",
    },
  ];
  it.each(ownedBagCases)("refuses a provider value the pre-spend gate owns: $rejects", async ({ modelId, providerInputs, detail }) => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId, providerInputs });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("provider_input_rejected"));
    expect(row?.error).toContain(detail);
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Provider failure vs local persistence failure
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator render settlement", () => {
  it("settles a provider failure with the classifier's reading and a failed-lane report", async () => {
    setImageGeneratorRendererForTesting((request) => {
      captured.push(request);
      return Promise.resolve({ ok: false, error: "replicate 503: service unavailable", predictionId: "pred_gen_dead" });
    });
    const { id, sink } = await createRun();

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    // Evidence about the upstream: the seam was reached and answered badly.
    expect(payload.providerOutcome).toBe(false);
    const row = await storedRow(id);
    expect(row?.status).toBe("failed");
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("render_failed"));
    expect(row?.error).toContain("503");
    expect(row?.predictionId).toBe("pred_gen_dead");
    // The compiled prompt was recorded BEFORE the spend.
    expect(row?.finalPrompt).not.toBeNull();
    // And so was the plan outcome: the failure settle merges its classifier
    // reading over the stored bag, so `outcome` survives beside `renderFailure`
    // instead of being erased by the settle's own meta write.
    const meta = imageMeta(row?.meta);
    expect(meta).toMatchObject({ outcome: { sentRoles: [], dedicatedFields: [], renumbered: false } });
    expect(meta.renderFailure).toBeDefined();
  });

  it("keeps a local write failure off the provider's record", async () => {
    setImageGeneratorRendererForTesting((request) => {
      captured.push(request);
      // The provider "answered" with bytes storage cannot decode — the write
      // fails after a genuinely successful render.
      return Promise.resolve({ ok: true, image: Buffer.from("not an image"), predictionId: "pred_gen_store" });
    });
    const { id, sink } = await createRun();

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    // The provider rendered; OUR disk did not take it.
    expect(payload.providerOutcome).toBe(true);
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("output_store_failed"));
    expect(row?.resultImageId).toBeNull();
    // The pending asset row was reclaimed — no hidden straggler survives.
    const strays = await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId));
    expect(strays).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deletion and owner scoping
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator records", () => {
  it("deletes a run and the hidden output it points at", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();
    await runImageGeneratorRun(id, ownerId, sink);
    const run = await getImageGeneratorRunDetail(id, ownerId);
    const outputId = run?.resultImageId ?? "";
    expect(outputId).not.toBe("");

    const result = await deleteImageGeneratorRun(id, ownerId);

    expect(result).toEqual({ deleted: true, outputImagesRemoved: 1 });
    expect(await storedRow(id)).toBeUndefined();
    const [output] = await db().select({ id: images.id }).from(images).where(eq(images.id, outputId)).limit(1);
    expect(output).toBeUndefined();
  });

  it("answers another owner with nothing — read and delete alike", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();
    await runImageGeneratorRun(id, ownerId, sink);

    expect(await getImageGeneratorRunDetail(id, otherOwnerId)).toBeNull();
    expect(await deleteImageGeneratorRun(id, otherOwnerId)).toEqual({ deleted: false, outputImagesRemoved: 0 });
    // The run and its output are untouched by the foreign attempt.
    const row = await storedRow(id);
    expect(row?.status).toBe("succeeded");
    expect(row?.resultImageId).not.toBeNull();
  });
});
