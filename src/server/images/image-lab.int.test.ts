import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  imageLabControlSchema,
  imageLabDiagnosticCode,
  type ImageLabControlKind,
  type ImageLabCreateExperimentRequest,
} from "@/contracts";
import {
  imageRenderRejection,
  laneHealth,
  readDailyUsage,
  recordProviderOutcome,
  resetProviderHealth,
  startJob,
} from "@/server/api";
import {
  apiRequest,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  testPngDataUrl,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { db, imageLabExperiments, imageModels, images, jobs } from "../db";
import { createImageAsset, HIDDEN_IMAGE_KINDS, imageMeta, saveImageBuffer, type ImageKind } from "./assets";
import {
  createImageLabExperiment,
  deleteImageLabExperiment,
  getImageLabExperimentDetail,
  listImageLabExperiments,
  recordImageLabVerdict,
  runImageLabExperiment,
  setImageLabRendererForTesting,
  type ImageLabRenderRequest,
} from "./image-lab";
import {
  deleteImageLabControl,
  IMAGE_LAB_DEPTH_PREPROCESSOR,
  IMAGE_LAB_POSE_PREPROCESSOR,
  listImageLabControls,
  reviewImageLabControl,
  runImageLabControlExtraction,
  setImageLabPreprocessorForTesting,
  uploadImageLabControl,
} from "./image-lab-controls";

/**
 * The Advanced Image Lab's services end to end against DATABASE_URL and a
 * sandboxed DATA_ROOT (qwen-advanced-image-subsystem.spec.md §"Fixtures and
 * tests"). Both provider seams are always injected — Replicate is never called —
 * so what is under test is the lab's own machinery: the experiment lifecycle,
 * every refusal the spec's §Resilience table names, and the fixture extraction
 * path including its decode gate.
 *
 * Every degradation case asserts BOTH halves docs/resilience.md demands: the
 * degraded OUTCOME (a settled row, an absent asset) and the exact diagnostic
 * code. A test that only checked the outcome would keep passing after a refactor
 * that stopped saying why.
 *
 * Registry rows (`image_models`) are global — outside `purgeOwnerRows` — so this
 * suite plants its own by id, delete-first, exactly like the trial suite does.
 *
 * Two things are reached through `@/server/api` rather than mocked, because they
 * are the whole point of the checks that use them: the real circuit breaker
 * (a lab run's honesty about the provider is only observable as lane health) and
 * the real image guard (whether an edge-only batch spends a budget unit is only
 * observable as a usage counter).
 */

const ready = await probeIntegrationDb("image lab.int.test", "image_lab_experiments");

const PINNED_MODEL_ID = "imgmdlimagelabpinnedaaaa";
const UNPINNED_MODEL_ID = "imgmdlimagelabfloataaaaa";
const CAPPED_MODEL_ID = "imgmdlimagelabcappedaaaa";
const FIXTURE_MODEL_IDS = [PINNED_MODEL_ID, UNPINNED_MODEL_ID, CAPPED_MODEL_ID];

const PINNED_SLUG = "vesper-test/image-lab-pinned";
const UNPINNED_SLUG = "vesper-test/image-lab-floating";
const CAPPED_SLUG = "vesper-test/image-lab-one-reference";
const PINNED_VERSION = "imagelabversionaaaaaaaaa";
/** What the provider "echoes back" — deliberately the pinned one, so a test that
 * asserts both columns proves the runner recorded each from its own source. */
const EXECUTED_VERSION = PINNED_VERSION;

let temp: TempDataRoot | undefined;
let ownerId = "";
/** Captures exactly what the renderer seam was handed, per test. */
let captured: ImageLabRenderRequest[] = [];

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-image-lab-int");
  ownerId = (await seedTestUser("image-lab-int")).id;

  await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  await db()
    .insert(imageModels)
    .values([
      {
        id: PINNED_MODEL_ID,
        slug: PINNED_SLUG,
        label: "Image Lab Pinned Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
        probedVersionId: PINNED_VERSION,
      },
      {
        // No probed version and no version in the slug: nothing can say what this
        // row executes, which is the whole `version_unpinned` refusal.
        id: UNPINNED_MODEL_ID,
        slug: UNPINNED_SLUG,
        label: "Image Lab Floating Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 4,
      },
      {
        // Pinned, and takes exactly ONE reference — the shape that makes an
        // over-ordered experiment a refusal instead of a silently trimmed send.
        id: CAPPED_MODEL_ID,
        slug: CAPPED_SLUG,
        label: "Image Lab One-Reference Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 1,
        probedVersionId: PINNED_VERSION,
      },
    ]);
});

