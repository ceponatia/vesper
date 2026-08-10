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
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  testPngDataUrl,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { db, imageLabExperiments, imageModels, images } from "../db";
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
 */

const ready = await probeIntegrationDb("image lab.int.test", "image_lab_experiments");

const PINNED_MODEL_ID = "imgmdlimagelabpinnedaaaa";
const UNPINNED_MODEL_ID = "imgmdlimagelabfloataaaaa";
const FIXTURE_MODEL_IDS = [PINNED_MODEL_ID, UNPINNED_MODEL_ID];

const PINNED_SLUG = "vesper-test/image-lab-pinned";
const UNPINNED_SLUG = "vesper-test/image-lab-floating";
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

/** A `lab_control` fixture with parseable meta — what a valid probe points at. */
async function seedControlFixture(controlKind: ImageLabControlKind = "pose"): Promise<string> {
  return await seedReadyImage("lab_control", { hidden: true, controlKind, generator: "hand_authored" });
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

function codes(sink: DiagnosticCollector): string[] {
  return sink.items.map((item) => item.code);
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
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({ inputs: [{ position: 1, role: "identity", imageId: identityId }] });

    await runImageLabExperiment(id, ownerId, sink);

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
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({ inputs: [{ position: 1, role: "identity", imageId: identityId }] });

    await runImageLabExperiment(id, ownerId, sink);
    const second = await runImageLabExperiment(id, ownerId, sink);

    expect(second.skipped).toBe("succeeded");
    expect(captured).toHaveLength(1);
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
    const identityId = await seedReadyImage("avatar");
    const { id, sink } = await createProbe({ inputs: [{ position: 1, role: "identity", imageId: identityId }] });
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

    const controls = await listImageLabControls(ownerId, sink);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.meta.controlKind).toBe("edge");
    expect(controls[0]?.meta.generator).toBe("computed_edge");
    expect(controls[0]?.meta.sourceImageId).toBe(sourceId);
    expect(controls[0]?.meta.reviewNote).toBe("edge pass over the sofa shot");
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

    await runImageLabControlExtraction({ ownerId, sourceImageId: sourceId, controlKinds: ["pose"], sink });

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
    expect(await listImageLabControls(ownerId, sink)).toHaveLength(0);
    const rows = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_control")));
    expect(rows).toHaveLength(0);
  });

  it("records a failed prediction as a render failure, not as invalid output", async () => {
    setImageLabPreprocessorForTesting(() =>
      Promise.resolve({ ok: false, error: "replicate failed: upstream is unavailable" }),
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
      expect(result.control.meta.reviewNote).toBe("drawn over the sofa shot");
    }

    const [row] = await db()
      .select({ kind: images.kind, status: images.status })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), eq(images.kind, "lab_control")))
      .limit(1);
    expect(row?.status).toBe("ready");
  });

  it("records a review that persists and still parses as a wire fixture", async () => {
    const controlId = await seedControlFixture("pose");
    const sink = new DiagnosticCollector();

    const reviewed = await reviewImageLabControl(ownerId, controlId, "skeleton reads cleanly; both wrists resolved", sink);
    expect(reviewed?.ok).toBe(true);
    if (reviewed?.ok) {
      expect(reviewed.control.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
      expect(reviewed.control.meta.reviewedAt).toBeTruthy();
      // The panel re-parses what the route hands it, so a review that produced
      // a shape the wire schema rejects would empty the fixtures list rather
      // than showing an unreviewed tile.
      expect(imageLabControlSchema.safeParse(reviewed.control).success).toBe(true);
    }

    // Stored, not merely returned — and MERGED onto the shared meta bag, so the
    // row's own `hidden` flag is still there beside the review.
    const [listed] = await listImageLabControls(ownerId, sink);
    expect(listed?.meta.reviewedAt).toBeTruthy();
    expect(listed?.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
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
