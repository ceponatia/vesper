import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { FAL_QWEN3_TEXT_SLUG } from "@vesper/image-models";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  type ImageGeneratorCreateRunRequest,
  imageGeneratorDiagnosticCode,
} from "@/contracts/images/image-generator";
import {
  imageGeneratorRunOutputImageIds,
  imageGeneratorRunOutputsOf,
} from "@/contracts/images/image-generator-outputs";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { db, imageGeneratorRuns, imageLoras, imageModels, images } from "../db";
import { createImageAsset, imageMeta, saveImageBuffer, type ImageKind } from "./asset-storage";
import { setImageGeneratorRendererForTesting, type GeneratorRenderRequest } from "./image-generator-render";
import { runImageGeneratorRun } from "./image-generator-run";
import {
  createImageGeneratorRun,
  deleteImageGeneratorRun,
  deleteImageGeneratorRuns,
  getImageGeneratorRunDetail,
  type ImageGeneratorRunRow,
} from "./image-generator-store";

/**
 * The Image Generator's server half end to end against DATABASE_URL and a
 * sandboxed DATA_ROOT. The renderer seam is always injected — Replicate is
 * never called —
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
const STRUCTURAL_MODEL_ID = "imgmdlgenstructuralaaaaa";
const REQUIRED_CONTROL_MODEL_ID = "imgmdlgenreqcontrolaaaaa";
const REPROBED_MODEL_ID = "imgmdlgenreprobedaaaaaaa";
const SIZE_MODEL_ID = "imgmdlgensizemodeaaaaaaa";
const FAL_MODEL_ID = "imgmdlgenfalqwen3aaaaaaa";
const FIXTURE_MODEL_IDS = [
  PINNED_MODEL_ID,
  UNPINNED_MODEL_ID,
  CAPPED_MODEL_ID,
  GENERATE_ONLY_MODEL_ID,
  DEDICATED_MODEL_ID,
  DISPOSABLE_MODEL_ID,
  EDIT_ONLY_MODEL_ID,
  ADVANCED_MODEL_ID,
  STRUCTURAL_MODEL_ID,
  REQUIRED_CONTROL_MODEL_ID,
  REPROBED_MODEL_ID,
  SIZE_MODEL_ID,
  FAL_MODEL_ID,
];

const PINNED_SLUG = "vesper-test/generator-pinned";
const UNPINNED_SLUG = "vesper-test/generator-floating";
const CAPPED_SLUG = "vesper-test/generator-one-reference";
const GENERATE_ONLY_SLUG = "vesper-test/generator-text-only";
const DEDICATED_SLUG = "vesper-test/generator-dedicated";
const DISPOSABLE_SLUG = "vesper-test/generator-disposable";
const EDIT_ONLY_SLUG = "vesper-test/generator-edit-only";
const ADVANCED_SLUG = "vesper-test/generator-advanced";
const STRUCTURAL_SLUG = "vesper-test/generator-structural";
const REQUIRED_CONTROL_SLUG = "vesper-test/generator-required-control";
const REPROBED_SLUG = "vesper-test/generator-reprobed";
const SIZE_SLUG = "vesper-test/generator-size-mode";
const FAL_SCHEMA_REVISION = "fal-qwen3-text-schema-2026-09-11";
/**
 * A LoRA the library curates for SCENE renders only — deliberately not for the
 * synthetic profile's nominal `item` task. It is the exact row shape the bench
 * used to refuse.
 */
