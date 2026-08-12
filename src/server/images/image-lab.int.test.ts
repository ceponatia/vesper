import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  imageLabControlSchema,
  imageLabDiagnosticCode,
  IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY,
  IMAGE_LAB_FINISHING_RECIPE_KEY,
  REPLICATE_VERSION_UNDISCLOSED,
  type ImageLabControlKind,
  type ImageLabCreateExperimentRequest,
  type ImageLabInput,
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
import { characterChats, characters, db, imageLabExperiments, imageLoras, imageModels, images, jobs } from "../db";
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
const TWO_REF_MODEL_ID = "imgmdlimagelabtworefaaaa";
const THREE_REF_MODEL_ID = "imgmdlimagelabthreerefaa";
const LORA_MODEL_ID = "imgmdlimagelabloraaaaaaa";
const FIXTURE_MODEL_IDS = [
  PINNED_MODEL_ID,
  UNPINNED_MODEL_ID,
  CAPPED_MODEL_ID,
  TWO_REF_MODEL_ID,
  THREE_REF_MODEL_ID,
  LORA_MODEL_ID,
];

const PINNED_SLUG = "vesper-test/image-lab-pinned";
const UNPINNED_SLUG = "vesper-test/image-lab-floating";
const CAPPED_SLUG = "vesper-test/image-lab-one-reference";
const TWO_REF_SLUG = "vesper-test/image-lab-two-reference";
const THREE_REF_SLUG = "vesper-test/image-lab-three-reference";
const LORA_SLUG = "vesper-test/image-lab-lora";
const PINNED_VERSION = "imagelabversionaaaaaaaaa";

/** The curated library row the LoRA-only arm measures — global, like the registry. */
const FIXTURE_LORA_ID = "imgloraimagelabfixtureaa";
const FIXTURE_LORA_SCALE = 1;
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
      {
        // Pinned with TWO reference slots — the shape that makes the
        // two-character capacity pre-check load-bearing. Two identities and a
        // control need three, and `planIntentReferences` would happily drop one
        // character and still find an `identity` reference present, because its
        // required-role check is Set-based. Two identities ALONE fit here, so the
        // refusal is observably about the required COUNT rather than the kind.
        id: TWO_REF_MODEL_ID,
        slug: TWO_REF_SLUG,
        label: "Image Lab Two-Reference Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 2,
        probedVersionId: PINNED_VERSION,
      },
      {
        // Pinned with THREE reference slots: one short of a controlled run's
        // four offered roles, so the intent path's trim-and-record behavior is
        // observable as a recorded drop rather than a refusal.
        id: THREE_REF_MODEL_ID,
        slug: THREE_REF_SLUG,
        label: "Image Lab Three-Reference Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 3,
        probedVersionId: PINNED_VERSION,
      },
      {
        // Pinned, and the only fixture whose probed version declares the two
        // LoRA inputs. `evaluateImageLoraForRender` refuses a model that exposes
        // neither, so the LoRA arms are unrunnable without a registration shaped
        // like the live `qwen/qwen-image-edit-plus-lora` one.
        id: LORA_MODEL_ID,
        slug: LORA_SLUG,
        label: "Image Lab LoRA Fixture",
        canGenerate: true,
        canEdit: true,
        maxReferences: 3,
        probedVersionId: PINNED_VERSION,
        advancedCapabilities: {
          controls: {
            loraWeights: { field: "lora_weights", type: "string" },
            loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
          },
        },
      },
    ]);

  await db().delete(imageLoras).where(eq(imageLoras.id, FIXTURE_LORA_ID));
  await db()
    .insert(imageLoras)
    .values({
      id: FIXTURE_LORA_ID,
      label: "Image Lab Character LoRA Fixture",
      locatorType: "huggingface_repo",
      locator: "vesper-test/image-lab-character-lora",
      compatibleModelSlugs: [LORA_SLUG],
      // Empty means any version of a compatible slug — the row is not making a
      // claim about version drift, so the arm under test is the arm, not the pin.
      compatibleVersionIds: [],
      defaultScale: FIXTURE_LORA_SCALE,
      minimumScale: 0.5,
      maximumScale: 1.5,
      triggerWords: [],
      allowedTasks: ["variant"],
      enabled: true,
    });
});