afterAll(async () => {
  if (ready) await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  await temp?.cleanup();
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

beforeEach(() => {
  captured = [];
});

afterEach(async () => {
  setImageLabRendererForTesting(null);
  setImageLabPreprocessorForTesting(null);
  // Lane health is process-global and in memory by design, so a test that drove
  // the breaker must not leave a tripped lane shedding the next one's guard.
  resetProviderHealth();
  if (!ready) return;
  await db().delete(imageLabExperiments).where(eq(imageLabExperiments.ownerId, ownerId));
  await db().delete(images).where(eq(images.ownerId, ownerId));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A ready image row with real bytes on the sandboxed data root. */
async function seedReadyImage(kind: ImageKind, meta: Record<string, unknown> = {}): Promise<string> {
  const asset = await createImageAsset({ ownerId, kind, prompt: "image lab fixture", meta });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer());
  expect(saved?.status).toBe("ready");
  return asset.id;
}

/**
 * A `lab_control` fixture with parseable meta — what a valid probe points at.
 *
 * REVIEWED by default, through the review service rather than by stamping
 * `reviewedAt` into the seeded meta: the runner's review gate reads what the
 * review path writes, and a test that wrote that field itself would keep passing
 * after the two stopped agreeing. `reviewed: false` is the unreviewed fixture the
 * gate exists to refuse.
 */
async function seedControlFixture(
  controlKind: ImageLabControlKind = "pose",
  opts: { reviewed?: boolean } = {},
): Promise<string> {
  const imageId = await seedReadyImage("lab_control", { hidden: true, controlKind, generator: "hand_authored" });
  if (opts.reviewed !== false) {
    const reviewed = await reviewImageLabControl(ownerId, imageId, "seeded fixture, looked at before use");
    expect(reviewed?.ok).toBe(true);
  }
  return imageId;
}

/** A renderer that always succeeds, recording what it was handed. */
function stubSuccessfulRenderer(): void {
  setImageLabRendererForTesting(async (request) => {
    captured.push(request);
    return {
      ok: true,
      image: await testPngBuffer(),
      predictionId: "pred_image_lab_1",
      executedVersionId: EXECUTED_VERSION,
    };
  });
}

async function createProbe(
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector }> {
  const sink = new DiagnosticCollector();
  const request: ImageLabCreateExperimentRequest = {
    kind: "control_probe",
    modelSlug: PINNED_SLUG,
    instruction: "Image 1 is the identity reference. Render that person in the pose drawn in Image 2.",
    inputs: [],
    ...overrides,
  };
  const created = await createImageLabExperiment({ ownerId, request, sink });
  if (!created.ok) throw new Error(`unexpected create refusal: ${created.refusal.code}`);
  return { id: created.experiment.id, sink };
}

/**
 * The shape every runnable probe has: an identity anchor, the reviewed fixture
 * it is a ruling on, and the declaration binding the two. A probe missing any of
 * it is refused before the provider, which is what the binding tests below drive
 * one piece at a time.
 */
async function createRunnableProbe(
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector; identityId: string; controlId: string }> {
  const identityId = await seedReadyImage("avatar");
  const controlId = await seedControlFixture("pose");
  const { id, sink } = await createProbe({
    inputs: [
      { position: 1, role: "identity", imageId: identityId },
      { position: 2, role: "pose", imageId: controlId },
    ],
    controlImageId: controlId,
    controlKind: "pose",
    ...overrides,
  });
  return { id, sink, identityId, controlId };
}

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
}

/** The `jobs` row a fire-and-forget `startJob` writes, once its run has settled. */
async function settledJob(jobId: string, timeoutMs = 10_000): Promise<typeof jobs.$inferSelect> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (row && row.status !== "running" && row.status !== "queued") return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not settle in ${String(timeoutMs)}ms`);
}

/**
 * Run one experiment the way the route runs it — through `startJob`, passing the
 * run's own reading of the provider along — and wait for the job to settle.
 *
 * This is the only path that reaches the real circuit breaker, so it is the only
 * one that can be observed against it.
 */
async function runExperimentAsJob(experimentId: string): Promise<typeof jobs.$inferSelect> {
  const job = await startJob({
    type: "lab_image",
    ownerId,
    payload: { experimentId },
    run: async ({ reportProviderOutcome }) => {
      const result = await runImageLabExperiment(experimentId, ownerId);
      reportProviderOutcome(result.providerOutcome);
      return result;
    },
  });
  if (!job.ok) throw new Error(`lab job refused: ${String(job.active)} of ${String(job.limit)} slots in use`);
  return await settledJob(job.jobId);
}

/**
 * Four consecutive failures on the image lane: one short of the trip, so the
 * lane's health afterwards is a direct readout of what the next run reported.
 */
function primeImageLaneOneShortOfTripping(): void {
  resetProviderHealth();
  for (let i = 0; i < 4; i++) recordProviderOutcome("image", false);
}

// ---------------------------------------------------------------------------

describe.skipIf(!ready)("image lab experiment runs", () => {
  it("renders a control probe, records provenance, and stores a hidden lab output", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const controlId = await seedControlFixture("pose");
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: controlId, note: "skeleton over the sofa shot" },
      ],
      controlImageId: controlId,
      controlKind: "pose",
    });

    const payload = await runImageLabExperiment(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.failureCode).toBeNull();
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    expect(experiment?.executedVersionId).toBe(EXECUTED_VERSION);
    expect(experiment?.predictionId).toBe("pred_image_lab_1");
    // The admin's instruction, verbatim: the runner never rewrites a probe's prompt.
    expect(experiment?.finalPrompt).toBe(experiment?.instruction);

    // Ordered buffers, the pin, and the direct (non-intent) path the Stage 0
    // ruling requires.
    const request = captured[0];
    expect(request?.mode).toBe("direct");
    if (request?.mode === "direct") {
      expect(request.references).toHaveLength(2);
      expect(request.versionId).toBe(PINNED_VERSION);
      expect(request.prompt).toBe(experiment?.instruction);
    }

    const outputId = experiment?.resultImageId ?? "";
    const [output] = await db().select().from(images).where(eq(images.id, outputId)).limit(1);
    expect(output?.kind).toBe("lab_output");
    expect(output?.status).toBe("ready");
    expect(imageMeta(output?.meta).imageLabExperimentId).toBe(id);
    // Hidden by construction: the lab never produces a gallery item.
    expect(HIDDEN_IMAGE_KINDS).toContain("lab_output");
  });

  it("refuses a model whose exact provider version cannot be identified", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({
      modelSlug: UNPINNED_SLUG,
      inputs: [{ position: 1, role: "identity", imageId: identityId }],
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("version_unpinned"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("version_unpinned"));
    // Refused BEFORE any provider spend, which is the point of the rule.
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("refuses stored inputs that no longer parse", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({ inputs: [{ position: 1, role: "identity", imageId: identityId }] });
    // A malformed order reaches the runner exactly as a bad deploy would leave it.
    await db()
      .update(imageLabExperiments)
      .set({ inputs: [{ position: 0, role: "not-a-role" }] })
      .where(eq(imageLabExperiments.id, id));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
  });

  it("refuses an input image this owner cannot read", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createProbe({
      inputs: [{ position: 1, role: "identity", imageId: "imgnotarealimageaaaaaaaa" }],
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    // The pin was resolved before the read, so it is on the record either way.
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    expect(captured).toHaveLength(0);
  });

  it("refuses a control image that is not a lab control fixture", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    // An ordinary portrait wearing a control image's place: owned, ready, and
    // entirely unable to say what fixture it is.
    const notAFixture = await seedReadyImage("portrait_variant");
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: notAFixture },
      ],
      controlImageId: notAFixture,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a lab control fixture whose metadata does not parse", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const unreadable = await seedReadyImage("lab_control", { hidden: true, controlKind: "not-a-kind" });
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: unreadable },
      ],
      controlImageId: unreadable,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
  });

  it("refuses a probe that declares no control fixture at all", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    // Reachable by any direct API call: nothing forces a probe to name a fixture
    // at create time, so the runner is where "a ruling on nothing" is stopped.
    const { id, sink } = await createProbe({ inputs: [{ position: 1, role: "identity", imageId: identityId }] });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a probe whose declared fixture is not the one it sends", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const declared = await seedControlFixture("pose");
    const actuallySent = await seedControlFixture("pose");
    // Declares A, orders B. The runner validates the declaration and renders the
    // inputs, so this would file a verdict against a skeleton the provider never
    // received — with both fixtures valid and reviewed, nothing else would catch it.
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: actuallySent },
      ],
      controlImageId: declared,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a declared fixture sent under a role no control may occupy", async () => {
    stubSuccessfulRenderer();
    const controlId = await seedControlFixture("pose");
    // The fixture IS sent, and it is a reviewed pose skeleton — but as the
    // identity anchor, which asks the model to copy a face from a stick figure.
    const { id, sink } = await createProbe({
      inputs: [{ position: 1, role: "identity", imageId: controlId }],
      controlImageId: controlId,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a fixture nobody has reviewed, before any spend", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const unreviewed = await seedControlFixture("pose", { reviewed: false });
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: unreviewed },
      ],
      controlImageId: unreviewed,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_unreviewed"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_unreviewed"));
    // Separate from `control_invalid` on purpose: the fixture is readable, it
    // just has not been looked at, and the two ask different things of the admin.
    expect(experiment?.failureCode).not.toBe(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("runs the same probe once its fixture is reviewed", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const controlId = await seedControlFixture("pose", { reviewed: false });
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: controlId },
      ],
      controlImageId: controlId,
      controlKind: "pose",
    });

    const reviewed = await reviewImageLabControl(ownerId, controlId, "skeleton reads cleanly; both wrists resolved");
    expect(reviewed?.ok).toBe(true);
    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(captured).toHaveLength(1);
  });

  it("refuses an experiment ordering more references than the model accepts", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const controlId = await seedControlFixture("pose");
    // Two ordered images against a one-reference model. The render path would
    // TRIM the second, leaving a record that claims a control the provider never
    // saw — so the run is refused before any spend instead.
    const { id, sink } = await createProbe({
      modelSlug: CAPPED_SLUG,
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: controlId },
      ],
      controlImageId: controlId,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("capacity_exceeded"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("capacity_exceeded"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
    // The pin was resolved before the capacity read, so it is on the record.
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
  });

  it("discards the output when the experiment is deleted mid-render", async () => {
    const { id, sink } = await createRunnableProbe();
    // An admin clearing a row a deploy left `running` while the provider call is
    // still in flight — deleting a live experiment stays allowed on purpose, so
    // the settle is what has to notice it matched nothing.
    setImageLabRendererForTesting(async (request) => {
      captured.push(request);
      await deleteImageLabExperiment(id, ownerId);
      return {
        ok: true,
        image: await testPngBuffer(),
        predictionId: "pred_image_lab_orphan",
        executedVersionId: EXECUTED_VERSION,
      };
    });

    const payload = await runImageLabExperiment(id, ownerId, sink);

    expect(payload.status).toBe("discarded");
    expect(await getImageLabExperimentDetail(id, ownerId)).toBeNull();
    expect(codes(sink)).toContain("image_lab.output_orphaned");
    // The whole point: no hidden asset outlives the row that was its only pointer.
    const outputs = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_output")));
    expect(outputs).toHaveLength(0);
  });

  it("records a classified provider failure without writing an output", async () => {
    setImageLabRendererForTesting((request) => {
      captured.push(request);
      return Promise.resolve({
        ok: false,
        error: "replicate failed: content moderation flagged this request",
        predictionId: "pred_image_lab_failed",
        executedVersionId: EXECUTED_VERSION,
      });
    });
    const { id, sink } = await createRunnableProbe();

    const payload = await runImageLabExperiment(id, ownerId, sink);
    // A moderation refusal is the provider ANSWERING, about this prompt rather
    // than about its own health, so the breaker hears nothing.
    expect(payload.providerOutcome).toBeNull();

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("render_failed"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("render_failed"));
    expect(experiment?.resultImageId).toBeNull();
    // Provenance survives a failure — it is the only handle back to the
    // provider's own record of what went wrong.
    expect(experiment?.predictionId).toBe("pred_image_lab_failed");

    const [row] = await db()
      .select({ meta: imageLabExperiments.meta })
      .from(imageLabExperiments)
      .where(eq(imageLabExperiments.id, id))
      .limit(1);
    expect(imageMeta(row?.meta).renderFailure).toBe("content_rejection");

    const outputs = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_output")));
    expect(outputs).toHaveLength(0);
  });

  it("never re-runs a settled experiment", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableProbe();

    await runImageLabExperiment(id, ownerId, sink);
    const second = await runImageLabExperiment(id, ownerId, sink);

    expect(second.skipped).toBe("succeeded");
    expect(captured).toHaveLength(1);
    // A run that did nothing reached no provider, so it reports nothing rather
    // than the success its resolved promise would otherwise imply.
    expect(second.providerOutcome).toBeNull();
  });

  it("refuses a baseline whose subject has no reference anchor", async () => {
    stubSuccessfulRenderer();
    const sink = new DiagnosticCollector();
    // No character id can be supplied without owning one, so the honest way to
    // reach this branch is a chat baseline with nothing rendered in the chat.
    const [row] = await db()
      .insert(imageLabExperiments)
      .values({
        ownerId,
        kind: "baseline_scene",
        modelSlug: PINNED_SLUG,
        instruction: "the lane's own settings, on this chat's anchor",
        inputs: [],
        settings: {},
        status: "pending",
      })
      .returning({ id: imageLabExperiments.id });
    const id = row?.id ?? "";

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
  });
});

/**
 * What the lab tells the image lane's circuit breaker, and what it charges.
 *
 * Both matter for the same reason: this runner SETTLES every failure into its
 * own row and resolves, so the job runner's default reading — a resolved run
 * means the provider answered — would report a healthy provider for a dead one,
 * report a success for a refusal that never made a call, and (before the guard's
 * opt-in) bill a provider unit for a convolution run in this process.
 */
describe.skipIf(!ready)("image lab cost and provider health", () => {
  it("reports a working provider when the render succeeds", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableProbe();

    const payload = await runImageLabExperiment(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(payload.providerOutcome).toBe(true);
  });

  it("reports a failed provider for a failure that is evidence about the upstream", async () => {
    setImageLabRendererForTesting(() =>
      Promise.resolve({ ok: false, error: "replicate 503: service unavailable", predictionId: "pred_lab_transient" }),
    );
    const { id, sink } = await createRunnableProbe();

    const payload = await runImageLabExperiment(id, ownerId, sink);

    expect(payload.status).toBe("failed");
    expect(payload.providerOutcome).toBe(false);
  });

  it("reports nothing for a refusal that never reached the provider", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({
      modelSlug: UNPINNED_SLUG,
      inputs: [{ position: 1, role: "identity", imageId: identityId }],
    });

    const payload = await runImageLabExperiment(id, ownerId, sink);

    expect(payload.failureCode).toBe(imageLabDiagnosticCode("version_unpinned"));
    expect(payload.providerOutcome).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it("trips the breaker through the job the route starts", async () => {
    setImageLabRendererForTesting(() =>
      Promise.resolve({ ok: false, error: "replicate 503: service unavailable", predictionId: "pred_lab_transient" }),
    );
    const { id } = await createRunnableProbe();

    primeImageLaneOneShortOfTripping();
    const job = await runExperimentAsJob(id);

    // The fifth consecutive failure. Before the outcome channel this same run
    // recorded a SUCCESS, because settling a dead provider into a row is still a
    // resolved promise — the lane would have read as healthy mid-outage.
    expect(laneHealth("image")).toBe("unhealthy");
    // The job itself succeeded: a settled experiment is not a failed job.
    expect(job.status).toBe("done");
  });

  it("leaves the breaker untouched when the run reached no provider", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const { id } = await createProbe({
      modelSlug: UNPINNED_SLUG,
      inputs: [{ position: 1, role: "identity", imageId: identityId }],
    });

    primeImageLaneOneShortOfTripping();
    await runExperimentAsJob(id);

    // Not tripped, because the refusal added no failure — and not RESET either,
    // which is what tells "reported nothing" apart from "reported a success": one
    // more real failure still trips, so the streak was never cleared.
    expect(laneHealth("image")).toBe("healthy");
    recordProviderOutcome("image", false);
    expect(laneHealth("image")).toBe("unhealthy");
  });

  it("charges no image budget for an edge-only extraction, and keeps the floor for everyone else", async () => {
    const user = { id: ownerId };
    const req = apiRequest("/api/admin/self/image-lab/controls/extract", { method: "POST" });
    const used = async (): Promise<number> => (await readDailyUsage(ownerId, "provider_image_day")).used;
    const before = await used();

    // What the extract route asks for on an edge-only batch: its paid-kind count
    // is zero, and an edge map is a sharp convolution in this process.
    expect(await imageRenderRejection(user, req, { count: 0, allowZeroCount: true })).toBeNull();
    expect(await used()).toBe(before);

    // The opt-in changes nothing else — a paid batch still charges its whole size.
    expect(await imageRenderRejection(user, req, { count: 2, allowZeroCount: true })).toBeNull();
    expect(await used()).toBe(before + 2);

    // And a caller that did not opt in keeps the floor of one, so a batch size
    // that collapsed to zero by accident still costs what a render costs.
    expect(await imageRenderRejection(user, req, { count: 0 })).toBeNull();
    expect(await used()).toBe(before + 3);
  });
});

describe.skipIf(!ready)("image lab experiment records", () => {
  it("refuses a kind Stage 0 has no recipe for", async () => {
    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "finishing_pass", instruction: "", inputs: [] },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("image_lab.kind_unsupported");
  });

  it("refuses a baseline naming another owner's character", async () => {
    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "baseline_portrait", characterId: "chrnotyoursaaaaaaaaaaaaa", instruction: "", inputs: [] },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("image_lab.character_not_found");
  });

  it("records a probe verdict and refuses one on a baseline", async () => {
    const { id } = await createProbe({ inputs: [] });
    const recorded = await recordImageLabVerdict(id, ownerId, {
      verdict: "ignores_control",
      note: "limbs ignored the skeleton entirely",
    });
    expect(recorded?.ok).toBe(true);
    if (recorded?.ok) {
      expect(recorded.experiment.verdict).toBe("ignores_control");
      expect(recorded.experiment.verdictNote).toBe("limbs ignored the skeleton entirely");
    }

    const [baseline] = await db()
      .insert(imageLabExperiments)
      .values({ ownerId, kind: "baseline_scene", modelSlug: PINNED_SLUG, inputs: [], settings: {}, status: "pending" })
      .returning({ id: imageLabExperiments.id });
    const refused = await recordImageLabVerdict(baseline?.id ?? "", ownerId, { verdict: "inconclusive", note: "n/a" });
    expect(refused?.ok).toBe(false);
  });

  it("lists this owner's experiments and deletes one with its output", async () => {
    stubSuccessfulRenderer();
    const { id, sink, identityId } = await createRunnableProbe();
    await runImageLabExperiment(id, ownerId, sink);

    const listed = await listImageLabExperiments(ownerId);
    expect(listed.map((experiment) => experiment.id)).toContain(id);

    const deleted = await deleteImageLabExperiment(id, ownerId);
    expect(deleted).toEqual({ deleted: true, outputImagesRemoved: 1 });
    expect(await getImageLabExperimentDetail(id, ownerId)).toBeNull();

    const outputs = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_output")));
    expect(outputs).toHaveLength(0);
    // The identity input is untouched: the lab deletes what it made, nothing else.
    const [source] = await db().select({ id: images.id }).from(images).where(eq(images.id, identityId)).limit(1);
    expect(source?.id).toBe(identityId);
  });
});

describe.skipIf(!ready)("image lab control fixtures", () => {
  it("computes an edge map in process, with no provider call", async () => {
    setImageLabPreprocessorForTesting(() => {
      throw new Error("edge extraction must never reach a provider");
    });
    const sourceId = await seedReadyImage("avatar");
    const sink = new DiagnosticCollector();

    const payload = await runImageLabControlExtraction({
      ownerId,
      sourceImageId: sourceId,
      controlKinds: ["edge"],
      note: "edge pass over the sofa shot",
      sink,
    });
    expect(payload.sourceImageId).toBe(sourceId);
    // A lane nobody called cannot be shown to be healthy: local work reports
    // nothing rather than closing a tripped breaker on its own success.
    expect(payload.providerOutcome).toBeNull();

    const controls = await listImageLabControls(ownerId, sink);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.meta.controlKind).toBe("edge");
    expect(controls[0]?.meta.generator).toBe("computed_edge");
    expect(controls[0]?.meta.sourceImageId).toBe(sourceId);
    // The extraction's note is the fixture's ORIGIN note — what it was made for.
    // A later review writes `reviewNote` and leaves this standing.
    expect(controls[0]?.meta.originNote).toBe("edge pass over the sofa shot");
    expect(controls[0]?.meta.reviewNote).toBeUndefined();
    // No preprocessor pin is recorded, because none ran.
    expect(controls[0]?.meta.preprocessorSlug).toBeUndefined();
  });

  it("stores a pose fixture with the pin that produced it", async () => {
    setImageLabPreprocessorForTesting(async (request) => {
      expect(request.slug).toBe(IMAGE_LAB_POSE_PREPROCESSOR.slug);
      expect(request.versionId).toBe(IMAGE_LAB_POSE_PREPROCESSOR.versionId);
      return { ok: true, image: await testPngBuffer(), predictionId: "pred_pose_1" };
    });
    const sourceId = await seedReadyImage("avatar");
    const sink = new DiagnosticCollector();

    const payload = await runImageLabControlExtraction({ ownerId, sourceImageId: sourceId, controlKinds: ["pose"], sink });
    expect(payload.providerOutcome).toBe(true);

    const controls = await listImageLabControls(ownerId, sink);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.meta.generator).toBe("extracted_pose");
    expect(controls[0]?.meta.preprocessorSlug).toBe(IMAGE_LAB_POSE_PREPROCESSOR.slug);
    expect(controls[0]?.meta.preprocessorVersionId).toBe(IMAGE_LAB_POSE_PREPROCESSOR.versionId);
  });

  it("writes no asset when the preprocessor answers with bytes sharp cannot decode", async () => {
    setImageLabPreprocessorForTesting(() =>
      Promise.resolve({ ok: true, image: Buffer.from("this is not an image"), predictionId: "pred_depth_1" }),
    );
    const sourceId = await seedReadyImage("avatar");
    const sink = new DiagnosticCollector();

    const payload = await runImageLabControlExtraction({
      ownerId,
      sourceImageId: sourceId,
      controlKinds: ["depth"],
      sink,
    });

    const extracted = payload.extracted;
    expect(Array.isArray(extracted)).toBe(true);
    const first = Array.isArray(extracted) ? extracted[0] : undefined;
    expect(first).toMatchObject({
      controlKind: "depth",
      failureCode: imageLabDiagnosticCode("preprocessor_output_invalid"),
    });
    expect(codes(sink)).toContain(imageLabDiagnosticCode("preprocessor_output_invalid"));
    // The provider ANSWERED — with something that was not an image. That is a
    // fact about the extractor, which is exactly why it is recorded apart from a
    // failed prediction, and why the lane still reads as working.
    expect(payload.providerOutcome).toBe(true);
    expect(await listImageLabControls(ownerId, sink)).toHaveLength(0);
    const rows = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_control")));
    expect(rows).toHaveLength(0);
  });

  it("records a failed prediction as a render failure, not as invalid output", async () => {
    setImageLabPreprocessorForTesting(() =>
      Promise.resolve({ ok: false, error: "replicate 503: upstream is unavailable" }),
    );
    const sourceId = await seedReadyImage("avatar");
    const sink = new DiagnosticCollector();

    const payload = await runImageLabControlExtraction({
      ownerId,
      sourceImageId: sourceId,
      controlKinds: ["depth"],
      sink,
    });

    const extracted = payload.extracted;
    const first = Array.isArray(extracted) ? extracted[0] : undefined;
    expect(first).toMatchObject({ failureCode: imageLabDiagnosticCode("render_failed") });
    expect(IMAGE_LAB_DEPTH_PREPROCESSOR.outputField).toBe("grey_depth");
    // Paid work that failed transiently: the breaker hears it, exactly as it
    // would from the render lane this preprocessor shares an upstream with.
    expect(payload.providerOutcome).toBe(false);
  });

  it("reports the failure from a batch that mixed local and paid work", async () => {
    setImageLabPreprocessorForTesting(() =>
      Promise.resolve({ ok: false, error: "replicate 503: service unavailable" }),
    );
    const sourceId = await seedReadyImage("avatar");
    const sink = new DiagnosticCollector();

    const payload = await runImageLabControlExtraction({
      ownerId,
      sourceImageId: sourceId,
      controlKinds: ["edge", "depth"],
      sink,
    });

    // The edge map succeeded in process and the depth prediction failed. One
    // report per job, and the failure is the half the breaker exists to hear:
    // it counts CONSECUTIVE failures, so reporting the local success instead
    // would keep clearing a streak the lane is genuinely accumulating.
    expect(payload.providerOutcome).toBe(false);
    expect(await listImageLabControls(ownerId, sink)).toHaveLength(1);
  });

  it("refuses a source image this owner cannot read", async () => {
    const sink = new DiagnosticCollector();
    const payload = await runImageLabControlExtraction({
      ownerId,
      sourceImageId: "imgnotarealimageaaaaaaaa",
      controlKinds: ["edge"],
      sink,
    });
    expect(payload.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("input_missing"));
  });

  it("files an uploaded fixture as hand authored, whatever the caller wanted", async () => {
    const sink = new DiagnosticCollector();
    const dataUrl = await testPngDataUrl();
    const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");

    const result = await uploadImageLabControl({
      ownerId,
      controlKind: "pose",
      buffer,
      note: "drawn over the sofa shot",
      sink,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.control.meta.generator).toBe("hand_authored");
      expect(result.control.meta.controlKind).toBe("pose");
      // The upload's note is the fixture's origin note, exactly as an
      // extraction's is: it says what the drawing was for, not that anyone has
      // looked at it.
      expect(result.control.meta.originNote).toBe("drawn over the sofa shot");
      expect(result.control.meta.reviewNote).toBeUndefined();
      expect(result.control.meta.reviewedAt).toBeUndefined();
    }

    const [row] = await db()
      .select({ kind: images.kind, status: images.status })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_control")))
      .limit(1);
    expect(row?.status).toBe("ready");
  });

  it("records a review that persists, still parses as a wire fixture, and spares the origin note", async () => {
    const sink = new DiagnosticCollector();
    // Created through the upload path CARRYING its note, because the regression
    // this guards is a review landing on the annotation that path wrote: the two
    // shared one meta field once, so reviewing a fixture erased what it was for.
    const uploaded = await uploadImageLabControl({
      ownerId,
      controlKind: "pose",
      buffer: await testPngBuffer(),
      note: "drawn over the sofa shot",
      sink,
    });
    if (!uploaded.ok) throw new Error(`the upload path refused a valid fixture: ${uploaded.error}`);
    const controlId = uploaded.control.imageId;

    const reviewed = await reviewImageLabControl(ownerId, controlId, "skeleton reads cleanly; both wrists resolved", sink);
    expect(reviewed?.ok).toBe(true);
    if (reviewed?.ok) {
      expect(reviewed.control.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
      expect(reviewed.control.meta.reviewedAt).toBeTruthy();
      expect(reviewed.control.meta.originNote).toBe("drawn over the sofa shot");
      // The panel re-parses what the route hands it, so a review that produced
      // a shape the wire schema rejects would empty the fixtures list rather
      // than showing an unreviewed tile.
      expect(imageLabControlSchema.safeParse(reviewed.control).success).toBe(true);
    }

    // Stored, not merely returned — and MERGED onto the shared meta bag, so the
    // row's own `hidden` flag is still there beside the review, and so is the
    // origin note the upload wrote.
    const [listed] = await listImageLabControls(ownerId, sink);
    expect(listed?.meta.reviewedAt).toBeTruthy();
    expect(listed?.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
    expect(listed?.meta.originNote).toBe("drawn over the sofa shot");
    expect(listed?.meta.generator).toBe("hand_authored");
    const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, controlId)).limit(1);
    expect(imageMeta(row?.meta).hidden).toBe(true);
  });

  it("refuses to review an image that is not a lab control fixture", async () => {
    // Owned and ready, and entirely unable to say what fixture it is.
    const notAFixture = await seedReadyImage("portrait_variant");
    const refused = await reviewImageLabControl(ownerId, notAFixture, "looks fine to me");
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.refusal.code).toBe(imageLabDiagnosticCode("control_invalid"));
    // An absent or foreign id is a MISS, never a refusal: the route answers 404
    // and never confirms a foreign image exists.
    expect(await reviewImageLabControl(ownerId, "imgnotarealimageaaaaaaaa", "n/a")).toBeNull();
  });

  it("deletes a fixture and leaves the experiment that cited it standing", async () => {
    const controlId = await seedControlFixture("depth");
    const identityId = await seedReadyImage("avatar");
    const settings = { controls: { guidance: 4.5, steps: 28 }, controlInput: { control_scale: 0.8 } };
    const { id } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "depth", imageId: controlId },
      ],
      controlImageId: controlId,
      controlKind: "depth",
      settings,
    });

    expect(await deleteImageLabControl(ownerId, controlId)).toBe(true);
    expect(await listImageLabControls(ownerId)).toHaveLength(0);
    const rows = await db().select({ id: images.id }).from(images).where(eq(images.id, controlId));
    expect(rows).toHaveLength(0);

    // `control_image_id` is `on delete set null`: the experiment keeps its
    // recorded kind, order and settings — it is the record of a render that
    // happened, and retiring the skeleton afterwards does not un-happen it.
    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.controlImageId).toBeNull();
    expect(experiment?.controlKind).toBe("depth");
    expect(experiment?.settings).toEqual(settings);
    expect(experiment?.inputs).toHaveLength(2);

    // A second delete is a miss, not a second removal — the route's 404.
    expect(await deleteImageLabControl(ownerId, controlId)).toBe(false);
  });
});