const BENCH_LORA_ID = "imglorabenchonlyaaaaaaaa";
const PINNED_VERSION = "generatorversionaaaaaaaa";
const REPROBED_VERSION = "generatorversionbbbbbbbb";
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
        // Declared shapes, so the native-versus-explicit shape cases have a
        // real enum to pick from — and something to prove is NOT sent by
        // default.
        supportedAspects: ["1:1", "3:4"],
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
          // Declared fields but NO provider-input descriptors — the shape every
          // row registered before descriptors existed still has.
          knownInputFields: ["prompt", "pose_image", "extra_image"],
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
            // Shapes the raw bag has no honest scalar spelling for. They are
            // declared and NOT reserved on purpose: the refusal must come from
            // the shape, not from someone else already owning the field.
            { field: "extra_image", type: "uri", required: false, reserved: false },
            { field: "tags", type: "array", required: false, reserved: false },
            { field: "aspect_ratio", type: "enum", required: false, enumValues: ["1:1"], reserved: true },
          ],
        },
      },
      {
        // A GENERATOR with a required structural input and no primary
        // reference binding: prompt-driven, `canEdit: false`, one required
        // `pose_image`. Before the operation rule was capability-driven this
        // model was unrunnable — without the pose the required-input gate
        // refused, and with it the operation flipped to `edit`.
        id: STRUCTURAL_MODEL_ID,
        slug: STRUCTURAL_SLUG,
        label: "Generator Structural-Input Fixture",
        canGenerate: true,
        canEdit: false,
        maxReferences: 0,
        probedVersionId: PINNED_VERSION,
        advancedCapabilities: {
          additionalImageInputs: [
            { roleHint: "pose", binding: { field: "pose_image", arity: "single", required: true } },
          ],
          providerInputs: [
            { field: "prompt", type: "string", required: true, reserved: true },
            { field: "pose_image", type: "uri", required: true, reserved: true },
          ],
        },
      },
      {
        // A version that REQUIRES a field Vesper binds as a normalized control
        // and declares no default for it. The raw bag may not fill a reserved
        // field, so only the final pass over the assembled payload can catch
        // the omission before the provider does.
        id: REQUIRED_CONTROL_MODEL_ID,
        slug: REQUIRED_CONTROL_SLUG,
        label: "Generator Required-Control Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
        advancedCapabilities: {
          controls: { guidance: { field: "cfg", type: "number" } },
          providerInputs: [
            { field: "prompt", type: "string", required: true, reserved: true },
            { field: "cfg", type: "number", required: true, reserved: true },
          ],
        },
      },
      {
        // Re-probed mid-test so a settled run's captured version stops matching
        // the registry's current pin — the whole duplicate-replay question.
        id: REPROBED_MODEL_ID,
        slug: REPROBED_SLUG,
        label: "Generator Re-probed Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
        // A seed binding, so a replay case can prove the explicit seed
        // survives rather than being refused for want of a field.
        advancedCapabilities: { controls: { seed: { field: "seed", type: "integer" } } },
      },
      {
        // A size-mode model whose declared members share one ratio — the shape
        // the largest-area tie-break would silently substitute.
        id: SIZE_MODEL_ID,
        slug: SIZE_SLUG,
        label: "Generator Size-Mode Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        aspectMode: "size",
        supportedAspects: ["768*1024", "1536*2048"],
        probedVersionId: PINNED_VERSION,
        // Wan's real shape: the tier and the shape list are one provider input.
        advancedCapabilities: {
          controls: { resolutionTier: { field: "size", type: "enum", enumValues: ["1K", "2K"] } },
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
      {
        // fal exposes a normalized 1K/2K control, but the transport writes the
        // provider's custom {width,height} ImageSize object.
        id: FAL_MODEL_ID,
        slug: FAL_QWEN3_TEXT_SLUG,
        label: "Generator fal Qwen 3 Fixture",
        canGenerate: true,
        canEdit: false,
        referenceField: "image_urls",
        referenceArity: "array",
        referenceTransport: "data_url",
        maxReferences: 0,
        aspectMode: "aspect_ratio",
        supportedAspects: ["1:1", "3:4"],
        outputFormat: "png",
        extraInput: {
          enable_safety_checker: false,
          enable_prompt_expansion: false,
          num_images: 1,
          output_format: "png",
        },
        probedVersionId: FAL_SCHEMA_REVISION,
        advancedCapabilities: {
          prompt: { field: "prompt", maxChars: 5000 },
          controls: {
            resolutionTier: { field: "image_size", type: "enum", enumValues: ["1K", "2K"] },
          },
          providerInputs: [
            { field: "prompt", type: "string", required: true, reserved: true },
            { field: "image_size", type: "unknown", required: false, reserved: true },
          ],
        },
      },
    ]);

  // Mechanically perfect for the advanced fixture — right model, a scale inside
  // both bands, and a version list short enough not to pin anything — and
  // curated for `scene` alone. Planted delete-first like the model rows,
  // because the library is global too.
  await db().delete(imageLoras).where(eq(imageLoras.id, BENCH_LORA_ID));
  await db()
    .insert(imageLoras)
    .values({
      id: BENCH_LORA_ID,
      label: "Bench-only Fixture LoRA",
      locatorType: "civitai_model_version",
      locator: "1234567",
      compatibleModelSlugs: [ADVANCED_SLUG],
      compatibleVersionIds: [],
      defaultScale: 1,
      minimumScale: 0.5,
      maximumScale: 1.5,
      allowedTasks: ["scene"],
    });
});