afterAll(async () => {
  if (ready) {
    await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
    await db().delete(imageLoras).where(eq(imageLoras.id, FIXTURE_LORA_ID));
  }
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
 *
 * `sourceImageId` is the render the fixture came from — absent by default, the
 * way a skeleton drawn from nothing records none.
 */
async function seedControlFixture(
  controlKind: ImageLabControlKind = "pose",
  opts: { reviewed?: boolean; sourceImageId?: string } = {},
): Promise<string> {
  const imageId = await seedReadyImage("lab_control", {
    hidden: true,
    controlKind,
    generator: "hand_authored",
    ...(opts.sourceImageId ? { sourceImageId: opts.sourceImageId } : {}),
  });
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

/**
 * A character the controlled kinds can be about — the create schema demands one.
 *
 * The NAME is a parameter because a two-character scene reads both subjects'
 * names into its prompt, and two characters sharing one name would let a runner
 * that bound the wrong face to the wrong slot pass every assertion.
 */
async function seedOwnedCharacter(name = "Lab Subject"): Promise<string> {
  const [row] = await db().insert(characters).values({ ownerId, name }).returning({ id: characters.id });
  if (!row) throw new Error("failed to seed a character for the lab suite");
  return row.id;
}

/** A chat the scene kinds can be about. Every other column carries a default. */
async function seedOwnedChat(): Promise<string> {
  const [row] = await db().insert(characterChats).values({ ownerId }).returning({ id: characterChats.id });
  if (!row) throw new Error("failed to seed a chat for the lab suite");
  return row.id;
}

const CONTROLLED_INSTRUCTION = "Seated on the balcony rail at dusk, wind in the hair.";

async function createControlledExperiment(
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector }> {
  const sink = new DiagnosticCollector();
  const request: ImageLabCreateExperimentRequest = {
    kind: "controlled_portrait",
    modelSlug: PINNED_SLUG,
    characterId: await seedOwnedCharacter(),
    instruction: CONTROLLED_INSTRUCTION,
    inputs: [],
    ...overrides,
  };
  const created = await createImageLabExperiment({ ownerId, request, sink });
  if (!created.ok) throw new Error(`unexpected create refusal: ${created.refusal.code}`);
  return { id: created.experiment.id, sink };
}

/**
 * The runnable controlled shape: an identity anchor, the reviewed pose fixture
 * it is judged against, and the declaration binding the two — the same triangle
 * a probe carries, on the intent path. `reviewed` and `sourceIsIdentity` drive
 * the two Stage 0 fixture gates the controlled runner must keep.
 */
async function createRunnableControlled(
  fixture: { reviewed?: boolean; sourceIsIdentity?: boolean } = {},
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector; identityId: string; controlId: string }> {
  const identityId = await seedReadyImage("avatar");
  const controlId = await seedControlFixture("pose", {
    ...(fixture.reviewed === false ? { reviewed: false } : {}),
    ...(fixture.sourceIsIdentity ? { sourceImageId: identityId } : {}),
  });
  const { id, sink } = await createControlledExperiment({
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

const TWO_CHARACTER_INSTRUCTION = "The two of them on the balcony rail at dusk.";
const CAST_A = "Sabrina Vale";
const CAST_B = "Lysandra Vane";

/**
 * A runnable two-character scene: one identity render per character, each bound
 * to the character it depicts, on a chat this owner has.
 *
 * The control is OPTIONAL and OFF by default, which is the kind's own default arm
 * — "do two people survive one render?" is answerable without a fixture, and the
 * uncontrolled runs below are testing exactly that rather than working around a
 * missing fixture.
 */
async function createTwoCharacterScene(
  opts: { control?: "pose" | "undeclared" | "unreviewed"; modelSlug?: string } = {},
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{
  id: string;
  sink: DiagnosticCollector;
  castAId: string;
  castBId: string;
  faceAId: string;
  faceBId: string;
  controlId: string | null;
}> {
  const sink = new DiagnosticCollector();
  const castAId = await seedOwnedCharacter(CAST_A);
  const castBId = await seedOwnedCharacter(CAST_B);
  const faceAId = await seedCharacterFace(castAId);
  const faceBId = await seedCharacterFace(castBId);
  const controlId =
    opts.control === undefined ? null : await seedControlFixture("pose", { reviewed: opts.control !== "unreviewed" });

  const inputs: ImageLabInput[] = [
    { position: 1, role: "identity", imageId: faceAId, characterId: castAId },
    { position: 2, role: "identity", imageId: faceBId, characterId: castBId },
    ...(controlId === null ? [] : [{ position: 3, role: "pose" as const, imageId: controlId }]),
  ];
  const request: ImageLabCreateExperimentRequest = {
    kind: "two_character_scene",
    modelSlug: opts.modelSlug ?? PINNED_SLUG,
    chatId: await seedOwnedChat(),
    instruction: TWO_CHARACTER_INSTRUCTION,
    inputs,
    // `undeclared` sends the fixture under a control role while the record names
    // none — the refusal the uncontrolled arm's honesty rests on. Every other
    // arm declares what it sends.
    ...(opts.control !== undefined && opts.control !== "undeclared" && controlId !== null
      ? { controlImageId: controlId, controlKind: "pose" as const }
      : {}),
    ...overrides,
  };
  const created = await createImageLabExperiment({ ownerId, request, sink });
  if (!created.ok) throw new Error(`unexpected create refusal: ${created.refusal.code}`);
  return { id: created.experiment.id, sink, castAId, castBId, faceAId, faceBId, controlId };
}

/**
 * A ready portrait FILED AGAINST a character — what a real one looks like, and
 * the only shape the lab's own picker can offer: `listOwnedPortraits` selects on
 * `entityKind`/`entityId`, so every image a form can put in an identity slot
 * carries this link. The two-character runner checks it before spending, so a
 * fixture without one would be testing a request the UI cannot make.
 */
async function seedCharacterFace(characterId: string): Promise<string> {
  const asset = await createImageAsset({
    ownerId,
    kind: "avatar",
    entityKind: "character",
    entityId: characterId,
    prompt: "lab identity fixture",
  });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer());
  expect(saved?.status).toBe("ready");
  return asset.id;
}

/**
 * A character whose canonical portrait is portrait-shaped, so `ensureIdentityPack`
 * derives a usable pack from it under the shipped heuristic — the trial suite's
 * own fixture shape, and the precondition every finishing pass has.
 */
async function seedCharacterWithPortrait(): Promise<string> {
  const characterId = await seedOwnedCharacter();
  const asset = await createImageAsset({
    ownerId,
    kind: "avatar",
    entityKind: "character",
    entityId: characterId,
    prompt: "lab canonical portrait",
  });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer(384, 512));
  if (saved?.status !== "ready") throw new Error("failed to store the lab canonical portrait");
  await db().update(characters).set({ avatarImageId: saved.id }).where(eq(characters.id, characterId));
  return characterId;
}

/**
 * A settled, finishable run — inserted rather than rendered.
 *
 * What a finishing pass reads from its source is exactly three fields (kind,
 * status, result image), so driving a whole controlled render first would test
 * the controlled runner a second time and make this suite's finishing cases
 * depend on it.
 */
async function seedFinishedSource(characterId: string): Promise<{ id: string; resultImageId: string }> {
  const resultImageId = await seedReadyImage("lab_output", { hidden: true });
  const [row] = await db()
    .insert(imageLabExperiments)
    .values({
      ownerId,
      kind: "controlled_portrait",
      modelSlug: PINNED_SLUG,
      characterId,
      instruction: CONTROLLED_INSTRUCTION,
      inputs: [],
      settings: {},
      status: "succeeded",
      resultImageId,
    })
    .returning({ id: imageLabExperiments.id });
  if (!row) throw new Error("failed to seed a finishable source experiment");
  return { id: row.id, resultImageId };
}

/** A finishing pass over that source, created the way the route creates one. */
async function createFinishingPass(
  sourceExperimentId: string,
  overrides: Partial<ImageLabCreateExperimentRequest> = {},
): Promise<{ id: string; sink: DiagnosticCollector }> {
  const sink = new DiagnosticCollector();
  const created = await createImageLabExperiment({
    ownerId,
    request: {
      kind: "finishing_pass",
      modelSlug: PINNED_SLUG,
      instruction: "",
      inputs: [],
      sourceExperimentId,
      ...overrides,
    },
    sink,
  });
  if (!created.ok) throw new Error(`unexpected create refusal: ${created.refusal.code}`);
  return { id: created.experiment.id, sink };
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

  it("records an UNDISCLOSED executed version verbatim and still succeeds", async () => {
    // What Replicate answers for an OFFICIAL model, which publishes no versions
    // list at all: the literal `"hidden"`. The lab stores what the provider
    // said and interprets nothing — the experiment succeeds, both version
    // columns keep their own truth, and the detail screen decides how to read
    // them (`providerVersionsDisagree`, contracts). Nothing here may treat the
    // string as a version that disagrees with the pin.
    setImageLabRendererForTesting(async (request) => {
      captured.push(request);
      return {
        ok: true,
        image: await testPngBuffer(),
        predictionId: "pred_image_lab_hidden",
        executedVersionId: REPLICATE_VERSION_UNDISCLOSED,
      };
    });
    const identityId = await seedReadyImage("avatar");
    const controlId = await seedControlFixture("pose");
    const { id, sink } = await createProbe({
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: controlId },
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
    expect(experiment?.executedVersionId).toBe("hidden");
    expect(experiment?.resultImageId).not.toBeNull();
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

  it("refuses a probe that also sends the render its fixture came from, before any spend", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    // The fixture records the render it was extracted from, and that render is
    // ordered as the identity anchor: the output could match the skeleton by
    // copying that reference, so `honours_control` would be a pass nothing
    // earned. The UI greys the render out; only this refusal stops a direct API
    // call from running it anyway.
    const controlId = await seedControlFixture("pose", { sourceImageId: identityId });
    const { id, sink } = await createProbe({
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
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_source_sent"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_source_sent"));
    // The fixture is readable and REVIEWED, so nothing else here would have
    // stopped it — this is the rule's own refusal, not another gate's.
    expect(experiment?.failureCode).not.toBe(imageLabDiagnosticCode("control_unreviewed"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
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
 * The controlled kinds end to end: the render-intent path with a pinned
 * version and a code-defined recipe, the recorded reference-plan outcome that
 * keeps trim-and-record honest, and the Stage 0 gates the intent path must not
 * lose on the way over.
 */
describe.skipIf(!ready)("image lab controlled runs", () => {
  it("runs a controlled portrait through the intent path with the pinned version and the recipe profile", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableControlled();

    const payload = await runImageLabExperiment(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.modelSlug).toBe(PINNED_SLUG);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.failureCode).toBeNull();
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    expect(experiment?.executedVersionId).toBe(EXECUTED_VERSION);
    expect(experiment?.resultImageId).not.toBeNull();

    // The recorded prompt is the COMPILED compose text — numbered role
    // bindings, the closing control clause, the admin's instruction last —
    // not the raw instruction, because what was sent is what the record says.
    expect(experiment?.finalPrompt?.startsWith("Image 1: the identity reference")).toBe(true);
    expect(experiment?.finalPrompt).toContain("Image 2: a pose skeleton");
    expect(experiment?.finalPrompt).toContain("never render the control images themselves");
    expect(experiment?.finalPrompt?.endsWith(CONTROLLED_INSTRUCTION)).toBe(true);

    // The intent path, not the probe's direct call — and the pin rides INSIDE
    // the intent, so the seam shape needed no lab-specific arm.
    const request = captured[0];
    expect(request?.mode).toBe("intent");
    if (request?.mode === "intent") {
      expect(request.intent.versionId).toBe(PINNED_VERSION);
      expect(request.intent.profile.profile.key).toBe("controlled_portrait/pose");
      expect(request.intent.profile.profile.id).toBe("image-lab/controlled_portrait/pose");
      expect(request.intent.references).toHaveLength(2);
    }

    expect(experiment?.outcome).toEqual({
      recipeKey: "controlled_portrait/pose",
      sentRoles: ["identity", "pose"],
      dropped: [],
      renumbered: false,
    });
  });

  it("records what capacity trimmed instead of refusing the run", async () => {
    stubSuccessfulRenderer();
    const identityId = await seedReadyImage("avatar");
    const controlId = await seedControlFixture("pose");
    const outfitId = await seedReadyImage("avatar");
    const styleId = await seedReadyImage("avatar");
    const { id, sink } = await createControlledExperiment({
      modelSlug: THREE_REF_SLUG,
      inputs: [
        { position: 1, role: "identity", imageId: identityId },
        { position: 2, role: "pose", imageId: controlId },
        { position: 3, role: "outfit", imageId: outfitId },
        { position: 4, role: "style", imageId: styleId },
      ],
      controlImageId: controlId,
      controlKind: "pose",
    });

    const payload = await runImageLabExperiment(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.outcome?.sentRoles).toEqual(["identity", "pose", "outfit"]);
    // Four distinct roles capped at one each against three slots: nothing hits
    // a role cap, so the last role in the recipe's order overflows the MODEL.
    expect(experiment?.outcome?.dropped).toEqual([{ role: "style", reason: "model_capacity", sourceImageId: styleId }]);
    // The trim came off the tail, so the prompt's numbering still matches.
    expect(experiment?.outcome?.renumbered).toBe(false);
  });

  it("refuses a controlled run whose plan lacks the required identity anchor", async () => {
    stubSuccessfulRenderer();
    const controlId = await seedControlFixture("pose");
    const { id, sink } = await createControlledExperiment({
      inputs: [{ position: 1, role: "pose", imageId: controlId }],
      controlImageId: controlId,
      controlKind: "pose",
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    // The intent path's own refusal code, recorded verbatim: the recipe
    // REQUIRES identity, so a render that would depict a stranger never runs.
    expect(experiment?.failureCode).toBe("image_profile.required_reference_missing");
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("refuses the probe's raw provider bag before any spend", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableControlled(
      {},
      { settings: { controls: {}, controlInput: { true_cfg_scale: 4 } } },
    );

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("settings_unsupported"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("settings_unsupported"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("keeps the Stage 0 review gate on the intent path", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableControlled({ reviewed: false });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_unreviewed"));
    expect(captured).toHaveLength(0);
  });

  it("keeps the Stage 0 source gate on the intent path", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableControlled({ sourceIsIdentity: true });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_source_sent"));
    expect(captured).toHaveLength(0);
  });

  it("records a verdict on a succeeded controlled run", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createRunnableControlled();
    await runImageLabExperiment(id, ownerId, sink);

    const recorded = await recordImageLabVerdict(id, ownerId, {
      verdict: "honours_control",
      note: "limb-for-limb match under the production-shaped request",
    });
    expect(recorded?.ok).toBe(true);
    if (recorded?.ok) expect(recorded.experiment.verdict).toBe("honours_control");
  });
});

/**
 * The Stage 6 kind end to end: two named identities in one render, an optional
 * control beside them, and the refusals that keep the record equal to the send.
 *
 * The capacity case is the one worth reading twice. Every other refusal here
 * would eventually surface some other way; that one is the only thing standing
 * between a two-slot model and a solo portrait filed as a two-character scene.
 */
describe.skipIf(!ready)("image lab two-character scenes", () => {
  it("sends both named identities and the control, and weaves the subjects into the prompt", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createTwoCharacterScene({ control: "pose" });

    const payload = await runImageLabExperiment(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.failureCode).toBeNull();
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    expect(experiment?.executedVersionId).toBe(EXECUTED_VERSION);
    expect(experiment?.resultImageId).not.toBeNull();

    // The whole reason the kind carries a per-input subject: each numbered
    // binding names the person whose face that slot holds, so "identities
    // swapped" is a ruling about the model rather than about a prompt that never
    // distinguished them.
    expect(experiment?.finalPrompt).toContain(`Image 1: the identity reference for ${CAST_A}`);
    expect(experiment?.finalPrompt).toContain(`Image 2: the identity reference for ${CAST_B}`);
    expect(experiment?.finalPrompt).toContain(`This render depicts exactly 2 people: ${CAST_A} and ${CAST_B}.`);
    expect(experiment?.finalPrompt).toContain("never merge, swap, or duplicate them");
    expect(experiment?.finalPrompt).toContain("Image 3: a pose skeleton");
    expect(experiment?.finalPrompt).toContain("never render the control images themselves");
    expect(experiment?.finalPrompt?.endsWith(TWO_CHARACTER_INSTRUCTION)).toBe(true);

    const request = captured[0];
    expect(request?.mode).toBe("intent");
    if (request?.mode === "intent") {
      expect(request.intent.versionId).toBe(PINNED_VERSION);
      expect(request.intent.profile.profile.key).toBe("two_character_scene/pose");
      expect(request.intent.profile.profile.id).toBe("image-lab/two_character_scene/pose");
      expect(request.intent.references).toHaveLength(3);
      // Both identities are REQUIRED, so neither can be trimmed away by a policy
      // that would still find an `identity` reference present.
      expect(request.intent.references.filter((reference) => reference.role === "identity")).toHaveLength(2);
      expect(request.intent.references.map((reference) => reference.subject)).toEqual([CAST_A, CAST_B, undefined]);
    }

    expect(experiment?.outcome).toEqual({
      recipeKey: "two_character_scene/pose",
      sentRoles: ["identity", "identity", "pose"],
      dropped: [],
      renumbered: false,
    });
  });

  it("runs the uncontrolled arm, which is a real arm and the default one", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createTwoCharacterScene();

    const payload = await runImageLabExperiment(id, ownerId, sink);
    expect(payload.status).toBe("succeeded");

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.controlImageId).toBeNull();
    // A separate recipe key, so a recorded outcome says which arm ran: "both
    // identities held" means something different with a skeleton in the send.
    expect(experiment?.outcome).toEqual({
      recipeKey: "two_character_scene/none",
      sentRoles: ["identity", "identity"],
      dropped: [],
      renumbered: false,
    });
    // The cast clause still goes; the control clause has nothing to describe.
    expect(experiment?.finalPrompt).toContain(`exactly 2 people: ${CAST_A} and ${CAST_B}`);
    expect(experiment?.finalPrompt).not.toContain("never render the control images themselves");
  });

  it("refuses rather than dropping a character when the required references do not fit", async () => {
    stubSuccessfulRenderer();
    // Two identities and a control need three slots; this model has two. The
    // intent path refuses this too now (a dropped required reference is a
    // refusal there), so what this case pins is WHOSE refusal an admin reads: the
    // lab's own code and its ineligibility wording, decided before eligibility
    // and the recipe compile spend any work on a run that was never going to fit.
    const { id, sink } = await createTwoCharacterScene({ control: "pose", modelSlug: TWO_REF_SLUG });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("capacity_exceeded"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("capacity_exceeded"));
    // Refused BEFORE any spend, which is the point — a trimmed send would have
    // cost a render and produced evidence about the planner.
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
    // The pin was resolved before the capacity read, so it is on the record.
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
  });

  it("fits the same two characters on the same model once the control is dropped", async () => {
    stubSuccessfulRenderer();
    // The counterpart of the case above: the refusal is about the REQUIRED count,
    // not about the kind, so two identities alone run on a two-slot model.
    const { id, sink } = await createTwoCharacterScene({ modelSlug: TWO_REF_SLUG });

    const payload = await runImageLabExperiment(id, ownerId, sink);

    expect(payload.status).toBe("succeeded");
    expect(captured).toHaveLength(1);
    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.outcome?.sentRoles).toEqual(["identity", "identity"]);
  });

  it("refuses an identity input naming a character this owner does not have", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createTwoCharacterScene();
    // Deleted after the row was stored — the create path checks ownership, and
    // the runner re-checks because a character can go away between queue and
    // render. Without the name there is nothing to bind that face to.
    await db().delete(characters).where(and(eq(characters.ownerId, ownerId), eq(characters.name, CAST_B)));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("refuses a foreign character on an identity input at create, before a row exists", async () => {
    const sink = new DiagnosticCollector();
    const stranger = await seedTestUser("image-lab-two-char-stranger");
    const [foreign] = await db()
      .insert(characters)
      .values({ ownerId: stranger.id, name: "Not This Owner's" })
      .returning({ id: characters.id });
    const created = await createImageLabExperiment({
      ownerId,
      request: {
        kind: "two_character_scene",
        modelSlug: PINNED_SLUG,
        chatId: await seedOwnedChat(),
        instruction: TWO_CHARACTER_INSTRUCTION,
        inputs: [
          { position: 1, role: "identity", imageId: await seedReadyImage("avatar"), characterId: await seedOwnedCharacter(CAST_A) },
          { position: 2, role: "identity", imageId: await seedReadyImage("avatar"), characterId: foreign?.id ?? "chr_missing" },
        ],
      },
      sink,
    });

    expect(created.ok).toBe(false);
    // Reported exactly as a missing character, so the refusal never confirms
    // that someone else's id exists.
    if (!created.ok) expect(created.refusal.code).toBe("character_not_found");
    await purgeOwnerRows([stranger.id]);
  });

  it("refuses a cast whose two characters answer to one name, before any spend", async () => {
    stubSuccessfulRenderer();
    const { id, sink, castBId } = await createTwoCharacterScene();
    // Renamed after the row was stored, which is the only way this row reaches the
    // runner — the create path refuses the pair outright. `characters.name` is not
    // unique, so two real and genuinely different subjects can wear one label, and
    // then the numbered bindings that tell the model which face is whose say the
    // same words twice: no cast clause at all, and a paid render whose swap
    // verdict would be a fact about the prompt.
    await db().update(characters).set({ name: CAST_A }).where(eq(characters.id, castBId));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("subject_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("subject_invalid"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("reads one name in two spellings as one name", async () => {
    stubSuccessfulRenderer();
    const { id, sink, castBId } = await createTwoCharacterScene();
    // The model reads both bindings as prose, where "sabrina vale" and "Sabrina
    // Vale" are one person — so a case-only difference is not a distinction the
    // render could act on.
    await db().update(characters).set({ name: CAST_A.toLowerCase() }).where(eq(characters.id, castBId));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("subject_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses two characters sharing one name at create, so the admin sees the rename to make", async () => {
    const sink = new DiagnosticCollector();
    // Same name, different rows — nothing in the request schema can see it, since
    // both ids are real, owned, and distinct.
    const twinA = await seedOwnedCharacter("Ada Twin");
    const twinB = await seedOwnedCharacter("Ada Twin");
    const created = await createImageLabExperiment({
      ownerId,
      request: {
        kind: "two_character_scene",
        modelSlug: PINNED_SLUG,
        chatId: await seedOwnedChat(),
        instruction: TWO_CHARACTER_INSTRUCTION,
        inputs: [
          { position: 1, role: "identity", imageId: await seedCharacterFace(twinA), characterId: twinA },
          { position: 2, role: "identity", imageId: await seedCharacterFace(twinB), characterId: twinB },
        ],
      },
      sink,
    });

    expect(created.ok).toBe(false);
    // Refused at the form rather than settled as a failed row: the fix is a rename
    // in another screen, and a queued experiment is a poor way to ask for one.
    if (!created.ok) expect(created.refusal.code).toBe("characters_share_name");
  });

  it("refuses an identity image that is not a render of the character it is bound to", async () => {
    stubSuccessfulRenderer();
    const { id, sink, castAId, castBId, faceAId } = await createTwoCharacterScene();
    // B's slot repointed at A's portrait: owned, ready, a real face — the wrong
    // one. Nothing else in the pipeline asks whose face it is, so the run would
    // send A twice, once under B's name, and manufacture the exact swap this stage
    // exists to measure. It is also the one-portrait-for-both shape, which the same
    // check closes: an image is filed against at most one entity.
    await db()
      .update(imageLabExperiments)
      .set({
        inputs: [
          { position: 1, role: "identity", imageId: faceAId, characterId: castAId },
          { position: 2, role: "identity", imageId: faceAId, characterId: castBId },
        ],
      })
      .where(and(eq(imageLabExperiments.id, id), eq(imageLabExperiments.ownerId, ownerId)));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("subject_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("subject_invalid"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("refuses an identity image filed against nobody at all", async () => {
    stubSuccessfulRenderer();
    const { id, sink, castAId, castBId, faceAId } = await createTwoCharacterScene();
    // The other half of the same gate: an image with no entity link depicts nobody
    // the app can name, so binding a character to it is a claim with nothing behind
    // it. This is the shape a direct API caller reaches first — the lab's own
    // picker cannot offer one, since `listOwnedPortraits` selects on the link.
    const unlinked = await seedReadyImage("avatar");
    await db()
      .update(imageLabExperiments)
      .set({
        inputs: [
          { position: 1, role: "identity", imageId: faceAId, characterId: castAId },
          { position: 2, role: "identity", imageId: unlinked, characterId: castBId },
        ],
      })
      .where(and(eq(imageLabExperiments.id, id), eq(imageLabExperiments.ownerId, ownerId)));

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("subject_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a structural control image the record does not declare", async () => {
    stubSuccessfulRenderer();
    // The uncontrolled arm's whole claim is that nothing structural was sent. An
    // undeclared skeleton riding along would send one the record cannot name, so
    // no verdict about the control could be filed against the run.
    const { id, sink } = await createTwoCharacterScene({ control: "undeclared" });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("control_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("keeps the Stage 0 fixture gates on a declared control", async () => {
    stubSuccessfulRenderer();
    // A declared fixture is held to every rule a probe's is: an unreviewed
    // skeleton cannot be ruled out as the reason a run came back wrong.
    const { id, sink } = await createTwoCharacterScene({ control: "unreviewed" });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("control_unreviewed"));
    expect(captured).toHaveLength(0);
  });

  it("refuses the probe's raw provider bag, like every recipe kind", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createTwoCharacterScene({}, { settings: { controls: {}, controlInput: { true_cfg_scale: 4 } } });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("settings_unsupported"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("settings_unsupported"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a stored row whose cast rule no longer holds, before any spend", async () => {
    stubSuccessfulRenderer();
    // The create schema refuses this, so the row is inserted directly: the runner
    // stays authoritative for rows that arrive around the request schema, and the
    // failure it prevents is a MISFILED render rather than a broken one.
    const [row] = await db()
      .insert(imageLabExperiments)
      .values({
        ownerId,
        kind: "two_character_scene",
        modelSlug: PINNED_SLUG,
        chatId: await seedOwnedChat(),
        instruction: TWO_CHARACTER_INSTRUCTION,
        inputs: [{ position: 1, role: "identity", imageId: await seedReadyImage("avatar") }],
        settings: {},
        status: "pending",
      })
      .returning({ id: imageLabExperiments.id });
    const id = row?.id ?? "";
    const sink = new DiagnosticCollector();

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
  });

  it("records a cast ruling and refuses one from another kind's vocabulary", async () => {
    stubSuccessfulRenderer();
    const { id, sink } = await createTwoCharacterScene();
    await runImageLabExperiment(id, ownerId, sink);

    const recorded = await recordImageLabVerdict(id, ownerId, {
      verdict: "identities_swapped",
      note: "each face landed on the other character; both likenesses survived intact",
    });
    expect(recorded?.ok).toBe(true);
    if (recorded?.ok) expect(recorded.experiment.verdict).toBe("identities_swapped");

    // Control obedience rides the NOTE, never the column: one row, one ruling,
    // and this kind's defining question is the two-character one.
    const wrongVocabulary = await recordImageLabVerdict(id, ownerId, {
      verdict: "honours_control",
      note: "the skeleton took",
    });
    expect(wrongVocabulary?.ok).toBe(false);
    if (wrongVocabulary && !wrongVocabulary.ok) {
      expect(wrongVocabulary.refusal.code).toBe("verdict_not_in_vocabulary");
    }
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

describe.skipIf(!ready)("image lab finishing passes", () => {
  it("re-edits the source's result against the pack and records both references", async () => {
    stubSuccessfulRenderer();
    const characterId = await seedCharacterWithPortrait();
    const source = await seedFinishedSource(characterId);
    const { id, sink } = await createFinishingPass(source.id, { instruction: "the jaw is too narrow" });

    // The subject is INHERITED, never sent: both arms of the comparison file
    // against one character.
    const created = await getImageLabExperimentDetail(id, ownerId);
    expect(created?.characterId).toBe(characterId);
    expect(created?.sourceExperimentId).toBe(source.id);

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.failureCode).toBeNull();
    // The create-time pointer survived the settle — the whole reason meta writes
    // merge rather than assign.
    expect(experiment?.sourceExperimentId).toBe(source.id);
    // The runner resolved the ordered inputs and WROTE THEM DOWN: the source's
    // render first, the pack's reference second.
    expect(experiment?.inputs.map((input) => input.role)).toEqual(["before", "identity"]);
    expect(experiment?.inputs[0]?.imageId).toBe(source.resultImageId);
    expect(experiment?.inputs[1]?.imageId).not.toBe(source.resultImageId);
    expect(experiment?.outcome?.recipeKey).toBe(IMAGE_LAB_FINISHING_RECIPE_KEY);
    expect(experiment?.outcome?.sentRoles).toEqual(["before", "identity"]);
    expect(experiment?.outcome?.dropped).toEqual([]);
    // Pinned like every recipe run: evidence against an unidentifiable version
    // answers nothing.
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    // The rule is in the prompt, and so is the admin's narrowing after it.
    expect(experiment?.finalPrompt).toContain("Refine only the identity in the before image");
    expect(experiment?.finalPrompt).toContain("the jaw is too narrow");
    expect(experiment?.resultImageId).not.toBeNull();

    const request = captured[0];
    expect(request?.mode).toBe("intent");
    if (request?.mode === "intent") {
      expect(request.intent.versionId).toBe(PINNED_VERSION);
      expect(request.intent.references.map((reference) => reference.role)).toEqual(["before", "identity"]);
    }
  });

  it("refuses a pass whose subject has no identity pack to draw from, before any spend", async () => {
    stubSuccessfulRenderer();
    // A character with no canonical portrait: the pack machinery has nothing to
    // derive from, so there is nothing to improve the face toward.
    const source = await seedFinishedSource(await seedOwnedCharacter());
    const { id, sink } = await createFinishingPass(source.id);

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("identity_unavailable"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("identity_unavailable"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
    // Still readable afterwards: the pointer is what an admin re-runs from.
    expect(experiment?.sourceExperimentId).toBe(source.id);
  });

  it("refuses a pass whose source was deleted after it was queued", async () => {
    stubSuccessfulRenderer();
    const source = await seedFinishedSource(await seedCharacterWithPortrait());
    const { id, sink } = await createFinishingPass(source.id);
    await deleteImageLabExperiment(source.id, ownerId);

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("source_invalid"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("source_invalid"));
    expect(captured).toHaveLength(0);
  });

  it("refuses the probe's raw provider bag on a finishing pass too", async () => {
    stubSuccessfulRenderer();
    const source = await seedFinishedSource(await seedCharacterWithPortrait());
    const { id, sink } = await createFinishingPass(source.id, {
      settings: { controls: {}, controlInput: { go_faster: true } },
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("settings_unsupported"));
    expect(captured).toHaveLength(0);
  });

  it("refuses a pass naming a LoRA the library does not have, before any spend", async () => {
    // The LoRA is resolved in the runner, ahead of the provider call, so a
    // library problem settles onto the row with its own code where an admin can
    // read it — rather than being discovered by a prediction that has already been
    // paid for. The code lands VERBATIM, exactly as the `image_profile.*` refusals do.
    stubSuccessfulRenderer();
    const source = await seedFinishedSource(await seedCharacterWithPortrait());
    const { id, sink } = await createFinishingPass(source.id, {
      settings: { controls: { lora: { id: "imagelabmissingloraaaaaa" } }, controlInput: {} },
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe("image_lora.unreachable_configuration");
    expect(codes(sink)).toContain("image_lora.unreachable_configuration");
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
  });

  it("runs the LoRA-only arm on the base render alone, and never asks the identity pack", async () => {
    stubSuccessfulRenderer();
    // A character with NO canonical portrait — the exact fixture that settles
    // `identity_unavailable` on the identity arm above. Succeeding here is the
    // assertion that the pack was never consulted: there is nothing it could have
    // answered with, so a run that asked it could not have got this far.
    const source = await seedFinishedSource(await seedOwnedCharacter());
    const { id, sink } = await createFinishingPass(source.id, {
      modelSlug: LORA_SLUG,
      finishingVariant: "lora_only",
      settings: { controls: { lora: { id: FIXTURE_LORA_ID, scale: FIXTURE_LORA_SCALE } }, controlInput: {} },
    });

    await runImageLabExperiment(id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(id, ownerId);
    expect(experiment?.status).toBe("succeeded");
    expect(experiment?.failureCode).toBeNull();
    // Both create-time meta keys survived the settle, the whole reason meta
    // writes merge rather than assign.
    expect(experiment?.sourceExperimentId).toBe(source.id);
    expect(experiment?.finishingVariant).toBe("lora_only");
    // ONE ordered input, written back by the runner: the source's render, and
    // nothing beside it.
    expect(experiment?.inputs.map((input) => input.role)).toEqual(["before"]);
    expect(experiment?.inputs[0]?.imageId).toBe(source.resultImageId);
    // The record cites the arm's own recipe, so a verdict written weeks later
    // cannot mistake this for a pass that also sent the pack.
    expect(experiment?.outcome?.recipeKey).toBe(IMAGE_LAB_FINISHING_LORA_ONLY_RECIPE_KEY);
    expect(experiment?.outcome?.sentRoles).toEqual(["before"]);
    expect(experiment?.outcome?.dropped).toEqual([]);
    expect(experiment?.requestedVersionId).toBe(PINNED_VERSION);
    // The prompt cannot name a slot this arm did not fill.
    expect(experiment?.finalPrompt).toContain("No identity reference image is supplied");
    expect(experiment?.finalPrompt).not.toContain("Image 2:");

    const request = captured[0];
    expect(request?.mode).toBe("intent");
    if (request?.mode === "intent") {
      expect(request.intent.references.map((reference) => reference.role)).toEqual(["before"]);
      expect(request.intent.versionId).toBe(PINNED_VERSION);
      // Pre-resolved by the shared recipe runner, exactly as on the identity arm.
      expect(request.intent.resolvedLora?.id).toBe(FIXTURE_LORA_ID);
      expect(request.intent.resolvedLora?.scale).toBe(FIXTURE_LORA_SCALE);
    }
    expect(codes(sink)).not.toContain(imageLabDiagnosticCode("identity_unavailable"));
  });

  it("refuses a LoRA-only pass whose row names no LoRA, before any spend", async () => {
    stubSuccessfulRenderer();
    // Inserted directly, because the create request refuses this pair outright:
    // the only ways a row reaches the runner in this state are predating that
    // rule, or a caller that went around the request schema.
    //
    // The subject DOES have a usable pack, so a runner that quietly fell back to
    // the identity arm would succeed here rather than fail — which is what makes
    // the refusal below evidence about the arm and not about the character.
    const characterId = await seedCharacterWithPortrait();
    const source = await seedFinishedSource(characterId);
    const [row] = await db()
      .insert(imageLabExperiments)
      .values({
        ownerId,
        kind: "finishing_pass",
        modelSlug: LORA_SLUG,
        characterId,
        instruction: "",
        inputs: [],
        settings: {},
        meta: { sourceExperimentId: source.id, finishingVariant: "lora_only" },
        status: "pending",
      })
      .returning({ id: imageLabExperiments.id });
    if (!row) throw new Error("failed to seed a LoRA-only pass with no LoRA");
    const sink = new DiagnosticCollector();

    await runImageLabExperiment(row.id, ownerId, sink);

    const experiment = await getImageLabExperimentDetail(row.id, ownerId);
    expect(experiment?.status).toBe("failed");
    expect(experiment?.failureCode).toBe(imageLabDiagnosticCode("input_missing"));
    expect(codes(sink)).toContain(imageLabDiagnosticCode("input_missing"));
    expect(captured).toHaveLength(0);
    expect(experiment?.resultImageId).toBeNull();
    // Not "the pack had nothing": the arm's identity is that it never asks.
    expect(codes(sink)).not.toContain(imageLabDiagnosticCode("identity_unavailable"));
  });

  it("records a finishing ruling and refuses one from the control vocabulary", async () => {
    stubSuccessfulRenderer();
    const source = await seedFinishedSource(await seedCharacterWithPortrait());
    const { id } = await createFinishingPass(source.id);
    await runImageLabExperiment(id, ownerId);

    const recorded = await recordImageLabVerdict(id, ownerId, {
      verdict: "improves_identity",
      note: "the jaw matches the reference; pose, jacket and lighting are unchanged",
    });
    expect(recorded?.ok).toBe(true);
    if (recorded?.ok) expect(recorded.experiment.verdict).toBe("improves_identity");

    // A control judgment against a run that sent no control would read, six
    // months later, exactly like one that did.
    const refused = await recordImageLabVerdict(id, ownerId, {
      verdict: "honours_control",
      note: "wrong vocabulary",
    });
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.refusal.code).toBe("verdict_not_in_vocabulary");
  });
});

describe.skipIf(!ready)("image lab experiment records", () => {
  it("refuses a finishing pass whose source is not an experiment this owner has", async () => {
    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "finishing_pass", instruction: "", inputs: [], sourceExperimentId: "expnotyoursaaaaaaaaaaaaa" },
    });
    expect(created.ok).toBe(false);
    // BARE on the wire, as every refusal envelope is: the dotted `image_lab.`
    // spelling is the diagnostic sink's, and a settled row's.
    if (!created.ok) expect(created.refusal.code).toBe("source_not_found");
  });

  it("refuses a finishing pass over a probe — the one succeeded kind that cannot be finished", async () => {
    stubSuccessfulRenderer();
    const { id } = await createRunnableProbe();
    await runImageLabExperiment(id, ownerId);

    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "finishing_pass", instruction: "", inputs: [], sourceExperimentId: id },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("source_kind_unsupported");
  });

  it("refuses a finishing pass over a run that has not produced an image", async () => {
    const { id } = await createControlledExperiment();
    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "finishing_pass", instruction: "", inputs: [], sourceExperimentId: id },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("source_not_rendered");
  });

  it("refuses a baseline naming another owner's character", async () => {
    const created = await createImageLabExperiment({
      ownerId,
      request: { kind: "baseline_portrait", characterId: "chrnotyoursaaaaaaaaaaaaa", instruction: "", inputs: [] },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.refusal.code).toBe("character_not_found");
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
    // The record carries the bare code; the dotted one is the sink's.
    expect(first).toMatchObject({ controlKind: "depth", failureCode: "preprocessor_output_invalid" });
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
    expect(first).toMatchObject({ failureCode: "render_failed" });
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

  it("adopts a pre-split fixture's stranded note as its origin note when it is reviewed", async () => {
    // The shape rows carried before the two notes split: the CREATION annotation
    // sitting in `reviewNote`, with no `reviewedAt` beside it and no `originNote`
    // of its own. Nothing migrates these in bulk, so the review is both the last
    // thing that can rescue the string and the only thing that could destroy it.
    const controlId = await seedReadyImage("lab_control", {
      hidden: true,
      controlKind: "pose",
      generator: "hand_authored",
      reviewNote: "drawn over the sofa shot",
    });
    const sink = new DiagnosticCollector();

    const reviewed = await reviewImageLabControl(ownerId, controlId, "skeleton reads cleanly; both wrists resolved", sink);
    expect(reviewed?.ok).toBe(true);
    if (reviewed?.ok) {
      expect(reviewed.control.meta.originNote).toBe("drawn over the sofa shot");
      expect(reviewed.control.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
      expect(reviewed.control.meta.reviewedAt).toBeTruthy();
    }

    // Rescued in the STORE, not just in the answer: the tile hides an unreviewed
    // row's `reviewNote`, so a string this write dropped would have vanished
    // without an admin ever having seen it.
    const [listed] = await listImageLabControls(ownerId, sink);
    expect(listed?.meta.originNote).toBe("drawn over the sofa shot");
    expect(listed?.meta.reviewNote).toBe("skeleton reads cleanly; both wrists resolved");
    expect(listed?.meta.reviewedAt).toBeTruthy();
  });

  it("refuses to review an image that is not a lab control fixture", async () => {
    // Owned and ready, and entirely unable to say what fixture it is.
    const notAFixture = await seedReadyImage("portrait_variant");
    const refused = await reviewImageLabControl(ownerId, notAFixture, "looks fine to me");
    expect(refused?.ok).toBe(false);
    if (refused && !refused.ok) expect(refused.refusal.code).toBe("control_invalid");
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