afterAll(async () => {
  if (ready) {
    await db().delete(imageLoras).where(eq(imageLoras.id, BENCH_LORA_ID));
    await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  }
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
  // Both owners: the batch-delete case below plants a row under the second one,
  // and a survivor left behind would be a fixture the next test never asked for.
  await db().delete(imageGeneratorRuns).where(inArray(imageGeneratorRuns.ownerId, [ownerId, otherOwnerId]));
  await db().delete(images).where(inArray(images.ownerId, [ownerId, otherOwnerId]));
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
// Bench execution: the context and the budgets that are the Generator's alone
// ---------------------------------------------------------------------------

/**
 * The two facts that make the Generator a BENCH rather than a production lane
 * borrowing production's rules, both of them app wiring that no package test
 * can reach: which execution context this runner resolves a LoRA under, and
 * that the intent it builds carries an execution policy at all.
 */
describe.skipIf(!ready)("image generator bench execution", () => {
  it("runs a LoRA the library curates for another task, because the bench serves no task", async () => {
    // Falsified against the pre-adapter runner, which passed the synthetic
    // profile's nominal `item` task and settled `image_lora.incompatible` — a
    // mechanically perfect LoRA refused for breaking a curation rule about a
    // lane the bench is not in. The row below is still curated for `scene`
    // only; what changed is that `generator_bench` asks no task question.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({
      modelId: ADVANCED_MODEL_ID,
      controls: { lora: { id: BENCH_LORA_ID } },
    });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    expect(run?.failureCode).toBeNull();
    // Resolved, not merely un-refused: the weights the payload will carry are
    // the row's, at the row's curated default strength.
    expect(captured[0]?.intent.resolvedLora).toMatchObject({ id: BENCH_LORA_ID, scale: 1 });
  });

  it("records every provider attempt beside the run's own record, final attempt in the column", async () => {
    // A cold-start abort followed by a successful retry. Without this the row
    // would show one prediction and no sign that the queue killed the first —
    // the exact confusion the two-phase budget exists to end, and a passthrough
    // that is silently droppable at four separate hops.
    setImageGeneratorRendererForTesting(async (request) => {
      captured.push(request);
      return {
        ok: true,
        image: await testPngBuffer(),
        predictionId: "pred_generator_retry",
        executedVersionId: EXECUTED_VERSION,
        attempts: [
          { predictionId: "pred_generator_queued", outcome: "startup_timeout", queuedMs: 480_000 },
          { predictionId: "pred_generator_retry", outcome: "succeeded", queuedMs: 12_000, renderMs: 41_000 },
        ],
      };
    });
    const { id, sink } = await createRun();

    const payload = await runImageGeneratorRun(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    // The bench asked to be watched in two phases; without a policy on the
    // intent the transport reports no attempts at all and a queued render is
    // aborted at the single budget, which is the defect Stage 2 fixed.
    expect(captured[0]?.intent.executionPolicy).toBeDefined();

    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    expect(run?.providerAttempts).toEqual([
      { predictionId: "pred_generator_queued", outcome: "startup_timeout", queuedMs: 480_000 },
      { predictionId: "pred_generator_retry", outcome: "succeeded", queuedMs: 12_000, renderMs: 41_000 },
    ]);
    // The provenance column keeps describing the FINAL attempt, so every reader
    // that predates the history reads exactly what it always did.
    expect(run?.predictionId).toBe("pred_generator_retry");
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
    {
      // A direct admin API caller typing an address into a URI field: the
      // owner-scoped picker is the only path to an image, and the server —
      // not the form's editor filter — is what enforces that.
      rejects: "an arbitrary address in a URI field",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { extra_image: "https://elsewhere.invalid/face.png" },
      detail: "takes an image address",
    },
    {
      rejects: "a scalar in a list field",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { tags: "portrait" },
      detail: "takes a list",
    },
    {
      rejects: "a render-owned reserved field",
      modelId: ADVANCED_MODEL_ID,
      providerInputs: { aspect_ratio: "1:1" },
      detail: "owned by the render path",
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
// Structural inputs, shape, and the pre-spend payload gate
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator structural-input models", () => {
  it("refuses a required structural input before spend when none was selected", async () => {
    // The planner owns this refusal, so its code travels verbatim — the
    // Generator never restates another layer's vocabulary.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: STRUCTURAL_MODEL_ID });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    expect((await storedRow(id))?.failureCode).toBe("image_profile.required_control_input_missing");
    expect(payload.providerOutcome).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("runs a dedicated-only model as GENERATION and routes the image to its probed field", async () => {
    // The bug this kills: "any selected image means edit", which made a
    // prompt-driven model with a required `pose_image` and `canEdit: false`
    // impossible to execute at all. The provider field is never spelled in
    // application code — it comes from the fixture's own capability record.
    stubSuccessfulRenderer();
    const poseId = await seedReadyImage("lab_output");
    const { id, sink } = await createRun({
      modelId: STRUCTURAL_MODEL_ID,
      inputs: { primary: [], dedicated: [{ role: "pose", imageId: poseId }] },
    });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    const request = captured.at(0);
    expect(request?.intent.profile.profile.operation).toBe("generate");
    expect(request?.intent.references.map((reference) => reference.role)).toEqual(["pose"]);
    const meta = imageMeta((await storedRow(id))?.meta);
    expect(meta["outcome"]).toMatchObject({ sentRoles: [], dedicatedFields: ["pose_image"] });
    expect(meta["effectiveRequest"]).toMatchObject({
      dedicatedInputs: [{ imageId: poseId, role: "pose", providerField: "pose_image" }],
    });
  });
});

describe.skipIf(!ready)("image generator output shape", () => {
  it("asks for the model's own shape by default and records that nothing was cropped", async () => {
    // Falsified against the pre-policy runner, which named Vesper's 3:4
    // production target on every raw run — choosing a provider bucket the
    // admin never picked and cropping the answer to reach it.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();

    await runImageGeneratorRun(id, ownerId, sink);

    expect(captured.at(0)?.intent.target.aspectRatio).toBeNull();
    expect(imageMeta((await storedRow(id))?.meta)["effectiveRequest"]).toMatchObject({
      shape: { mode: "provider_default", field: null, value: null },
      postprocess: { cropTarget: null },
    });
  });

  it("maps an explicitly chosen shape through the version's own enum", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ controls: { aspect: "1:1" } });

    await runImageGeneratorRun(id, ownerId, sink);

    expect(captured.at(0)?.intent.target.aspectRatio).toBe(1);
    expect(imageMeta((await storedRow(id))?.meta)["effectiveRequest"]).toMatchObject({
      shape: { mode: "explicit", requestedAspect: "1:1", field: "aspect_ratio", value: "1:1" },
    });
  });

  it("records fal's custom dimensions as the effective provider request and sent shape", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({
      modelId: FAL_MODEL_ID,
      controls: { aspect: "3:4", resolution: "2K" },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    expect(imageMeta((await storedRow(id))?.meta)["effectiveRequest"]).toMatchObject({
      providerRequest: { image_size: { width: 1536, height: 2048 } },
      shape: {
        mode: "explicit",
        requestedAspect: "3:4",
        field: "image_size",
        value: { width: 1536, height: 2048 },
      },
    });
  });

  it("refuses a resolution tier on a model whose shape list IS its size list", async () => {
    // Falsified against the version that let the tier through: it mapped onto
    // the reserved `size` key, was filtered out of the payload, and surfaced as
    // `provider_input_rejected` naming a provider field the operator can
    // neither see nor set.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: SIZE_MODEL_ID, controls: { resolution: "2K" } });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("control_refused"));
    expect(row?.error).toContain("output shape");
    expect(captured).toHaveLength(0);
  });

  it("refuses when the chosen shape resolves to a different declared member", async () => {
    // Several members can share one ratio (Wan's three 3:4 sizes), and the
    // largest-area tie-break would answer a request for one with another.
    // Production wants that resolution; a bench must not have its explicit
    // pick replaced.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: SIZE_MODEL_ID, controls: { aspect: "768*1024" } });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("control_refused"));
    expect(row?.error).toContain("1536*2048");
    expect(captured).toHaveLength(0);
  });

  it("refuses a shape the active version no longer offers rather than picking the nearest", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ controls: { aspect: "21:9" } });

    await runImageGeneratorRun(id, ownerId, sink);

    expect((await storedRow(id))?.failureCode).toBe(imageGeneratorDiagnosticCode("control_refused"));
    expect(captured).toHaveLength(0);
  });
});

describe.skipIf(!ready)("image generator pre-spend payload gate", () => {
  it("refuses an empty prompt on a version whose schema requires one", async () => {
    // Prompt requiredness is a capability fact, so the contract accepts an
    // empty prompt and the version decides. A record with no prompt descriptor
    // says nothing, and silence is refused rather than guessed at.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: STRUCTURAL_MODEL_ID, prompt: "" });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("prompt_required"));
    expect(captured).toHaveLength(0);
  });

  it("refuses any advanced value on a model with no probed provider-input descriptors", async () => {
    // `knownInputFields` lists every declared property, URI inputs included, so
    // accepting the bag on a descriptor-less record would let a direct API
    // caller hand the provider an arbitrary address. The form shows no advanced
    // editor on such a row, so this closes the API path only.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({
      modelId: DEDICATED_MODEL_ID,
      providerInputs: { extra_image: "https://elsewhere.invalid/face.png" },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("provider_input_rejected"));
    expect(row?.error).toContain("re-probe");
    expect(captured).toHaveLength(0);
  });

  it("refuses a required provider field bound to a normalized control the run left unset", async () => {
    // The raw bag may not fill a reserved field, so this omission is invisible
    // to every earlier check — without the final pass the provider is the
    // first to notice, after the money.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: REQUIRED_CONTROL_MODEL_ID });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("provider_input_rejected"));
    expect(row?.error).toContain("cfg");
    expect(payload.providerOutcome).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("runs once the normalized control fills that field, and records the field it filled", async () => {
    // The same fixture from the other side — and the provenance answer the
    // whole snapshot exists for: a row saying "guidance 4" cannot say whether
    // the provider received `guidance: 4` or `cfg: 4`.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: REQUIRED_CONTROL_MODEL_ID, controls: { guidance: 4 } });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(imageMeta((await storedRow(id))?.meta)["effectiveRequest"]).toMatchObject({
      providerRequest: { cfg: 4 },
    });
  });

  it("records the whole provider request, not only the mapped controls", async () => {
    // A record listing `controlInput` alone says nothing about the model row's
    // own pinned fields — which the provider is definitely sent, and which the
    // reviewed-quality seam adds more of on the way out.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: ADVANCED_MODEL_ID });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(imageMeta((await storedRow(id))?.meta)["effectiveRequest"]).toMatchObject({
      providerRequest: { go_fast: true, prompt: expect.stringContaining("lighthouse") as unknown as string },
    });
  });

  it("refuses a strict-policy transport refusal as an unspent capacity failure", async () => {
    // The transport says "these selected references cannot travel" and creates
    // no prediction; the run must settle as an unspent refusal that names them,
    // never as a provider failure that charges the lane.
    const referenceId = await seedReadyImage();
    setImageGeneratorRendererForTesting(async (request) => {
      captured.push(request);
      return {
        ok: false,
        error: "cannot carry every selected reference",
        unsentReferences: [{ index: 1, role: "reference", reason: "inline_byte_budget" }],
      };
    });
    const { id, sink } = await createRun({
      inputs: { primary: [{ imageId: referenceId }, { imageId: referenceId }], dedicated: [] },
    });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    expect(payload.providerOutcome).toBeNull();
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("capacity_exceeded"));
    expect(row?.resultImageId).toBeNull();
    expect(row?.predictionId).toBeNull();
    expect(imageMeta(row?.meta)["result"]).toMatchObject({
      spent: false,
      unsentReferences: [{ index: 1, role: "reference", reason: "inline_byte_budget" }],
    });
  });
});

// ---------------------------------------------------------------------------
// Duplicate, version replay, and the claim
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image generator version replay", () => {
  /** Move the re-probed fixture's pin, so a settled run's capture stops matching. */
  async function reprobeTo(versionId: string): Promise<void> {
    await db().update(imageModels).set({ probedVersionId: versionId }).where(eq(imageModels.id, REPROBED_MODEL_ID));
  }

  /** A settled run on the re-probed fixture, then a pin that has moved past it. */
  async function settledSourceThenDrift(): Promise<string> {
    await reprobeTo(PINNED_VERSION);
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ modelId: REPROBED_MODEL_ID, controls: { seed: 4242 } });
    const payload = await runImageGeneratorRun(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");
    await reprobeTo(REPROBED_VERSION);
    return id;
  }

  it("runs the current registered version when the duplicate does not ask to replay", async () => {
    const sourceId = await settledSourceThenDrift();
    captured = [];
    const { id, sink } = await createRun({
      modelId: REPROBED_MODEL_ID,
      sourceRunId: sourceId,
      controls: { seed: 4242 },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.status).toBe("succeeded");
    expect(row?.requestedVersionId).toBe(REPROBED_VERSION);
    expect(row?.sourceRunId).toBe(sourceId);
  });

  it("replays the exact captured version against the capability record that run stored", async () => {
    const sourceId = await settledSourceThenDrift();
    captured = [];
    const { id, sink } = await createRun({
      modelId: REPROBED_MODEL_ID,
      sourceRunId: sourceId,
      versionPolicy: "captured",
      controls: { seed: 4242 },
    });

    await runImageGeneratorRun(id, ownerId, sink);

    const row = await storedRow(id);
    expect(row?.status).toBe("succeeded");
    expect(row?.requestedVersionId).toBe(PINNED_VERSION);
    expect(captured.at(0)?.intent.versionId).toBe(PINNED_VERSION);
    // The explicit seed survives the replay — a variant that lost it would be
    // a different composition wearing the same request.
    expect(captured.at(0)?.intent.controls?.seed).toBe(4242);
  });

  it("refuses a replay whose source recorded no capability record for that version", async () => {
    // The honest half: without the stored snapshot, Vesper would be pointing
    // today's field bindings at yesterday's weights.
    await reprobeTo(PINNED_VERSION);
    stubSuccessfulRenderer();
    const { id: sourceId, sink: sourceSink } = await createRun({ modelId: REPROBED_MODEL_ID });
    await runImageGeneratorRun(sourceId, ownerId, sourceSink);
    await db()
      .update(imageGeneratorRuns)
      .set({ meta: {} })
      .where(eq(imageGeneratorRuns.id, sourceId));
    await reprobeTo(REPROBED_VERSION);
    captured = [];

    const { id, sink } = await createRun({
      modelId: REPROBED_MODEL_ID,
      sourceRunId: sourceId,
      versionPolicy: "captured",
    });
    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("version_replay_unsafe"));
    // The current version is NOT substituted — that is the whole point.
    expect(row?.requestedVersionId).toBeNull();
    expect(captured).toHaveLength(0);
  });
});

describe.skipIf(!ready)("image generator run claim", () => {
  it("spends once when the same run is delivered to two workers at once", async () => {
    // A read-then-write claim let both deliveries see `pending` and both buy a
    // prediction; one immutable run must never be charged twice.
    stubSuccessfulRenderer();
    const { id, sink } = await createRun();

    const [first, second] = await Promise.all([
      runImageGeneratorRun(id, ownerId, sink),
      runImageGeneratorRun(id, ownerId, sink),
    ]);

    expect(captured).toHaveLength(1);
    const outcomes = [first.status ?? first.skipped, second.status ?? second.skipped];
    expect(outcomes).toContain("succeeded");
    expect(outcomes.filter((outcome) => outcome === "succeeded")).toHaveLength(1);
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

  // Falsified against a batch delete whose row statement matches the REQUESTED
  // ids instead of the owned subset. That implementation passes the single
  // foreign id above — one unowned id makes the batch return before the delete
  // ever runs — and destroys another admin's run the moment one list mixes both,
  // which is exactly what the list's multi-select delete sends.
  it("deletes only this admin's rows when one batch also names another owner's run", async () => {
    stubSuccessfulRenderer();
    const mine = await createRun();
    await runImageGeneratorRun(mine.id, ownerId, mine.sink);
    const alsoMine = await createRun();
    await runImageGeneratorRun(alsoMine.id, ownerId, alsoMine.sink);

    const foreign = await createImageGeneratorRun({
      ownerId: otherOwnerId,
      request: { modelId: PINNED_MODEL_ID, prompt: "The other admin's own bench run." },
    });
    if (!foreign.ok) throw new Error(`unexpected create refusal: ${foreign.refusal.code}`);
    await runImageGeneratorRun(foreign.run.id, otherOwnerId);

    const result = await deleteImageGeneratorRuns(
      [mine.id, alsoMine.id, foreign.run.id, mine.id],
      ownerId,
    );

    // Two rows and their two outputs: the repeated id counts once, and the
    // foreign id is absent rather than refused.
    expect(result).toEqual({ deleted: 2, outputImagesRemoved: 2 });
    expect(await storedRow(mine.id)).toBeUndefined();
    expect(await storedRow(alsoMine.id)).toBeUndefined();

    const survivor = await storedRow(foreign.run.id);
    expect(survivor?.status).toBe("succeeded");
    const [output] = await db()
      .select({ id: images.id })
      .from(images)
      .where(eq(images.id, survivor?.resultImageId ?? ""))
      .limit(1);
    expect(output).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// More than one image per run
// ---------------------------------------------------------------------------

/**
 * A renderer that answers each pass of a fan-out in turn, so the passes can be
 * told apart — `provider_failed` is a prediction the provider lost.
 */
function stubSequencedRenderer(passes: readonly ("ok" | "provider_failed")[]): void {
  let pass = 0;
  setImageGeneratorRendererForTesting(async (request) => {
    captured.push(request);
    const outcome = passes[pass] ?? "ok";
    pass += 1;
    const predictionId = `pred_generator_${String(pass)}`;
    if (outcome === "provider_failed") {
      return { ok: false, error: "replicate 503: service unavailable", predictionId };
    }
    return { ok: true, image: await testPngBuffer(), predictionId, executedVersionId: EXECUTED_VERSION };
  });
}

describe.skipIf(!ready)("image generator multi-image runs", () => {
  // Falsified against a runner that renders once whatever the count says: every
  // registered model returns one image per prediction, so N images can only be
  // N predictions — and against a delete that sweeps `result_image_id` alone,
  // which would leave two hidden images with nothing in the database pointing
  // at them.
  it("renders one prediction per image from a single compiled plan, and deletes every one of them", async () => {
    stubSequencedRenderer(["ok", "ok", "ok"]);
    const { id, sink } = await createRun({ controls: { imageCount: 3 } });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(payload.providerOutcome).toBe(true);
    // ONE compiled intent, handed to the seam three times — object identity,
    // because a runner that re-planned per image would re-decide the request
    // (and re-run the pre-spend gates) between paid predictions.
    expect(captured).toHaveLength(3);
    expect(captured[1]?.intent).toBe(captured[0]?.intent);
    expect(captured[2]?.intent).toBe(captured[0]?.intent);
    // No seed travels: an unseeded fan-out leaves each prediction to the
    // provider, which is what makes three renders three different pictures.
    expect(captured.every((request) => request.intent.controls?.seed === undefined)).toBe(true);

    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    const outputs = imageGeneratorRunOutputsOf({ result: run?.result ?? null });
    expect(outputs.map((output) => output.index)).toEqual([1, 2, 3]);
    expect(outputs.map((output) => output.predictionId)).toEqual([
      "pred_generator_1",
      "pred_generator_2",
      "pred_generator_3",
    ]);
    const storedIds = imageGeneratorRunOutputImageIds(outputs);
    expect(storedIds).toHaveLength(3);
    // The column keeps naming the FIRST output — the thumbnail, the lineage
    // pointer and the FK-SET-NULL target are unchanged by a fan-out.
    expect(run?.resultImageId).toBe(storedIds[0]);
    expect(run?.predictionId).toBe("pred_generator_1");
    expect(await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId))).toHaveLength(3);

    const result = await deleteImageGeneratorRun(id, ownerId);

    expect(result).toEqual({ deleted: true, outputImagesRemoved: 3 });
    expect(await db().select({ id: images.id }).from(images).where(eq(images.ownerId, ownerId))).toHaveLength(0);
  });

  // Falsified against a settle that fails the whole run when any pass failed:
  // that discards paid images the operator can no longer see, and reports a
  // dead lane to the breaker on the strength of a provider that answered twice.
  it("keeps what a partly failed fan-out rendered, and reports the provider alive", async () => {
    stubSequencedRenderer(["ok", "provider_failed", "ok"]);
    const { id, sink } = await createRun({ controls: { imageCount: 3 } });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(payload.providerOutcome).toBe(true);
    const run = await getImageGeneratorRunDetail(id, ownerId, sink);
    expect(run?.status).toBe("succeeded");
    expect(run?.failureCode).toBeNull();
    const outputs = imageGeneratorRunOutputsOf({ result: run?.result ?? null });
    expect(outputs.map((output) => output.failureCode)).toEqual([
      null,
      imageGeneratorDiagnosticCode("render_failed"),
      null,
    ]);
    expect(imageGeneratorRunOutputImageIds(outputs)).toHaveLength(2);
  });

  // Falsified against a runner that drops the seed, or trims the count, to make
  // the pair work: both spend real money on a request nobody made, and the
  // seeded arm would render the same picture three times over.
  it("refuses an explicit seed beside a multi-image count, before spend", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRun({ controls: { seed: 7, imageCount: 3 } });

    const payload = await runImageGeneratorRun(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    expect(payload.providerOutcome).toBeNull();
    expect(captured).toHaveLength(0);
    const row = await storedRow(id);
    expect(row?.failureCode).toBe(imageGeneratorDiagnosticCode("control_refused"));
    expect(row?.error).toContain("seed 7");
    expect(codes(sink)).toContain(imageGeneratorDiagnosticCode("control_refused"));
  });
});
