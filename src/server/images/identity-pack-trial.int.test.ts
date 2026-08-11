import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { diag, DiagnosticCollector } from "@/contracts/diagnostics";
import {
  imageIdentityPackTrialResultSchema,
  perTrialGradeDimension,
  REPLICATE_VERSION_UNDISCLOSED,
  type IdentityReferenceStrategy,
  type ImageIdentityPackTrialCellSpec,
  type ImageIdentityPackTrialCreateRequest,
  type ImageIdentityPackTrialResult,
  type TrialPairGrades,
} from "@/contracts";
import { IDENTITY_PACK_POLICY_VERSION } from "@/lib/images/identity-pack-policy";
import { trialPromptFixtureById } from "@/lib/images/identity-pack-trial";
import {
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
  testPngBuffer,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import {
  characters,
  db,
  imageIdentityPacks,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageIdentityPackTrialVerdicts,
  imageModelProfiles,
  imageModels,
  images,
} from "../db";
import { absoluteImagePath, createImageAsset, GALLERY_IMAGE_KINDS, saveImageBuffer, type ImageRow } from "./assets";
import { ensureIdentityPack, saveManualIdentityCrop } from "./identity-packs";
import {
  createIdentityPackTrialRun,
  deleteIdentityPackTrialRun,
  executeIdentityPackTrialCells,
  getIdentityPackTrialRunDetail,
  identityPackTrialSummary,
  listIdentityPackTrialRuns,
  nextUnreviewedTrialPair,
  recordTrialVerdict,
  runTrialExecutionPassForTesting,
  setTrialRendererForTesting,
  STALE_CLAIM_MS,
  submitTrialPairGrade,
  trialPairLeftIsA,
  type IdentityPackTrialCellRow,
  type RecordTrialVerdictInput,
  type TrialCellRenderer,
  type TrialCellRenderInput,
} from "./identity-pack-trial";
import { TRIAL_FALLBACK_PREDICTION_MS } from "./render-profile";

/**
 * The trial service end to end against DATABASE_URL and a sandboxed DATA_ROOT
 * (image-identity-packs.spec.trial.md; design doc Wave 2). The renderer seam is
 * always injected — Replicate is never called — so what is under test is the
 * service's own machinery: plan resolution and per-cell refusal codes, bounded
 * execution with settled-cell terminality, the derived-and-persisted blind
 * mapping, grade unblinding, verdict-driven completion, and the delete sweep.
 *
 * Registry rows (`image_models` / `image_model_profiles`) are global — outside
 * `purgeOwnerRows` — so this suite plants its own by id, delete-first, exactly
 * like `model-profiles.int.test.ts`.
 */

const ready = await probeIntegrationDb("identity pack trial.int.test", "image_identity_pack_trial_runs");

const TRIAL_MODEL_ID = "imgmdltrialharnessaaaaaa";
const TRIAL_PROFILE_ID = "imgprftrialharnessaaaaaa";
const TIGHT_MODEL_ID = "imgmdltrialtightaaaaaaaa";
const TIGHT_PROFILE_ID = "imgprftrialtightaaaaaaaa";
const CONTROLS_MODEL_ID = "imgmdltrialcontrolsaaaaa";
const CONTROLS_PROFILE_ID = "imgprftrialcontrolsaaaaa";
/**
 * The INELIGIBLE fixtures: one model per production gate the planner now reuses
 * from `imageProfileOffered`, so each refusal case can name exactly one reason.
 * A profile that fails two gates at once would pass its assertion for whichever
 * one fired first and prove nothing about the other.
 */
const WEAK_MODEL_ID = "imgmdltrialweakaaaaaaaaa";
const WEAK_PROFILE_ID = "imgprftrialweakaaaaaaaaa";
const IMG2IMG_MODEL_ID = "imgmdltrialimg2imgaaaaaa";
const IMG2IMG_PROFILE_ID = "imgprftrialimg2imgaaaaaa";
const NO_GENERATE_PROFILE_ID = "imgprftrialnogenaaaaaaaa";
const SURFACE_OFF_MODEL_ID = "imgmdltrialsurfaceaaaaaa";
const SURFACE_OFF_PROFILE_ID = "imgprftrialsurfaceaaaaaa";
/** An OFFERED generate profile — the only shape the no-pack baseline accepts. */
const GENERATE_PROFILE_ID = "imgprftrialgenerateaaaaa";
/**
 * A generate profile whose REVIEWED reference policy allows roles but not
 * `identity`. Production would never hand it an identity reference, so its
 * pack-source cells must refuse — while its no-pack baseline, which sends no
 * references at all, is untouched. Generate so both arms are expressible on one
 * profile.
 */
const POLICY_OFF_PROFILE_ID = "imgprftrialpolicyoffaaaa";
/**
 * The harness profile with ONE field changed: a `promptStrategy` the
 * identity-reference path has no vocabulary to compile (`text_repair` needs a
 * text region and its replacement). Cloned rather than hand-written so the
 * refusal it earns can only be about the strategy — every other field that
 * decides a gate is byte-identical to a profile that plans.
 */
const TEXT_REPAIR_PROFILE_ID = "imgprftrialtextrepairaaa";
const FIXTURE_MODEL_IDS = [
  TRIAL_MODEL_ID,
  TIGHT_MODEL_ID,
  CONTROLS_MODEL_ID,
  WEAK_MODEL_ID,
  IMG2IMG_MODEL_ID,
  SURFACE_OFF_MODEL_ID,
];
const FIXTURE_PROFILE_IDS = [
  TRIAL_PROFILE_ID,
  TIGHT_PROFILE_ID,
  CONTROLS_PROFILE_ID,
  WEAK_PROFILE_ID,
  IMG2IMG_PROFILE_ID,
  NO_GENERATE_PROFILE_ID,
  SURFACE_OFF_PROFILE_ID,
  GENERATE_PROFILE_ID,
  POLICY_OFF_PROFILE_ID,
  TEXT_REPAIR_PROFILE_ID,
];

/**
 * Every fixture model carries a PROBED VERSION. A controlled trial refuses to
 * plan a cell whose provider version cannot be pinned (`version_unpinned`), so
 * an unprobed fixture row would make this whole suite a study of that refusal.
 */
const TRIAL_MODEL_VERSION = "trialversionaaaaaaaaaaaa";
const CONTROLS_MODEL_VERSION = "controlsversionaaaaaaaaa";

const WARDROBE_FIXTURE = "variant_wardrobe_v1";
const POSE_FIXTURE = "variant_pose_v1";
/** A SCENE-task fixture — the one the variant profiles above must refuse. */
const SCENE_FIXTURE = "scene_cafe_waist_up_v1";
/** The fixture's own text, read from the checked-in list rather than copied: a
 * copy here would keep passing while the real prompt drifted underneath it. */
const WARDROBE_FIXTURE_PROMPT = trialPromptFixtureById(WARDROBE_FIXTURE)?.prompt ?? "";

let temp: TempDataRoot | undefined;
let ownerId = "";
let otherOwnerId = "";
/** A character with a ready 384×512 portrait — heuristic-pack eligible. */
let subjectId = "";
/** A character with NO portrait: every cell of it must refuse `pack_blocked`. */
let bareCharacterId = "";
/** The other user's character — must be indistinguishable from `bareCharacterId`. */
let foreignCharacterId = "";

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-identity-trial-int");
  ownerId = (await seedTestUser("identity-trial-int")).id;
  otherOwnerId = (await seedTestUser("identity-trial-int-other")).id;

  // Delete first so a run that died before afterAll cannot leave stale registry
  // fixtures behind for this run to trip over.
  await db().delete(imageModelProfiles).where(inArray(imageModelProfiles.id, FIXTURE_PROFILE_IDS));
  await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  // `forVariant` is what the legacy surface gate reads, and it defaults to FALSE.
  // Every runnable fixture below therefore has to tick it: the planner asks
  // `imageProfileOffered` the same question production selection asks, and a
  // fixture model an operator had never enabled for the variant surface is not a
  // model the trial may grade.
  await db().insert(imageModels).values([
    {
      id: TRIAL_MODEL_ID,
      slug: "vesper-test/identity-trial",
      label: "Identity Trial Fixture",
      canGenerate: true,
      canEdit: true,
      forVariant: true,
      maxReferences: 4,
      probedVersionId: TRIAL_MODEL_VERSION,
    },
    {
      id: TIGHT_MODEL_ID,
      slug: "vesper-test/identity-trial-tight",
      label: "Identity Trial Tight Fixture",
      canGenerate: true,
      canEdit: true,
      forVariant: true,
      maxReferences: 1,
      probedVersionId: TRIAL_MODEL_VERSION,
    },
    {
      // The only fixture with probed control bindings: everything about "does a
      // profile's configuration actually reach the provider?" is asked of this row.
      id: CONTROLS_MODEL_ID,
      slug: "vesper-test/identity-trial-controls",
      label: "Identity Trial Controls Fixture",
      canGenerate: true,
      canEdit: true,
      forVariant: true,
      maxReferences: 4,
      probedVersionId: CONTROLS_MODEL_VERSION,
      advancedCapabilities: {
        controls: {
          negativePrompt: { field: "negative_prompt", type: "string" },
          guidance: { field: "guidance_scale", type: "number", minimum: 0, maximum: 20 },
        },
        // Deliberately NO `steps` binding: the profile below asks for steps, and
        // the drop it earns is the "nothing is silently ignored" proof.
        knownInputFields: ["negative_prompt", "guidance_scale", "scheduler"],
      },
    },
    {
      // Reviewed `weak`: takes an image and can hand back a different person.
      id: WEAK_MODEL_ID,
      slug: "vesper-test/identity-trial-weak",
      label: "Identity Trial Weak Fixture",
      canGenerate: true,
      canEdit: true,
      forVariant: true,
      identityPreservation: "weak",
      maxReferences: 4,
      probedVersionId: TRIAL_MODEL_VERSION,
    },
    {
      // Strength-based repainting rather than instruction editing, and no
      // text-only path at all — two different gates off one row.
      id: IMG2IMG_MODEL_ID,
      slug: "vesper-test/identity-trial-img2img",
      label: "Identity Trial Img2Img Fixture",
      canGenerate: false,
      canEdit: true,
      forVariant: true,
      editKind: "img2img",
      maxReferences: 4,
      probedVersionId: TRIAL_MODEL_VERSION,
    },
    {
      // Mechanically capable, but the operator never enabled it for variants.
      id: SURFACE_OFF_MODEL_ID,
      slug: "vesper-test/identity-trial-surface-off",
      label: "Identity Trial Surface-Off Fixture",
      canGenerate: true,
      canEdit: true,
      forVariant: false,
      maxReferences: 4,
      probedVersionId: TRIAL_MODEL_VERSION,
    },
  ]);
  await db().insert(imageModelProfiles).values([
    {
      id: TRIAL_PROFILE_ID,
      imageModelId: TRIAL_MODEL_ID,
      key: "trial-harness",
      label: "Trial Harness",
      task: "variant",
      operation: "edit",
      promptStrategy: "instruction_edit",
      isDefault: false,
      sort: 950,
    },
    {
      id: TIGHT_PROFILE_ID,
      imageModelId: TIGHT_MODEL_ID,
      key: "trial-tight",
      label: "Trial Tight",
      task: "variant",
      operation: "edit",
      promptStrategy: "instruction_edit",
      isDefault: false,
      sort: 951,
    },
    {
      id: CONTROLS_PROFILE_ID,
      imageModelId: CONTROLS_MODEL_ID,
      key: "trial-controls",
      label: "Trial Controls",
      task: "variant",
      operation: "edit",
      promptStrategy: "instruction_edit",
      controlDefaults: { negativePrompt: "blurry, watermark", guidance: 6, steps: 30, seedPolicy: "random" },
      providerOverrides: { scheduler: "KarrasDPM" },
      timeoutMs: 90_000,
      isDefault: false,
      sort: 952,
    },
    {
      // A generate profile on an offered model: the ONLY shape the no-pack
      // baseline accepts, and the arm every none-variant case runs through.
      id: GENERATE_PROFILE_ID,
      imageModelId: TRIAL_MODEL_ID,
      key: "trial-generate",
      label: "Trial Generate",
      task: "variant",
      operation: "generate",
      promptStrategy: "text_to_image_description",
      isDefault: false,
      sort: 953,
    },
    {
      id: POLICY_OFF_PROFILE_ID,
      imageModelId: TRIAL_MODEL_ID,
      key: "trial-policy-off",
      label: "Trial Policy Off",
      task: "variant",
      operation: "generate",
      promptStrategy: "text_to_image_description",
      // A REVIEWED policy that names roles and omits identity — as against the
      // seeded `'{}'::jsonb`, which means "nobody has reviewed one" and stays
      // permissive.
      referencePolicy: { allowedRoles: ["location"], requiredRoles: [], roleOrder: ["location"] },
      isDefault: false,
      sort: 958,
    },
    {
      // The harness profile verbatim, save for the prompt strategy — so the only
      // thing its cells can refuse for is the strategy itself.
      id: TEXT_REPAIR_PROFILE_ID,
      imageModelId: TRIAL_MODEL_ID,
      key: "trial-text-repair",
      label: "Trial Text Repair",
      task: "variant",
      operation: "edit",
      promptStrategy: "text_repair",
      isDefault: false,
      sort: 959,
    },
    ineligibleProfile(WEAK_PROFILE_ID, WEAK_MODEL_ID, "trial-weak", "edit", 954),
    ineligibleProfile(IMG2IMG_PROFILE_ID, IMG2IMG_MODEL_ID, "trial-img2img", "edit", 955),
    // Same img2img model, asked for the text-only path it does not have.
    ineligibleProfile(NO_GENERATE_PROFILE_ID, IMG2IMG_MODEL_ID, "trial-nogen", "generate", 956),
    ineligibleProfile(SURFACE_OFF_PROFILE_ID, SURFACE_OFF_MODEL_ID, "trial-surface-off", "edit", 957),
  ]);

  subjectId = (await seedTrialCharacter("Trial Subject")).characterId;
  bareCharacterId = await seedPortraitlessCharacter(ownerId, "Bare Subject");
  foreignCharacterId = await seedPortraitlessCharacter(otherOwnerId, "Foreign Subject");
});

afterEach(() => {
  // One case's scripted renderer must never leak into the next: a case that
  // forgets to inject would otherwise silently call a previous case's fake.
  setTrialRendererForTesting(null);
});

afterAll(async () => {
  if (ready) {
    await db().delete(imageModelProfiles).where(inArray(imageModelProfiles.id, FIXTURE_PROFILE_IDS));
    await db().delete(imageModels).where(inArray(imageModels.id, FIXTURE_MODEL_IDS));
  }
  await temp?.cleanup();
  await purgeOwnerRows([ownerId, otherOwnerId]);
  await endTestPool();
});

/**
 * A profile the planner must refuse, sitting on a model whose one broken flag
 * names the reason. One shared shape because only the model, the operation and
 * the key differ between the four gates — four hand-written rows would invite one
 * of them to drift a field that decides a different gate, and then a case would
 * pass for the wrong reason.
 */
function ineligibleProfile(
  id: string,
  imageModelId: string,
  key: string,
  operation: "generate" | "edit",
  sort: number,
): typeof imageModelProfiles.$inferInsert {
  return {
    id,
    imageModelId,
    key,
    label: key,
    task: "variant",
    operation,
    promptStrategy: operation === "edit" ? "instruction_edit" : "text_to_image_description",
    isDefault: false,
    sort,
  };
}

/** A character with NO portrait — every pack resolution for it must block. */
async function seedPortraitlessCharacter(owner: string, name: string): Promise<string> {
  const [row] = await db()
    .insert(characters)
    .values({ ownerId: owner, name, profile: {} })
    .returning({ id: characters.id });
  if (!row) throw new Error(`failed to insert ${name}`);
  return row.id;
}

/** A character whose canonical portrait is stored through the normal asset path. */
async function seedTrialCharacter(name: string): Promise<{ characterId: string; portraitId: string }> {
  const [character] = await db()
    .insert(characters)
    .values({ ownerId, name, profile: {} })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to insert the trial character");
  const asset = await createImageAsset({
    ownerId,
    kind: "avatar",
    entityKind: "character",
    entityId: character.id,
    prompt: "trial portrait",
  });
  const saved = await saveImageBuffer(asset.id, await testPngBuffer(384, 512));
  if (saved?.status !== "ready") throw new Error("failed to store the trial portrait");
  await db().update(characters).set({ avatarImageId: saved.id }).where(eq(characters.id, character.id));
  return { characterId: character.id, portraitId: saved.id };
}

function trialRequest(over: Partial<ImageIdentityPackTrialCreateRequest> = {}): ImageIdentityPackTrialCreateRequest {
  return {
    label: "trial",
    characterIds: [subjectId],
    profileIds: [TRIAL_PROFILE_ID],
    strategies: ["canonical_only", "face_detail_only"],
    promptFixtureIds: [WARDROBE_FIXTURE],
    ...over,
  };
}

/** Create a run that MUST succeed, returning its id. */
async function createdRunId(over: Partial<ImageIdentityPackTrialCreateRequest> = {}): Promise<string> {
  const result = await createIdentityPackTrialRun({ ownerId, request: trialRequest(over) });
  if (!result.ok) throw new Error(`run creation refused: ${result.refusal.code}`);
  return result.runId;
}

async function runRow(runId: string): Promise<typeof imageIdentityPackTrialRuns.$inferSelect | undefined> {
  const [row] = await db()
    .select()
    .from(imageIdentityPackTrialRuns)
    .where(eq(imageIdentityPackTrialRuns.id, runId))
    .limit(1);
  return row;
}

async function cellRows(runId: string): Promise<IdentityPackTrialCellRow[]> {
  return db()
    .select()
    .from(imageIdentityPackTrialCells)
    .where(eq(imageIdentityPackTrialCells.runId, runId))
    .orderBy(asc(imageIdentityPackTrialCells.cellKey));
}

/**
 * Every cell's claim stamp in milliseconds, keyed by cell id — null where no
 * claim is stamped. Read as a NUMBER so two observations can be compared for
 * ADVANCE, which is the only way to see a heartbeat: the column always holds
 * some timestamp while a cell is claimed, so the question is never "is it set?"
 * but "did it move since the last cell boundary?".
 */
async function claimStamps(runId: string): Promise<Map<string, number | null>> {
  const rows = await db()
    .select({ id: imageIdentityPackTrialCells.id, claimedAt: imageIdentityPackTrialCells.claimedAt })
    .from(imageIdentityPackTrialCells)
    .where(eq(imageIdentityPackTrialCells.runId, runId));
  return new Map(rows.map((row) => [row.id, row.claimedAt === null ? null : row.claimedAt.getTime()]));
}

async function outputImageRows(runId: string): Promise<ImageRow[]> {
  const ids = (await cellRows(runId))
    .map((cell) => cell.outputImageId)
    .filter((imageId): imageId is string => imageId !== null);
  if (ids.length === 0) return [];
  return db().select().from(images).where(inArray(images.id, ids));
}

/** A chargeBudget that always admits the pass — for cases not about the charge. */
const admitCharge = (): Promise<null> => Promise.resolve(null);

/** A chargeBudget that always admits the pass, recording every charged count. */
function recordingCharge(): { chargeBudget: (count: number) => Promise<null>; charges: number[] } {
  const charges: number[] = [];
  return {
    chargeBudget: (count: number) => {
      charges.push(count);
      return Promise.resolve(null);
    },
    charges,
  };
}

/** A renderer that succeeds with a real decodable buffer, counting every call. */
function countingRenderer(): { renderer: TrialCellRenderer; calls: () => number } {
  let calls = 0;
  return {
    renderer: async () => {
      calls += 1;
      return { ok: true, image: await testPngBuffer(96, 128) };
    },
    calls: () => calls,
  };
}

/** A renderer that parks inside the call until released — how a pass is held
 * open long enough for a second caller to observably collide with it. */
function gatedRenderer(): {
  renderer: TrialCellRenderer;
  entered: () => boolean;
  calls: () => number;
  release: () => void;
} {
  let calls = 0;
  let open!: () => void;
  const parked = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    renderer: async () => {
      calls += 1;
      await parked;
      return { ok: true, image: await testPngBuffer(96, 128) };
    },
    entered: () => calls > 0,
    calls: () => calls,
    release: () => {
      open();
    },
  };
}

/** A succeeding renderer that keeps every input it was handed. The seam is the
 * proof surface for "the trial sends what the profile compiled", so the cases
 * that assert it read the captured input rather than trusting the stored spec. */
function capturingRenderer(predictionId?: string): { renderer: TrialCellRenderer; inputs: TrialCellRenderInput[] } {
  const inputs: TrialCellRenderInput[] = [];
  return {
    renderer: async (input) => {
      inputs.push(input);
      return { ok: true, image: await testPngBuffer(96, 128), ...(predictionId ? { predictionId } : {}) };
    },
    inputs,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A reference buffer's fingerprint. Comparing digests keeps a failed assertion
 * readable where comparing two whole PNGs would not. */
function bufferDigest(buffer: Buffer | undefined): string {
  return buffer ? createHash("sha256").update(buffer).digest("hex") : "";
}

/** One cell's stored spec, read from the row rather than through the service —
 * so a field the service stops persisting shows up as a failure here. */
async function storedSpec(runId: string, index = 0): Promise<ImageIdentityPackTrialCellSpec> {
  const row = (await cellRows(runId))[index];
  if (!row) throw new Error("[trial int] no cell at that index");
  return row.specJson as ImageIdentityPackTrialCellSpec;
}

/** One cell's recorded outcome, parsed through the contract — a refusal whose
 * result no longer satisfies the shape is a failure here, not a silent `{}`. */
function storedResult(cell: IdentityPackTrialCellRow): ImageIdentityPackTrialResult {
  const parsed = imageIdentityPackTrialResultSchema.safeParse(cell.resultJson);
  if (!parsed.success) throw new Error("[trial int] the cell stored no parseable result");
  return parsed.data;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** All eleven dimensions tied except a strong preference for the LEFT image. */
function gradesFavoringLeft(): TrialPairGrades {
  return { ...perTrialGradeDimension(() => 0), overall_preference: -2 };
}

/** A run executed end to end through a succeeding renderer — every cell
 * rendered, run settled into `review`, no pair graded yet. */
async function reviewedRun(label: string): Promise<string> {
  const runId = await createdRunId({ label });
  setTrialRendererForTesting(countingRenderer().renderer);
  const executed = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 20, chargeBudget: admitCharge });
  if (!executed?.ok) throw new Error(`[trial int] executing "${label}" was refused`);
  return runId;
}

/** Drain the blinded review queue, returning how many pairs were graded. Bounded
 * rather than `while (true)`: a queue that never empties is a bug in the code
 * under test, and a hanging test reports it as a timeout instead of a failure. */
async function gradeEveryPair(runId: string): Promise<number> {
  let graded = 0;
  for (let pass = 0; pass < 64; pass += 1) {
    const pair = (await nextUnreviewedTrialPair(runId, ownerId))?.pair;
    if (!pair) return graded;
    const result = await submitTrialPairGrade({
      runId,
      ownerId,
      request: {
        pairId: pair.pairId,
        grades: gradesFavoringLeft(),
        catastrophicLeft: [],
        catastrophicRight: [],
        notes: null,
      },
    });
    if (!result?.ok) throw new Error("[trial int] grading a served pair was refused");
    graded += 1;
  }
  throw new Error("[trial int] the review queue never emptied");
}

/** The stored verdict ledger, strategy-ordered — read from the table, not the
 * service, so a lost or duplicated ruling shows up as a row count. */
async function verdictRows(runId: string): Promise<(typeof imageIdentityPackTrialVerdicts.$inferSelect)[]> {
  return db()
    .select()
    .from(imageIdentityPackTrialVerdicts)
    .where(eq(imageIdentityPackTrialVerdicts.runId, runId))
    .orderBy(asc(imageIdentityPackTrialVerdicts.identityStrategy));
}

/** One verdict submission against the suite's fixed profile, with a stated reason. */
function verdictInput(
  runId: string,
  identityStrategy: IdentityReferenceStrategy,
  over: Partial<RecordTrialVerdictInput> = {},
): RecordTrialVerdictInput {
  return {
    runId,
    ownerId,
    profileId: TRIAL_PROFILE_ID,
    identityStrategy,
    verdict: "retained_current",
    reason: "int-test ruling",
    ...over,
  };
}

describe.skipIf(!ready)("trial run creation", () => {
  it("plans eligible cells with full specs and records blocked ones refused with pack_blocked", async () => {
    const sink = new DiagnosticCollector();
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({ characterIds: [subjectId, bareCharacterId] }),
      sink,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({ planned: 2, running: 0, rendered: 0, failed: 0, refused: 2 });
    expect((await runRow(result.runId))?.status).toBe("draft");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.trial.pack_blocked");

    const detail = await getIdentityPackTrialRunDetail(result.runId, ownerId);
    expect(detail?.cells).toHaveLength(4);
    const bySubject = detail?.cells.filter((cell) => cell.cellKey.startsWith(`${subjectId}:`)) ?? [];
    for (const cell of bySubject) {
      expect(cell.status).toBe("planned");
      // The full spec-time identity: pinned model/profile, pack revision, hashes.
      expect(cell.spec).toMatchObject({
        characterId: subjectId,
        task: "variant",
        modelSlug: "vesper-test/identity-trial",
        // A real pinned provider version, never a placeholder: an unpinnable
        // model refuses `version_unpinned` rather than planning a cell that
        // cannot say what produced its evidence.
        modelVersion: TRIAL_MODEL_VERSION,
        profileKey: "trial-harness",
        packRevision: 1,
        cropMethod: "heuristic",
        derivationVersion: "derive_v1",
        requestedSeed: null,
        // Single-variant runs pin the character's current pack and send
        // references, and the cell records the compiled configuration it WILL
        // send — this fixture profile configures no controls, so the payload is
        // empty and nothing was dropped.
        packVariantKey: "current",
        referenceSource: "pack",
        // The timeout is the RESOLVED number, not the profile's null: a cell
        // records the budget it will actually run under, never "whatever the
        // machine's env said that day".
        resolvedControls: {
          operation: "edit",
          timeoutMs: TRIAL_FALLBACK_PREDICTION_MS,
          controlInput: {},
          droppedControls: [],
        },
      });
      expect(cell.spec?.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cell.spec?.positivePromptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cell.spec?.negativePromptHash).toBeNull();
      expect(cell.spec?.resolvedControlsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cell.spec?.orderedReferenceRoles).toEqual(
        cell.spec?.identityStrategy === "canonical_only" ? ["canonical_identity"] : ["face_detail"],
      );
    }
    const blocked = detail?.cells.filter((cell) => cell.cellKey.startsWith(`${bareCharacterId}:`)) ?? [];
    for (const cell of blocked) {
      expect(cell.status).toBe("refused");
      expect(cell.result?.failureCode).toBe("pack_blocked");
      // Refused before pack resolution: the stored spec is honestly partial and
      // reads back null rather than parsing a fabricated pack identity.
      expect(cell.spec).toBeNull();
    }
  });

  it("refuses an unknown corpus without creating anything", async () => {
    const before = (await listIdentityPackTrialRuns(ownerId)).length;
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: {
        label: "corpus trial",
        corpusId: "no_such_corpus",
        profileIds: [TRIAL_PROFILE_ID],
        strategies: ["canonical_only"],
        promptFixtureIds: [WARDROBE_FIXTURE],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("unknown_corpus");
    expect((await listIdentityPackTrialRuns(ownerId)).length).toBe(before);
  });

  it("refuses an unknown prompt fixture without creating anything", async () => {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({ promptFixtureIds: ["variant_wardrobe_v999"] }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("fixture_unknown");
  });

  it("records another owner's character exactly like a character that does not exist", async () => {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({ characterIds: [foreignCharacterId], strategies: ["canonical_only"] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({ planned: 0, running: 0, rendered: 0, failed: 0, refused: 1 });
    const [cell] = await cellRows(result.runId);
    expect(cell?.status).toBe("refused");
    const detail = await getIdentityPackTrialRunDetail(result.runId, ownerId);
    // The same code the missing-portrait character earns: not-yours ≡ gone.
    expect(detail?.cells[0]?.result?.failureCode).toBe("pack_blocked");
    // Nothing plannable, so the run is born in review: `draft` would wedge it
    // (the execute path never fires), and it must stay honestly deletable.
    expect((await runRow(result.runId))?.status).toBe("review");
  });

  it("refuses a grid over the cell ceiling as a whole-run too_many_cells", async () => {
    const twelveCharacters = Array.from({ length: 12 }, (_, index) => `trialcapcharacter${index}xx`);
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        characterIds: twelveCharacters,
        strategies: ["canonical_only", "face_detail_only", "canonical_then_face_detail", "face_detail_then_canonical"],
        promptFixtureIds: [WARDROBE_FIXTURE, POSE_FIXTURE, "scene_cafe_waist_up_v1"],
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("too_many_cells");
  });

  it("refuses a cell whose roles exceed the model's reference capacity, with a FULL spec", async () => {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        profileIds: [TIGHT_PROFILE_ID],
        strategies: ["canonical_then_face_detail", "face_detail_only"],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({ planned: 1, running: 0, rendered: 0, failed: 0, refused: 1 });
    const detail = await getIdentityPackTrialRunDetail(result.runId, ownerId);
    const refused = detail?.cells.find((cell) => cell.status === "refused");
    expect(refused?.result?.failureCode).toBe("capacity_exceeded");
    // Capacity is the LAST check, so everything resolved: this refusal keeps a
    // fully parseable spec, unlike the pre-resolution refusals.
    expect(refused?.spec?.orderedReferenceRoles).toEqual(["canonical_identity", "face_detail"]);
    const planned = detail?.cells.find((cell) => cell.status === "planned");
    expect(planned?.spec?.identityStrategy).toBe("face_detail_only");
  });

  it("treats two creates with the same label as independent runs", async () => {
    const first = await createdRunId({ label: "same label" });
    const second = await createdRunId({ label: "same label" });
    expect(first).not.toBe(second);
    const listed = await listIdentityPackTrialRuns(ownerId);
    const sameLabel = listed.filter((run) => run.label === "same label");
    expect(sameLabel.map((run) => run.id).sort()).toEqual([first, second].sort());
  });
});

/**
 * REAL profile eligibility at planning time. Every case below is a combination a
 * production render would never resolve — a profile for another job, a model an
 * operator switched off the surface, a model whose reviewed ratings say it cannot
 * hold a face — and every one of them used to plan, render and be GRADED, which
 * is evidence for a render nobody can have.
 *
 * The judgment is not restated here: the planner asks `imageProfileOffered`, the
 * same predicate production selection asks, so trial eligibility and production
 * eligibility cannot drift apart. These cases prove each of its gates reaches a
 * cell, and the last one proves the gates did not become a blanket refusal.
 */
describe.skipIf(!ready)("planning eligibility", () => {
  /** Plan a ONE-CELL run that must refuse, and hand back the recorded cell. */
  async function refusedCell(over: Partial<ImageIdentityPackTrialCreateRequest>): Promise<IdentityPackTrialCellRow> {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({ strategies: ["canonical_only"], ...over }),
    });
    if (!result.ok) throw new Error(`[trial int] run creation refused: ${result.refusal.code}`);
    // Refused at PLANNING: no cell is plannable, so no pass can ever claim one,
    // and neither the render budget nor the provider seam is reachable at all.
    expect(result.counts).toEqual({ planned: 0, running: 0, rendered: 0, failed: 0, refused: 1 });
    const [cell] = await cellRows(result.runId);
    if (!cell) throw new Error("[trial int] the refused run recorded no cell");
    expect(cell.status).toBe("refused");
    return cell;
  }

  /** The reason string, asserted to be a `profile_ineligible` refusal naming it. */
  function ineligibleReason(cell: IdentityPackTrialCellRow): string {
    const result = storedResult(cell);
    expect(result.failureCode).toBe("profile_ineligible");
    return result.failureMessage ?? "";
  }

  it("refuses a cell whose profile is for a different task than its fixture", async () => {
    const cell = await refusedCell({ promptFixtureIds: [SCENE_FIXTURE] });
    // Both tasks named: an operator must see WHICH pairing was wrong, not just
    // that one was.
    const reason = ineligibleReason(cell);
    expect(reason).toContain("variant");
    expect(reason).toContain("scene");
    // The refusal still records everything that DID resolve up to it.
    const spec = cell.specJson as Partial<ImageIdentityPackTrialCellSpec>;
    expect(spec.profileKey).toBe("trial-harness");
    expect(spec.modelSlug).toBe("vesper-test/identity-trial");
    expect(spec.task).toBe("scene");
  });

  it("refuses an identity-critical cell on a model reviewed weak at holding a face", async () => {
    expect(ineligibleReason(await refusedCell({ profileIds: [WEAK_PROFILE_ID] }))).toContain("identity_too_weak");
  });

  it("refuses an identity-critical cell on an img2img model", async () => {
    expect(ineligibleReason(await refusedCell({ profileIds: [IMG2IMG_PROFILE_ID] }))).toContain(
      "img2img_identity_task",
    );
  });

  it("refuses a generate profile whose model cannot run without a reference", async () => {
    expect(ineligibleReason(await refusedCell({ profileIds: [NO_GENERATE_PROFILE_ID] }))).toContain(
      "operation_unsupported",
    );
  });

  it("refuses a cell whose model the operator excluded from the task's legacy surface", async () => {
    expect(ineligibleReason(await refusedCell({ profileIds: [SURFACE_OFF_PROFILE_ID] }))).toContain(
      "legacy_surface_excluded",
    );
  });

  it("refuses an identity-reference cell on a profile whose reviewed policy forbids identity", async () => {
    // Production would never hand this profile an identity reference, so a cell
    // that sent one would be grading a configuration the render path cannot
    // produce.
    const reason = ineligibleReason(await refusedCell({ profileIds: [POLICY_OFF_PROFILE_ID] }));
    expect(reason).toContain("reference policy does not allow identity references");

    // The same profile's NO-PACK baseline is untouched: it sends no references
    // at all, so there is no policy question to answer.
    const baseline = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "policy-off baseline",
        profileIds: [POLICY_OFF_PROFILE_ID],
        strategies: ["canonical_only"],
        packVariants: [{ source: "none" }],
      }),
    });
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) return;
    expect(baseline.counts).toEqual({ planned: 1, running: 0, rendered: 0, failed: 0, refused: 0 });

    // And an EMPTY policy — the seeded default, "nobody reviewed one" — stays
    // permissive. Reading "nothing recorded" as "nothing allowed" would refuse
    // every seeded profile and quietly empty the grid.
    const permissive = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({ label: "unreviewed policy", strategies: ["canonical_only"] }),
    });
    expect(permissive.ok).toBe(true);
    if (!permissive.ok) return;
    expect(permissive.counts.planned).toBe(1);
  });

  it("refuses a cell whose profile declares a prompt strategy the trial cannot execute", async () => {
    // `promptStrategy` used to be hashed and never consulted, so a `text_repair`
    // profile planned, rendered and was graded — under a prompt compiled by the
    // instruction-edit path, which is not the strategy the profile claims. The
    // compile now fails closed, and the cell records WHICH strategy stopped it so
    // an operator is not left comparing profile rows to guess.
    const reason = ineligibleReason(await refusedCell({ profileIds: [TEXT_REPAIR_PROFILE_ID] }));
    expect(reason).toContain("prompt strategy text_repair is not executable by the identity trial");
  });

  it("refuses an arm whose optional role the pack cannot supply, rather than duplicating a shorter one", async () => {
    // `identityRolePlan` marks `face_detail` optional, so production evaluates a
    // face-crop-less pack as ELIGIBLE for `canonical_then_face_detail` and sends
    // the canonical portrait alone — exactly what `canonical_only` sends. Right
    // for a render, fatal for a grid: the two arms would pair and the model's
    // own run-to-run drift would be reported as an effect of reference ordering.
    const subject = await seedTrialCharacter("No Face Crop Subject");
    const ensured = await ensureIdentityPack({
      ownerId,
      characterId: subject.characterId,
      purpose: "admin_trial",
    });
    expect(ensured.status).toBe("ready");
    // Drop the face crop the way the FK's `on delete set null` would, then pin
    // the revision — the pinned arm is strictly read-only, so nothing re-derives
    // it underneath the assertion.
    await db()
      .update(imageIdentityPacks)
      .set({ faceCropImageId: null })
      .where(eq(imageIdentityPacks.characterId, subject.characterId));

    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "degenerate arm run",
        characterIds: [subject.characterId],
        strategies: ["canonical_only", "canonical_then_face_detail"],
        packVariants: [{ source: "revision", characterId: subject.characterId, revision: 1 }],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The single-role arm is a real comparison and still plans; only the arm
    // that would have duplicated it refuses.
    expect(result.counts).toEqual({ planned: 1, running: 0, rendered: 0, failed: 0, refused: 1 });
    const rows = await cellRows(result.runId);
    const refused = rows.find((row) => row.status === "refused");
    expect(refused && storedResult(refused).failureCode).toBe("profile_ineligible");
    expect(refused && storedResult(refused).failureMessage).toContain("would duplicate canonical_only");
    const planned = rows.find((row) => row.status === "planned");
    expect((planned?.specJson as ImageIdentityPackTrialCellSpec | undefined)?.identityStrategy).toBe("canonical_only");
  });

  it("still plans every combination production would offer", async () => {
    // The over-refusal guard. A gate that refused everything would satisfy every
    // case above and quietly empty the grid, so the runnable fixtures — edit and
    // generate, three models, four profiles — are asserted to plan untouched.
    const sink = new DiagnosticCollector();
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "offered combinations",
        strategies: ["canonical_only"],
        profileIds: [TRIAL_PROFILE_ID, TIGHT_PROFILE_ID, CONTROLS_PROFILE_ID, GENERATE_PROFILE_ID],
      }),
      sink,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({ planned: 4, running: 0, rendered: 0, failed: 0, refused: 0 });
    expect(sink.items.map((entry) => entry.code)).not.toContain("images.identity_pack.trial.profile_ineligible");
  });
});

/**
 * The SECOND comparison axis: which pack a cell renders from. Before it, a run
 * could only ever compare strategies against whatever revision happened to be
 * current, so the two questions the pack system most needs answered — "is the
 * manual crop better than the automatic one?" and "is the pack helping at all?" —
 * had no expressible experiment at all.
 *
 * The invariant every case here defends is the same one: an arm renders the pack
 * it NAMED. A pinned revision that silently resolved against the current pack, or
 * a baseline that quietly sent references, would produce a grid whose grades
 * describe comparisons nobody ran.
 */
describe.skipIf(!ready)("the pack-variant axis", () => {
  /** Save a manual correction over a named revision, promoting a NEW current
   * revision and superseding the one named. The rectangle is deliberately unlike
   * the heuristic's full-width square, so two arms cannot accidentally send
   * byte-identical crops and pass for the wrong reason. */
  async function supersedeWithManualCrop(
    characterId: string,
    expected: { packId: string; revision: number; sourceHash: string },
  ): Promise<{ revision: number; method: string | null }> {
    const manual = await saveManualIdentityCrop({
      ownerId,
      characterId,
      expectedPackId: expected.packId,
      expectedRevision: expected.revision,
      expectedSourceHash: expected.sourceHash,
      crop: { space: "normalized", crop: { left: 0.1, top: 0.05, width: 0.8, height: 0.6 } },
      actorUserId: ownerId,
      reason: "int-test manual correction",
    });
    if (manual.status !== "ready") throw new Error(`[trial int] the manual crop was ${manual.status}`);
    return { revision: manual.pack.revision, method: manual.pack.derivation.method };
  }

  /** A character carrying BOTH pack revisions the axis exists to compare: the
   * automatic heuristic crop (now superseded) and the manual correction. */
  async function subjectWithTwoRevisions(name: string): Promise<string> {
    const subject = await seedTrialCharacter(name);
    const automatic = await ensureIdentityPack({
      ownerId,
      characterId: subject.characterId,
      purpose: "admin_trial",
    });
    if (automatic.status !== "ready") throw new Error(`[trial int] the automatic pack was ${automatic.status}`);
    expect(automatic.pack.revision).toBe(1);
    expect(automatic.pack.derivation.method).toBe("heuristic");
    const manual = await supersedeWithManualCrop(subject.characterId, {
      packId: automatic.pack.id,
      revision: automatic.pack.revision,
      sourceHash: automatic.pack.source.contentHash,
    });
    expect(manual).toEqual({ revision: 2, method: "manual" });
    return subject.characterId;
  }

  it("plans and renders two pinned revisions of one character as one comparison", async () => {
    const characterId = await subjectWithTwoRevisions("Two Revision Subject");
    const runId = await createdRunId({
      label: "two revision run",
      characterIds: [characterId],
      strategies: ["canonical_then_face_detail"],
      packVariants: [
        { source: "revision", characterId, revision: 1 },
        { source: "revision", characterId, revision: 2 },
      ],
    });

    const planned = await cellRows(runId);
    expect(planned.map((cell) => cell.status)).toEqual(["planned", "planned"]);
    const specs = planned.map((cell) => cell.specJson as ImageIdentityPackTrialCellSpec);
    const pinnedFirst = specs.find((spec) => spec.packVariantKey === `rev:${characterId}:1`);
    const pinnedSecond = specs.find((spec) => spec.packVariantKey === `rev:${characterId}:2`);
    // Each arm pinned ITS OWN revision's derivation — not the current one twice,
    // which is what a fallback to `ensureIdentityPack` would have produced.
    expect(pinnedFirst).toMatchObject({ packRevision: 1, cropMethod: "heuristic" });
    expect(pinnedSecond).toMatchObject({ packRevision: 2, cropMethod: "manual" });
    expect(pinnedFirst?.packId).not.toBe(pinnedSecond?.packId);
    expect(pinnedFirst?.crop).not.toEqual(pinnedSecond?.crop);
    // The superseded revision is still gradable: a retired-but-derived pack is
    // exactly the "old" side of an old-vs-new comparison.
    expect(pinnedFirst?.orderedReferenceRoles).toEqual(["canonical_identity", "face_detail"]);
    expect(pinnedSecond?.orderedReferenceRoles).toEqual(["canonical_identity", "face_detail"]);

    const { renderer, inputs } = capturingRenderer();
    setTrialRendererForTesting(renderer);
    const executed = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge });
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;
    // Both rendered. A pinned arm that had drifted onto the current pack would
    // have failed its execute-time identity re-check as `cell_conflict`.
    expect(executed.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered"]);
    const keys = executed.executed.map((cell) => cell.cellKey);
    const firstRefs = inputs[keys.findIndex((key) => key.endsWith(`rev:${characterId}:1`))]?.references ?? [];
    const secondRefs = inputs[keys.findIndex((key) => key.endsWith(`rev:${characterId}:2`))]?.references ?? [];
    expect(firstRefs).toHaveLength(2);
    expect(secondRefs).toHaveLength(2);
    // The canonical portrait is shared by both revisions, so those bytes match.
    // The FACE CROP is the thing the two revisions disagree about, and the
    // provider demonstrably saw the difference — which is the entire experiment.
    expect(bufferDigest(firstRefs[0])).toBe(bufferDigest(secondRefs[0]));
    expect(bufferDigest(firstRefs[1])).not.toBe(bufferDigest(secondRefs[1]));

    // Same strategy, different variant: one interpretable pair, and gradable.
    const pair = (await nextUnreviewedTrialPair(runId, ownerId))?.pair;
    expect(pair).not.toBeNull();
    if (!pair) return;
    const graded = await submitTrialPairGrade({
      runId,
      ownerId,
      request: {
        pairId: pair.pairId,
        grades: gradesFavoringLeft(),
        catastrophicLeft: [],
        catastrophicRight: [],
        notes: null,
      },
    });
    expect(graded?.ok).toBe(true);
    const summary = await identityPackTrialSummary(runId, ownerId);
    expect(summary?.comparisons).toHaveLength(1);
    expect(summary?.comparisons[0]).toMatchObject({
      strategyA: "canonical_then_face_detail",
      strategyB: "canonical_then_face_detail",
      variantKeyA: `rev:${characterId}:1`,
      variantKeyB: `rev:${characterId}:2`,
      gradedPairs: 1,
    });
  });

  it("plans a no-pack baseline beside a pack arm and renders it with zero references", async () => {
    const runId = await createdRunId({
      label: "baseline run",
      profileIds: [GENERATE_PROFILE_ID],
      strategies: ["canonical_only"],
      packVariants: [{ source: "current" }, { source: "none" }],
    });

    const rows = await cellRows(runId);
    expect(rows.map((cell) => cell.status)).toEqual(["planned", "planned"]);
    const specs = rows.map((cell) => cell.specJson as ImageIdentityPackTrialCellSpec);
    const baseline = specs.find((spec) => spec.packVariantKey === "none");
    const packArm = specs.find((spec) => spec.packVariantKey === "current");
    expect(baseline).toMatchObject({
      identityStrategy: null,
      referenceSource: "none",
      orderedReferenceRoles: [],
      packId: null,
      packRevision: null,
      sourceImageId: null,
      sourceContentHash: null,
      cropMethod: null,
      crop: null,
      derivationVersion: null,
      policyVersion: null,
      effectiveReferenceSize: { widthPx: null, heightPx: null, faceWidthPx: null, faceHeightPx: null },
    });
    expect(packArm).toMatchObject({ identityStrategy: "canonical_only", referenceSource: "pack" });

    const { renderer, inputs } = capturingRenderer();
    setTrialRendererForTesting(renderer);
    const executed = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge });
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;
    expect(executed.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered"]);
    const baselineInput = inputs[executed.executed.findIndex((cell) => cell.cellKey.endsWith(":none:none"))];
    expect(baselineInput?.references).toEqual([]);
    // And nothing the harness added: with no roles there is no preamble, so the
    // control arm differs from the pack arm by references alone.
    expect(baselineInput?.prompt).toBe(WARDROBE_FIXTURE_PROMPT);

    // The baseline is evidence, not a verdict slot: it pairs against the pack
    // arm, and the verdict list names only the (profile, strategy) combos.
    expect((await nextUnreviewedTrialPair(runId, ownerId))?.pair).not.toBeNull();
    const summary = await identityPackTrialSummary(runId, ownerId);
    expect(summary?.renderedCombos).toEqual([
      {
        profileId: GENERATE_PROFILE_ID,
        identityStrategy: "canonical_only",
        renderedCells: 1,
        totalPairs: 1,
        gradedPairs: 0,
      },
    ]);
    expect(summary?.comparisons[0]).toMatchObject({
      strategyA: "canonical_only",
      variantKeyA: "current",
      strategyB: null,
      variantKeyB: "none",
    });
  });

  it("refuses a no-pack baseline on an edit profile", async () => {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "baseline on an edit profile",
        strategies: ["canonical_only"],
        packVariants: [{ source: "none" }],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual({ planned: 0, running: 0, rendered: 0, failed: 0, refused: 1 });
    const [cell] = await cellRows(result.runId);
    if (!cell) throw new Error("[trial int] the baseline run recorded no cell");
    const refusal = storedResult(cell);
    expect(refusal.failureCode).toBe("profile_ineligible");
    // The message names the requirement, not just the failure: an edit lane's
    // zero-reference behavior is not something this harness can reproduce.
    expect(refusal.failureMessage).toContain("generate");
  });

  it("refuses the WHOLE run when a revision selector names a character it does not include", async () => {
    const before = (await listIdentityPackTrialRuns(ownerId)).length;
    const sink = new DiagnosticCollector();
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "foreign revision selector",
        strategies: ["canonical_only"],
        packVariants: [{ source: "revision", characterId: bareCharacterId, revision: 1 }],
      }),
      sink,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A configuration error, not an outcome: the planner would have produced no
    // cell for that selector at all, and a run whose arm silently vanished is a
    // reviewer believing a comparison ran that never existed.
    expect(result.refusal.code).toBe("pack_revision_unavailable");
    expect((await listIdentityPackTrialRuns(ownerId)).length).toBe(before);
    expect(sink.items.map((entry) => entry.code)).toContain(
      "images.identity_pack.trial.pack_revision_unavailable",
    );
  });

  it("refuses only the cell whose pinned revision does not exist", async () => {
    const result = await createIdentityPackTrialRun({
      ownerId,
      request: trialRequest({
        label: "missing revision run",
        strategies: ["canonical_only"],
        packVariants: [{ source: "current" }, { source: "revision", characterId: subjectId, revision: 99 }],
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The rest of the grid is untouched: one unbuildable arm is a recorded
    // refusal, never a reason to lose the comparison beside it.
    expect(result.counts).toEqual({ planned: 1, running: 0, rendered: 0, failed: 0, refused: 1 });
    const rows = await cellRows(result.runId);
    const missing = rows.find((cell) => cell.cellKey.endsWith(`rev:${subjectId}:99`));
    expect(missing?.status).toBe("refused");
    expect(missing && storedResult(missing).failureCode).toBe("pack_revision_unavailable");
    expect(rows.find((cell) => cell.cellKey.endsWith(":current"))?.status).toBe("planned");
  });

  it("refuses a current-variant cell whose pinned revision was superseded before it ran", async () => {
    const subject = await seedTrialCharacter("Superseded Current Subject");
    const runId = await createdRunId({
      label: "superseded current run",
      characterIds: [subject.characterId],
      strategies: ["canonical_only"],
    });
    const pinned = await storedSpec(runId);
    expect(pinned.packRevision).toBe(1);

    // A manual correction after planning promotes revision 2. The `current` arm
    // pinned revision 1, and pinning is a promise about WHICH pack produced the
    // evidence — so the cell refuses rather than rendering the new one under the
    // old one's name.
    const manual = await supersedeWithManualCrop(subject.characterId, {
      packId: pinned.packId ?? "",
      revision: pinned.packRevision ?? 0,
      sourceHash: pinned.sourceContentHash ?? "",
    });
    expect(manual.revision).toBe(2);

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const executed = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(executed?.ok).toBe(true);
    if (!executed?.ok) return;
    expect(executed.executed.map((cell) => cell.status)).toEqual(["refused"]);
    expect(calls()).toBe(0);
    const [cell] = await cellRows(runId);
    expect(cell && storedResult(cell).failureCode).toBe("cell_conflict");
  });
});

describe.skipIf(!ready)("trial execution", () => {
  it("renders planned cells through the seam, records results, and hides the outputs", async () => {
    const runId = await createdRunId({ label: "execute run" });
    const { renderer } = countingRenderer();
    setTrialRendererForTesting(renderer);

    const { chargeBudget, charges } = recordingCharge();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // One charge, sized to the cells this pass actually attempted — not the 5 asked for.
    expect(charges).toEqual([2]);
    expect(result.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered"]);
    expect(result.remainingPlanned).toBe(0);
    // draft → running → review in one pass: nothing planned remains.
    expect(result.runStatus).toBe("review");
    expect((await runRow(runId))?.status).toBe("review");

    const cells = await cellRows(runId);
    for (const cell of cells) {
      expect(cell.status).toBe("rendered");
      expect(cell.outputImageId).not.toBeNull();
      expect(cell.resultJson).toMatchObject({ failureCode: null, postCrop: null });
      const parsed = cell.resultJson as { latencyMs: unknown; outputImageId: unknown; finalWidthPx: unknown };
      expect(typeof parsed.latencyMs).toBe("number");
      expect(parsed.outputImageId).toBe(cell.outputImageId);
      expect(parsed.finalWidthPx).toBe(96);
    }

    const outputs = await outputImageRows(runId);
    expect(outputs).toHaveLength(2);
    for (const output of outputs) {
      expect(output.kind).toBe("identity_trial_output");
      expect(output.status).toBe("ready");
      expect(output.entityKind).toBe("character");
      expect(output.entityId).toBe(subjectId);
      await expect(fs.access(absoluteImagePath(output))).resolves.toBeUndefined();
    }
    // Hidden from the Gallery by construction: the positive-kind query that
    // backs the Gallery tabs cannot see an identity_trial_output.
    const gallery = await db()
      .select({ id: images.id })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), inArray(images.kind, [...GALLERY_IMAGE_KINDS])));
    const galleryIds = new Set(gallery.map((row) => row.id));
    for (const output of outputs) expect(galleryIds.has(output.id)).toBe(false);
  });

  it("walks the grid in bounded passes, charging per pass for the cells picked and never for an empty pass", async () => {
    const runId = await createdRunId({ label: "bounded run" });
    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const { chargeBudget, charges } = recordingCharge();

    const first = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 1, chargeBudget });
    expect(first?.ok).toBe(true);
    if (!first?.ok) return;
    expect(first.executed).toHaveLength(1);
    expect(first.remainingPlanned).toBe(1);
    expect(first.runStatus).toBe("running");
    expect(charges).toEqual([1]);

    const second = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget });
    expect(second?.ok).toBe(true);
    if (!second?.ok) return;
    expect(second.executed).toHaveLength(1);
    expect(second.runStatus).toBe("review");
    // Charged for the ONE cell still planned, not the five the click asked for.
    expect(charges).toEqual([1, 1]);

    // Nothing planned remains, so a third pass attempts nothing, charges
    // nothing, and the renderer is not consulted again — rendered cells are
    // settled evidence, and re-reading a finished grid must stay free.
    const third = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget });
    expect(third?.ok).toBe(true);
    if (!third?.ok) return;
    expect(third.executed).toEqual([]);
    expect(charges).toEqual([1, 1]);
    expect(calls()).toBe(2);
  });

  it("returns the budget rejection uninterpreted, spending nothing and leaving every cell planned", async () => {
    const runId = await createdRunId({ label: "budget-refused run" });
    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);

    const rejection = { status: 429 };
    const sink = new DiagnosticCollector();
    const refused = await executeIdentityPackTrialCells({
      runId,
      ownerId,
      maxRenders: 5,
      chargeBudget: () => Promise.resolve(rejection),
      sink,
    });
    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) return;
    expect("budgetRejected" in refused ? refused.budgetRejected : null).toBe(rejection);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.trial.budget_refused");
    // No render happened and no cell settled: the refused pass is free to retry.
    expect(calls()).toBe(0);
    expect((await cellRows(runId)).map((cell) => cell.status)).toEqual(["planned", "planned"]);
  });

  it("classifies a failing render, leaves the cell failed, and never retries it", async () => {
    const runId = await createdRunId({ label: "failing run", strategies: ["canonical_only"] });
    const { calls, renderer } = countingRenderer();
    setTrialRendererForTesting(async (input, sink) => {
      await renderer(input, sink); // count the consultation, then fail
      return { ok: false, error: "content policy violation: flagged output" };
    });

    const sink = new DiagnosticCollector();
    const { chargeBudget, charges } = recordingCharge();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget, sink });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["failed"]);
    expect(result.runStatus).toBe("review");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.trial.provider_failed");
    // The failed cell keeps its charged slot: the pass was admitted at this
    // size, and a refund path would turn every provider failure into free retries.
    expect(charges).toEqual([1]);

    const [cell] = await cellRows(runId);
    expect(cell?.status).toBe("failed");
    expect(cell?.resultJson).toMatchObject({
      failureCode: "content_rejection",
      failureMessage: "content policy violation: flagged output",
      outputImageId: null,
    });

    const again = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget });
    expect(again?.ok).toBe(true);
    if (!again?.ok) return;
    expect(again.executed).toEqual([]);
    expect(charges).toEqual([1]);
    expect(calls()).toBe(1);
  });

  it("refuses a second concurrent pass with run_locked", async () => {
    const runId = await createdRunId({ label: "locked run", strategies: ["canonical_only"] });
    const gate = gatedRenderer();
    setTrialRendererForTesting(gate.renderer);

    const first = executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    for (let attempt = 0; attempt < 200 && !gate.entered(); attempt += 1) await sleep(10);
    expect(gate.entered()).toBe(true);

    // The locked-out pass must not charge: the charge happens INSIDE the lock,
    // after run_locked can no longer refuse the pass.
    const { chargeBudget, charges } = recordingCharge();
    const second = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget });
    expect(second?.ok).toBe(false);
    if (!second || second.ok) return;
    expect("refusal" in second ? second.refusal.code : null).toBe("run_locked");
    expect(charges).toEqual([]);

    gate.release();
    const settled = await first;
    expect(settled?.ok).toBe(true);
    if (!settled?.ok) return;
    expect(settled.executed.map((cell) => cell.status)).toEqual(["rendered"]);
  });

  it("refuses a cell whose pack moved since planning with cell_conflict", async () => {
    const subject = await seedTrialCharacter("Conflict Subject");
    const runId = await createdRunId({
      label: "conflict run",
      characterIds: [subject.characterId],
      strategies: ["canonical_only"],
    });

    // Repoint the canonical portrait AFTER planning: the execute-time re-ensure
    // derives a fresh revision for the new bytes, which no longer matches the
    // cell's pinned pack id / revision / source hash.
    const replacement = await createImageAsset({
      ownerId,
      kind: "avatar",
      entityKind: "character",
      entityId: subject.characterId,
      prompt: "replacement portrait",
    });
    const saved = await saveImageBuffer(replacement.id, await testPngBuffer(400, 512));
    expect(saved?.status).toBe("ready");
    await db()
      .update(characters)
      .set({ avatarImageId: replacement.id })
      .where(eq(characters.id, subject.characterId));

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["refused"]);
    expect(calls()).toBe(0);

    const [cell] = await cellRows(runId);
    expect(cell?.status).toBe("refused");
    expect(cell?.resultJson).toMatchObject({ failureCode: "cell_conflict" });
  });

  it("refuses a cell whose resolved model/profile controls changed since planning", async () => {
    const runId = await createdRunId({ label: "controls drift run", strategies: ["canonical_only"] });
    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);

    // Change a hashed control field after planning: the execute-time re-check
    // recomputes the controls hash from the rows in force and must refuse.
    await db().update(imageModelProfiles).set({ timeoutMs: 120_000 }).where(eq(imageModelProfiles.id, TRIAL_PROFILE_ID));
    try {
      const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
      expect(result?.ok).toBe(true);
      if (!result?.ok) return;
      expect(result.executed.map((cell) => cell.status)).toEqual(["refused"]);
      expect(calls()).toBe(0);
      const [cell] = await cellRows(runId);
      expect(cell?.resultJson).toMatchObject({ failureCode: "cell_conflict" });
    } finally {
      await db().update(imageModelProfiles).set({ timeoutMs: null }).where(eq(imageModelProfiles.id, TRIAL_PROFILE_ID));
    }
  });

  it("fails a cell whose references were trimmed in transport, keeping the output for audit", async () => {
    const runId = await createdRunId({ label: "trimmed run", strategies: ["canonical_only"] });
    // The seam replaces the real renderer, so the trim is reproduced the way
    // the render path reports it: the warn diagnostic pushed into the sink the
    // renderer receives (`image_model.references_trimmed`, replicate.ts).
    setTrialRendererForTesting(async (input, sink) => {
      sink?.push(
        diag("warn", "image_model.references_trimmed", "dropped references that did not fit the inline byte budget", {
          path: "image_models",
          context: { slug: input.model.slug, sent: 0, requested: input.references.length },
        }),
      );
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["failed"]);

    const [cell] = await cellRows(runId);
    expect(cell?.status).toBe("failed");
    expect(cell?.resultJson).toMatchObject({ failureCode: "references_trimmed" });
    // The output exists and stays auditable — but a failed cell never pairs,
    // so the trimmed render cannot leak into the blinded comparison grid.
    expect(cell?.outputImageId).not.toBeNull();
    expect((await nextUnreviewedTrialPair(runId, ownerId))?.pair).toBeNull();
  });

  it("fails a cell whose controls were narrowed in transport, keeping the output for audit", async () => {
    // `compileProfileRenderPlan` filters reserved fields out before they enter
    // the payload, so this diagnostic reaching the sink means the compile step
    // and the transport disagree about what is reserved. A cell whose controls
    // were silently narrowed on the way out is not the configuration its hash
    // records, so it must not join the grid.
    const runId = await createdRunId({ label: "narrowed controls run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(async (input, sink) => {
      sink?.push(
        diag("warn", "image_model.reserved_field_ignored", "control input tried to write a render-path field", {
          path: "image_models",
          context: { slug: input.model.slug, fields: ["size"] },
        }),
      );
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["failed"]);

    const [cell] = await cellRows(runId);
    expect(cell?.resultJson).toMatchObject({ failureCode: "controls_trimmed" });
    // Auditable but unpairable — the same shape the trimmed-references case takes.
    expect(cell?.outputImageId).not.toBeNull();
    expect((await nextUnreviewedTrialPair(runId, ownerId))?.pair).toBeNull();
  });

  it("records the version the provider says it ran, and fails the cell when it is not the pinned one", async () => {
    // A pin states intent; the echo states outcome. Recording only the pin would
    // let a provider-side re-point pass the execute-time re-check untouched —
    // the cell would claim evidence for a version that never ran.
    const runId = await createdRunId({ label: "version echo run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(async () => ({
      ok: true,
      image: await testPngBuffer(96, 128),
      predictionId: "pred-echo",
      executedVersionId: TRIAL_MODEL_VERSION,
    }));
    const matched = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(matched?.ok).toBe(true);
    if (!matched?.ok) return;
    expect(matched.executed.map((cell) => cell.status)).toEqual(["rendered"]);
    expect((await cellRows(runId))[0]?.resultJson).toMatchObject({
      providerVersionId: TRIAL_MODEL_VERSION,
      failureCode: null,
    });

    const mismatchedRunId = await createdRunId({ label: "version mismatch run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(async () => ({
      ok: true,
      image: await testPngBuffer(96, 128),
      executedVersionId: "trialversionsomethingels",
    }));
    const mismatched = await executeIdentityPackTrialCells({
      runId: mismatchedRunId,
      ownerId,
      chargeBudget: admitCharge,
    });
    expect(mismatched?.ok).toBe(true);
    if (!mismatched?.ok) return;
    expect(mismatched.executed.map((cell) => cell.status)).toEqual(["failed"]);
    const [mismatchedCell] = await cellRows(mismatchedRunId);
    expect(mismatchedCell?.resultJson).toMatchObject({
      failureCode: "version_mismatch",
      providerVersionId: "trialversionsomethingels",
    });
    // Kept for audit, and unpairable: the image was paid for and an operator
    // investigating a re-pinned model needs to see it.
    expect(mismatchedCell?.outputImageId).not.toBeNull();
    expect((await nextUnreviewedTrialPair(mismatchedRunId, ownerId))?.pair).toBeNull();
  });

  it("treats an UNDISCLOSED echo as non-disclosure, not a mismatch", async () => {
    // Owner ruling 2026-08-11: Replicate answers `"hidden"` for an OFFICIAL
    // model, which publishes no versions list at all — that string names no
    // version to disagree with. The cell's evidence identity is the pin, which
    // Replicate validated when it accepted the prediction (an unresolvable
    // version is refused 422 before any spend). Without this the whole trial
    // is unrunnable against official models: every cell would fail.
    const runId = await createdRunId({ label: "version undisclosed run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(async () => ({
      ok: true,
      image: await testPngBuffer(96, 128),
      predictionId: "pred-hidden",
      executedVersionId: REPLICATE_VERSION_UNDISCLOSED,
    }));
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["rendered"]);

    const [cell] = await cellRows(runId);
    expect(cell?.status).toBe("rendered");
    // Recorded verbatim — the row keeps what the provider actually said — and
    // the cell joins the grid like any other.
    expect(cell?.resultJson).toMatchObject({ providerVersionId: "hidden", failureCode: null });
    expect(cell?.outputImageId).not.toBeNull();
  });

  it("treats a SILENT provider as no evidence of a mismatch", async () => {
    // Most model-endpoint responses carry no `version` at all. Refusing on
    // silence would fail every cell against those, so absence is absence —
    // never a disagreement.
    const runId = await createdRunId({ label: "version silent run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(async () => ({ ok: true, image: await testPngBuffer(96, 128) }));
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["rendered"]);
    expect((await cellRows(runId))[0]?.resultJson).toMatchObject({ providerVersionId: null, failureCode: null });
  });

  it("contains a thrown render inside its cell and continues the batch", async () => {
    const runId = await createdRunId({ label: "throwing run" });
    let renders = 0;
    setTrialRendererForTesting(async () => {
      renders += 1;
      if (renders === 1) throw new Error("socket hang up");
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const sink = new DiagnosticCollector();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge, sink });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // The throw cost its own cell, not the batch: the second cell still ran.
    expect(result.executed.map((cell) => cell.status)).toEqual(["failed", "rendered"]);
    expect(result.remainingPlanned).toBe(0);
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.trial.cell_degraded");

    const cells = await cellRows(runId);
    expect(cells.map((cell) => cell.status)).toEqual(["failed", "rendered"]);
    expect(cells[0]?.resultJson).toMatchObject({ failureCode: "other", failureMessage: "socket hang up" });
    // Nothing was stored before this throw, so the settle carries no output —
    // the null arm of the stored-output holder.
    expect(cells[0]?.outputImageId).toBeNull();
    // Settled means settled: a fresh pass finds nothing planned to re-render.
    const again = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(again?.ok).toBe(true);
    if (!again?.ok) return;
    expect(again.executed).toEqual([]);
  });

  it("sends the profile's compiled controls to the provider seam and records exactly what it sent", async () => {
    const runId = await createdRunId({
      label: "profile controls run",
      profileIds: [CONTROLS_PROFILE_ID],
      strategies: ["canonical_only"],
    });
    const { renderer, inputs } = capturingRenderer();
    setTrialRendererForTesting(renderer);

    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["rendered"]);

    // The controls reached the request under the PROVIDER's field names, mapped
    // through the version's probed bindings — never a guessed key.
    const captured = inputs[0];
    expect(captured?.controlInput).toEqual({
      negative_prompt: "blurry, watermark",
      guidance_scale: 6,
      scheduler: "KarrasDPM",
    });
    expect(captured?.timeoutMs).toBe(90_000);
    expect(captured?.versionId).toBe(CONTROLS_MODEL_VERSION);

    // And the cell's own record matches, field for field. A hash over controls
    // the render never sent would be provenance for a render nobody made.
    const spec = await storedSpec(runId);
    expect(spec.resolvedControls?.controlInput).toEqual(captured?.controlInput);
    expect(spec.resolvedControls?.timeoutMs).toBe(90_000);
    expect(spec.resolvedControls?.operation).toBe("edit");
    // `steps` has no binding on this version, so it is DROPPED with a reason —
    // not quietly omitted, and not guessed onto a plausible field name.
    expect(spec.resolvedControls?.droppedControls).toEqual([{ control: "steps", reason: "no_binding" }]);
    expect(Object.keys(captured?.controlInput ?? {})).not.toContain("num_inference_steps");
    expect(spec.negativePromptHash).toBe(sha256("blurry, watermark"));
  });

  it("pins the provider version on the request and refuses when it moves between plan and execute", async () => {
    const runId = await createdRunId({ label: "version pin run", strategies: ["canonical_only"] });
    const { renderer, inputs } = capturingRenderer();
    setTrialRendererForTesting(renderer);
    const first = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(first?.ok).toBe(true);
    // A bare slug would otherwise run whatever `latest_version` is that hour.
    expect(inputs[0]?.versionId).toBe(TRIAL_MODEL_VERSION);
    expect((await storedSpec(runId)).modelVersion).toBe(TRIAL_MODEL_VERSION);

    const movedRunId = await createdRunId({ label: "version moved run", strategies: ["canonical_only"] });
    const { renderer: counting, calls } = countingRenderer();
    setTrialRendererForTesting(counting);
    await db()
      .update(imageModels)
      .set({ probedVersionId: "trialversionmovedaaaaaaa" })
      .where(eq(imageModels.id, TRIAL_MODEL_ID));
    try {
      const moved = await executeIdentityPackTrialCells({ runId: movedRunId, ownerId, chargeBudget: admitCharge });
      expect(moved?.ok).toBe(true);
      if (!moved?.ok) return;
      expect(moved.executed.map((cell) => cell.status)).toEqual(["refused"]);
      expect(calls()).toBe(0);
      expect((await cellRows(movedRunId))[0]?.resultJson).toMatchObject({ failureCode: "cell_conflict" });
    } finally {
      await db()
        .update(imageModels)
        .set({ probedVersionId: TRIAL_MODEL_VERSION })
        .where(eq(imageModels.id, TRIAL_MODEL_ID));
    }
  });

  it("compiles numbered role bindings into a multi-reference prompt and hashes what it sends", async () => {
    const runId = await createdRunId({ label: "multi reference run", strategies: ["canonical_then_face_detail"] });
    const { renderer, inputs } = capturingRenderer();
    setTrialRendererForTesting(renderer);
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);

    // Two unlabelled references make the two ordering strategies a coin flip
    // wearing two names; the preamble is what makes the order mean something.
    const prompt = inputs[0]?.prompt ?? "";
    expect(prompt.startsWith("Image 1: the canonical identity reference for the subject.")).toBe(true);
    expect(prompt).toContain("Image 2: a close facial-detail reference for the same subject.");
    expect(inputs[0]?.references).toHaveLength(2);
    // The hash covers the COMPILED text, not the raw fixture.
    const spec = await storedSpec(runId);
    expect(spec.positivePromptHash).toBe(sha256(prompt));
    expect(spec.positivePromptHash).not.toBe(sha256(WARDROBE_FIXTURE_PROMPT));

    const singleRunId = await createdRunId({ label: "single reference run", strategies: ["canonical_only"] });
    const single = capturingRenderer();
    setTrialRendererForTesting(single.renderer);
    await executeIdentityPackTrialCells({ runId: singleRunId, ownerId, chargeBudget: admitCharge });
    // One reference has nothing to disambiguate, so the prompt stays exactly as
    // the fixture wrote it — prefixing every lane would change working renders.
    expect(single.inputs[0]?.prompt).toBe(WARDROBE_FIXTURE_PROMPT);
    expect((await storedSpec(singleRunId)).positivePromptHash).toBe(sha256(WARDROBE_FIXTURE_PROMPT));
  });

  it("executes a comparison group's arms consecutively", async () => {
    // Nothing seeds the provider, so two renders of one subject drift with
    // whatever the model was doing between them. Running a group's arms back to
    // back is the only lever the harness has to keep that drift shared rather
    // than becoming the difference the grid measures.
    const second = await seedTrialCharacter("Adjacency Subject");
    const runId = await createdRunId({
      label: "adjacency run",
      characterIds: [subjectId, second.characterId],
      strategies: ["canonical_only", "face_detail_only"],
    });
    setTrialRendererForTesting(countingRenderer().renderer);

    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 4, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    const characters = [subjectId, second.characterId].sort();
    expect(result.executed.map((cell) => cell.cellKey)).toEqual(
      characters.flatMap((characterId) =>
        ["canonical_only", "face_detail_only"].map(
          (strategy) => `${characterId}:${TRIAL_PROFILE_ID}:${WARDROBE_FIXTURE}:${strategy}:current`,
        ),
      ),
    );
  });

  it("records the provider's prediction id on a rendered cell and on a failed one", async () => {
    const runId = await createdRunId({ label: "prediction id run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(capturingRenderer("pred-trial-rendered").renderer);
    const rendered = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(rendered?.ok).toBe(true);
    expect((await cellRows(runId))[0]?.resultJson).toMatchObject({
      providerPredictionId: "pred-trial-rendered",
      failureCode: null,
    });

    // The failure path matters more, not less: a prediction that failed is the
    // one an operator actually needs to look up at the provider.
    const failedRunId = await createdRunId({ label: "prediction id failure run", strategies: ["canonical_only"] });
    setTrialRendererForTesting(() =>
      Promise.resolve({ ok: false, error: "provider exploded", predictionId: "pred-trial-failed" }),
    );
    const failed = await executeIdentityPackTrialCells({ runId: failedRunId, ownerId, chargeBudget: admitCharge });
    expect(failed?.ok).toBe(true);
    expect((await cellRows(failedRunId))[0]?.resultJson).toMatchObject({
      providerPredictionId: "pred-trial-failed",
      failureMessage: "provider exploded",
      // Never fabricated: the adapter exposes neither of these.
      moderationOutcome: null,
      postCrop: null,
    });
  });
});

/**
 * The durable claim, exercised where it actually has to hold: BELOW the
 * in-process lock. `runTrialExecutionPassForTesting` is the post-lock pass, so
 * these cases reproduce two machines meeting over one run — which is what the
 * `running` status, the claim token and the claim clock exist for. Driving them
 * through `executeIdentityPackTrialCells` would let the keyed lock serialize the
 * very contention under test, and a concurrency guarantee nothing can exercise
 * is a guarantee nobody notices is broken.
 */
describe.skipIf(!ready)("durable execution claims", () => {
  it("lets exactly one of two concurrent passes claim, render, and charge a cell", async () => {
    const runId = await createdRunId({ label: "contender run", strategies: ["canonical_only"] });
    const gate = gatedRenderer();
    setTrialRendererForTesting(gate.renderer);
    const first = recordingCharge();
    const second = recordingCharge();

    const passes = Promise.all([
      runTrialExecutionPassForTesting({ runId, ownerId, chargeBudget: first.chargeBudget }),
      runTrialExecutionPassForTesting({ runId, ownerId, chargeBudget: second.chargeBudget }),
    ]);
    // Hold the winner inside the provider call so the loser is unambiguously
    // in flight at the same time.
    for (let attempt = 0; attempt < 300 && !gate.entered(); attempt += 1) await sleep(10);
    expect(gate.entered()).toBe(true);
    gate.release();
    const [passA, passB] = await passes;

    expect(passA?.ok).toBe(true);
    expect(passB?.ok).toBe(true);
    if (!passA?.ok || !passB?.ok) return;

    // One pass rendered the cell; the other found it already claimed and did
    // nothing at all — including charging for it.
    const executedStatuses = [...passA.executed, ...passB.executed].map((cell) => cell.status);
    expect(executedStatuses).toEqual(["rendered"]);
    expect([...first.charges, ...second.charges]).toEqual([1]);
    expect(gate.calls()).toBe(1);
    expect(await outputImageRows(runId)).toHaveLength(1);
    // Nothing left holding a claim: a `running` straggler would block the run's
    // review gate until the stale window elapsed.
    expect((await cellRows(runId)).map((cell) => cell.status)).toEqual(["rendered"]);
  });

  it("recovers a claim a dead pass left behind, and leaves a live one alone", async () => {
    const runId = await createdRunId({ label: "stale claim run", strategies: ["canonical_only"] });
    const [stale] = await cellRows(runId);
    // Dated past the window rather than at a hand-picked "long ago": the window
    // is DERIVED from the render budget and the per-call deadlines, so a literal
    // here would silently stop being stale the next time one of them moved.
    await db()
      .update(imageIdentityPackTrialCells)
      .set({
        status: "running",
        claimToken: "dead-worker",
        claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000),
      })
      .where(eq(imageIdentityPackTrialCells.id, stale?.id ?? ""));

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const sink = new DiagnosticCollector();
    const recovered = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge, sink });
    expect(recovered?.ok).toBe(true);
    if (!recovered?.ok) return;
    expect(recovered.executed.map((cell) => cell.status)).toEqual(["rendered"]);
    expect(calls()).toBe(1);
    // Loud, because recovery can pay a second time for a render whose result
    // died with the worker that started it.
    expect(sink.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.claim_recovered");

    // A claim inside the window is NOT taken back: `running` records "this
    // render may already have been paid for", and resetting it on sight is the
    // double-spend the column exists to prevent. The queue-wide heartbeat is what
    // makes "inside the window" mean "the pass holding this cell spoke within the
    // last cell span" rather than "this cell has not waited long behind nineteen
    // others" — a live pass's whole queue stays fresh, not just its head.
    const liveRunId = await createdRunId({ label: "live claim run", strategies: ["canonical_only"] });
    const [live] = await cellRows(liveRunId);
    await db()
      .update(imageIdentityPackTrialCells)
      .set({ status: "running", claimToken: "live-worker", claimedAt: new Date() })
      .where(eq(imageIdentityPackTrialCells.id, live?.id ?? ""));
    const untouched = await executeIdentityPackTrialCells({ runId: liveRunId, ownerId, chargeBudget: admitCharge });
    expect(untouched?.ok).toBe(true);
    if (!untouched?.ok) return;
    expect(untouched.executed).toEqual([]);
    expect(calls()).toBe(1);
    expect((await cellRows(liveRunId))[0]?.status).toBe("running");
  });

  it("discards the output of a settle that lost its claim, leaving no orphan behind", async () => {
    const subject = await seedTrialCharacter("Zombie Subject");
    const runId = await createdRunId({
      label: "zombie settle run",
      characterIds: [subject.characterId],
      strategies: ["canonical_only"],
    });
    setTrialRendererForTesting(async () => {
      // A second machine takes the claim while this render is in flight — so the
      // settle that follows will find nothing to update.
      await db()
        .update(imageIdentityPackTrialCells)
        .set({ claimToken: "stolen-by-another-pass" })
        .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "running")));
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const sink = new DiagnosticCollector();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge, sink });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.executed.map((cell) => cell.status)).toEqual(["skipped"]);
    expect(sink.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.output_orphaned");

    // The image was written and then discarded: nothing references those bytes,
    // and the run's delete sweep walks cell pointers, so a survivor here would
    // be a hidden row nothing could ever find again.
    const outputs = await db()
      .select({ id: images.id })
      .from(images)
      .where(
        and(
          eq(images.ownerId, ownerId),
          eq(images.kind, "identity_trial_output"),
          eq(images.entityId, subject.characterId),
        ),
      );
    expect(outputs).toEqual([]);
    // The cell still belongs to the thief; this pass settled nothing.
    expect((await cellRows(runId))[0]?.status).toBe("running");
  });

  it("spends NOTHING on a cell whose claim was taken over between the batch claim and its turn", async () => {
    // The heartbeat's cheap half. A 20-cell pass claims everything up front, so
    // the last cell's claim can be stolen while the first nineteen render. The
    // boundary heartbeat discovers that BEFORE the stolen cell's own render, so
    // the theft costs zero provider calls instead of one paid render whose settle
    // then loses and has to delete the image it just bought.
    const runId = await createdRunId({ label: "stolen mid-batch run" });
    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(async (input, sink) => {
      // While the FIRST cell renders, a second machine takes over everything
      // this pass still holds — which is the second cell.
      await db()
        .update(imageIdentityPackTrialCells)
        .set({ claimToken: "taken-by-another-pass" })
        .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "running")));
      return renderer(input, sink);
    });

    const sink = new DiagnosticCollector();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge, sink });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    // The first cell's own settle also loses (its token was rewritten too), so
    // both report `skipped` — but only ONE of them ever reached a provider.
    expect(result.executed.map((cell) => cell.status)).toEqual(["skipped", "skipped"]);
    expect(calls()).toBe(1);
    // The second cell was stopped BEFORE the provider, not after — that
    // difference is the entire saving.
    expect(sink.items.map((entry) => entry.message)).toContain("the claim was taken over before the render started");
    // Both cells still belong to the thief; this pass settled nothing.
    expect((await cellRows(runId)).map((cell) => cell.status)).toEqual(["running", "running"]);
  });

  /** Three plannable arms of one comparison group — the smallest run with a real
   * QUEUE behind the head cell, which is the whole subject of the three cases
   * below. */
  const THREE_ARMS = ["canonical_only", "face_detail_only", "canonical_then_face_detail"] as const;

  it("leaves a LIVE pass's queued claims alone however long the cell ahead of them takes", async () => {
    // THE BUG THIS CLOSES: the pass claims and charges its whole batch up front,
    // but only the cell reaching its own render used to be re-stamped. Cell 10
    // therefore sat behind nine renders wearing the BATCH-START timestamp, could
    // age past STALE_CLAIM_MS on queue position alone, and be recovered and
    // re-charged by a second worker while the pass holding it was alive, well,
    // and about to render it.
    const runId = await createdRunId({ label: "live batch theft run", strategies: [...THREE_ARMS] });
    expect(await cellRows(runId)).toHaveLength(3);

    const gate = gatedRenderer();
    setTrialRendererForTesting(gate.renderer);
    const worker = recordingCharge();
    const passA = runTrialExecutionPassForTesting({ runId, ownerId, maxRenders: 5, chargeBudget: worker.chargeBudget });

    // Park worker A inside cell 1's provider call: cells 2 and 3 are claimed,
    // charged, and queued — the exact state a second worker must not touch.
    for (let attempt = 0; attempt < 300 && !gate.entered(); attempt += 1) await sleep(10);
    expect(gate.entered()).toBe(true);

    const contender = recordingCharge();
    const sink = new DiagnosticCollector();
    const passB = await runTrialExecutionPassForTesting({
      runId,
      ownerId,
      maxRenders: 5,
      chargeBudget: contender.chargeBudget,
      sink,
    });
    expect(passB?.ok).toBe(true);
    if (!passB?.ok) return;
    // Recovered nothing, claimed nothing, rendered nothing, charged nothing.
    expect(passB.executed).toEqual([]);
    expect(contender.charges).toEqual([]);
    expect(sink.items.map((entry) => entry.code)).not.toContain("images.identity_pack.trial.claim_recovered");
    expect(gate.calls()).toBe(1);

    gate.release();
    const finished = await passA;
    expect(finished?.ok).toBe(true);
    if (!finished?.ok) return;
    expect(finished.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered", "rendered"]);
    // One render and one output per cell, charged once for the batch A claimed.
    expect(gate.calls()).toBe(3);
    expect(worker.charges).toEqual([3]);
    expect(await outputImageRows(runId)).toHaveLength(3);
    expect((await cellRows(runId)).map((cell) => cell.status)).toEqual(["rendered", "rendered", "rendered"]);
    // Explicit budget: three renders plus a contending pass and a gate poll is
    // more than the 5s default allows for, and a timeout here would read as a
    // concurrency bug rather than a slow box.
  }, 20_000);

  it("re-stamps the WHOLE remaining queue at every cell boundary", async () => {
    const runId = await createdRunId({ label: "queue heartbeat run", strategies: [...THREE_ARMS] });
    // Snapshot every cell's claim stamp from INSIDE each render, so snapshot N is
    // the state during cell N's provider call — that is, immediately after the
    // boundary heartbeat that admitted it.
    const snapshots: Map<string, number | null>[] = [];
    setTrialRendererForTesting(async () => {
      snapshots.push(await claimStamps(runId));
      // Millisecond separation on purpose: two heartbeats inside one clock tick
      // would stamp equal timestamps and make an advance that DID happen
      // indistinguishable from one that did not.
      await sleep(5);
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge });
    expect(result?.ok).toBe(true);
    expect(snapshots).toHaveLength(3);
    const [duringFirst, duringSecond] = snapshots;
    if (!duringFirst || !duringSecond) return;

    // The two cells still QUEUED while cell 1 rendered changed in no way between
    // the two observations except that a cell boundary passed — and their claims
    // are fresher for it. Counted as a SET rather than read positionally: the
    // point is that the boundary re-stamped the WHOLE remaining queue, and the
    // one cell that kept its old stamp is the settled head, whose claim columns
    // stay frozen on the terminal row as the audit trail.
    const advanced = [...duringSecond.entries()].filter(([id, after]) => {
      const before = duringFirst.get(id);
      return typeof before === "number" && typeof after === "number" && after > before;
    });
    expect(advanced).toHaveLength(2);
    // Nothing went backwards either — a stamp that regressed would mean a claim
    // aging while its pass ran, which is the whole failure being fixed.
    for (const [id, before] of duringFirst) {
      const after = duringSecond.get(id);
      if (typeof before !== "number" || typeof after !== "number") continue;
      expect(after).toBeGreaterThanOrEqual(before);
    }
  }, 20_000);

  it("skips its remaining queue WITHOUT rendering when a recovery takes the claims", async () => {
    // The takeover arm of the same mechanism. Ageing a live pass's claims past
    // the window is pathological — the heartbeat exists so it cannot happen —
    // but recovery must still be survivable, and what makes it survivable is that
    // the robbed pass discovers the loss at a BOUNDARY rather than at a settle:
    // its tail costs zero provider calls instead of a paid render per cell.
    const subject = await seedTrialCharacter("Lost Queue Subject");
    const runId = await createdRunId({
      label: "lost queue run",
      characterIds: [subject.characterId],
      strategies: [...THREE_ARMS],
    });

    const gate = gatedRenderer();
    setTrialRendererForTesting(gate.renderer);
    const robbed = recordingCharge();
    const sinkA = new DiagnosticCollector();
    const passA = runTrialExecutionPassForTesting({
      runId,
      ownerId,
      maxRenders: 5,
      chargeBudget: robbed.chargeBudget,
      sink: sinkA,
    });
    for (let attempt = 0; attempt < 300 && !gate.entered(); attempt += 1) await sleep(10);
    expect(gate.entered()).toBe(true);

    // Age EVERY claim A holds past the window, simulating a pass so delayed that
    // recovery is entitled to conclude it died.
    await db()
      .update(imageIdentityPackTrialCells)
      .set({ claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) })
      .where(and(eq(imageIdentityPackTrialCells.runId, runId), eq(imageIdentityPackTrialCells.status, "running")));

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const heir = recordingCharge();
    const sinkB = new DiagnosticCollector();
    const passB = await runTrialExecutionPassForTesting({
      runId,
      ownerId,
      maxRenders: 5,
      chargeBudget: heir.chargeBudget,
      sink: sinkB,
    });
    expect(passB?.ok).toBe(true);
    if (!passB?.ok) return;
    expect(passB.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered", "rendered"]);
    expect(sinkB.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.claim_recovered");
    expect(calls()).toBe(3);

    gate.release();
    const finished = await passA;
    expect(finished?.ok).toBe(true);
    if (!finished?.ok) return;
    // A's head cell was already re-rendered by B, so its settle loses and its
    // stored output is discarded — the documented dead-worker trade, paid once.
    // Its TAIL never reaches a provider: the boundary heartbeat returns no ids,
    // so both queued cells are recorded skipped for free.
    expect(finished.executed.map((cell) => cell.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(gate.calls()).toBe(1);
    expect(sinkA.items.map((entry) => entry.message)).toContain("the claim was taken over before the render started");
    // Both passes were admitted at three cells and neither refunds — the charge
    // is a reservation, and recovery paying twice is exactly the trade it makes.
    expect(robbed.charges).toEqual([3]);
    expect(heir.charges).toEqual([3]);

    // Exactly one surviving output per cell: B's three, with A's orphan deleted.
    // A fresh character scopes this to THIS run's outputs.
    const outputs = await db()
      .select({ id: images.id })
      .from(images)
      .where(
        and(
          eq(images.ownerId, ownerId),
          eq(images.kind, "identity_trial_output"),
          eq(images.entityId, subject.characterId),
        ),
      );
    expect(outputs).toHaveLength(3);
    expect(await outputImageRows(runId)).toHaveLength(3);
    // Nothing left holding a claim, so the run is reviewable rather than wedged.
    expect((await cellRows(runId)).map((row) => row.status)).toEqual(["rendered", "rendered", "rendered"]);
  }, 20_000);

  it("settles a throw AFTER storage with the image it had already stored", async () => {
    // The gap this closes: a throw between "bytes written" and "cell settled"
    // used to settle `failed` with a NULL output, leaving a ready, owner-scoped,
    // hidden image no cell pointed at — unreachable by the run's delete sweep
    // (it walks cell pointers) and invisible everywhere else.
    //
    // The fault is injected at the DATABASE because that is precisely what the
    // containment exists for: the render succeeds, its bytes land, and the write
    // that records the outcome fails. `NOT VALID` so the CHECK judges only new
    // writes — this table is full of `rendered` rows from earlier cases.
    const subject = await seedTrialCharacter("Post-Store Throw Subject");
    const runId = await createdRunId({
      label: "post-store throw run",
      characterIds: [subject.characterId],
      strategies: ["canonical_only"],
    });
    await db().execute(sql`alter table image_identity_pack_trial_cells drop constraint if exists trial_int_no_rendered`);
    setTrialRendererForTesting(async () => {
      await db().execute(
        sql`alter table image_identity_pack_trial_cells add constraint trial_int_no_rendered check (status <> 'rendered') not valid`,
      );
      return { ok: true, image: await testPngBuffer(96, 128) };
    });

    const sink = new DiagnosticCollector();
    try {
      const result = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge, sink });
      expect(result?.ok).toBe(true);
      if (!result?.ok) return;
      // The `rendered` settle threw; the containment's `failed` settle is allowed.
      expect(result.executed.map((cell) => cell.status)).toEqual(["failed"]);
    } finally {
      await db().execute(
        sql`alter table image_identity_pack_trial_cells drop constraint if exists trial_int_no_rendered`,
      );
    }
    expect(sink.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.cell_degraded");

    const [cell] = await cellRows(runId);
    expect(cell?.status).toBe("failed");
    // THE POINT: the cell owns the image it paid for, on the row AND in the
    // stored result, so the two cannot drift.
    expect(cell?.outputImageId).not.toBeNull();
    expect(cell && storedResult(cell).outputImageId).toBe(cell?.outputImageId);
    const outputs = await outputImageRows(runId);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.status).toBe("ready");
    // …and because the cell points at it, the run's delete sweep reaches it.
    expect(await deleteIdentityPackTrialRun(runId, ownerId)).toEqual({ deleted: true, outputImagesRemoved: 1 });
  });

  it("hands its claims back when the budget guard THROWS", async () => {
    // A guard that threw decided nothing and spent nothing, so its claims are as
    // unspent as a refusal's. Left `running` they would freeze the grid for the
    // whole stale window over a fault that never touched a provider.
    const runId = await createdRunId({ label: "budget throw run" });
    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);

    await expect(
      executeIdentityPackTrialCells({
        runId,
        ownerId,
        chargeBudget: () => Promise.reject(new Error("budget service unreachable")),
      }),
    ).rejects.toThrow("budget service unreachable");

    expect(calls()).toBe(0);
    // Claimed, then handed straight back — not left `running` for the window.
    expect((await cellRows(runId)).map((cell) => cell.status)).toEqual(["planned", "planned"]);
    // Immediately retryable, because nothing was charged and nothing was sent.
    setTrialRendererForTesting(countingRenderer().renderer);
    const retried = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(retried?.ok).toBe(true);
    if (!retried?.ok) return;
    expect(retried.executed.map((cell) => cell.status)).toEqual(["rendered", "rendered"]);
  });

  it("returns the claims it never reached when a containment settle fails", async () => {
    // When the settle machinery itself fails the pass stops — continuing would
    // repeat the same write failure cell after cell. But the cells it never
    // TOUCHED were charged and never sent anywhere, so handing them back is
    // free, and leaving them `running` would freeze that part of the grid for
    // the whole stale window. Their charge stays spent: a charged slot is a
    // reservation for a pass admitted at that size, exactly as for a cell that
    // conflicted mid-batch.
    const runId = await createdRunId({ label: "settle failure run" });
    await db().execute(sql`alter table image_identity_pack_trial_cells drop constraint if exists trial_int_no_failed`);
    setTrialRendererForTesting(async () => {
      // Make the containment's OWN settle impossible, then throw into it.
      await db().execute(
        sql`alter table image_identity_pack_trial_cells add constraint trial_int_no_failed check (status <> 'failed') not valid`,
      );
      throw new Error("socket hang up");
    });

    const sink = new DiagnosticCollector();
    const { chargeBudget, charges } = recordingCharge();
    try {
      const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget, sink });
      expect(result?.ok).toBe(true);
      if (!result?.ok) return;
      // Nothing could be recorded, so the pass reports no outcomes at all.
      expect(result.executed).toEqual([]);
    } finally {
      await db().execute(sql`alter table image_identity_pack_trial_cells drop constraint if exists trial_int_no_failed`);
    }
    expect(charges).toEqual([2]);
    expect(sink.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.cell_degraded");

    const rows = await cellRows(runId);
    // The cell whose settle failed keeps its claim and waits out stale recovery:
    // writing more rows to a database that just refused a write is not a
    // recovery plan, and that render may already have been paid for.
    expect(rows[0]?.status).toBe("running");
    // The cell this pass never reached goes straight back to the grid.
    expect(rows[1]?.status).toBe("planned");
    expect(rows[1]?.claimToken).toBeNull();
  });

  it("settles an unreachable cell terminally and free, BEFORE the budget is charged", async () => {
    // A cell naming a fixture, model or profile that no longer exists can never
    // reach a provider. Discovered after the charge, a run left stale by a
    // deleted profile burned a budget unit per cell per pass to keep
    // rediscovering it.
    const runId = await createdRunId({ label: "unreachable cell run", strategies: ["canonical_only"] });
    const validSpec = await storedSpec(runId);
    await db()
      .insert(imageIdentityPackTrialCells)
      .values([
        {
          runId,
          cellKey: "zzz-unknown-fixture",
          status: "planned",
          specJson: { ...validSpec, id: "unreachablefixturecella", promptFixtureId: "variant_wardrobe_v999" },
        },
        {
          runId,
          cellKey: "zzz-unknown-profile",
          status: "planned",
          specJson: { ...validSpec, id: "unreachableprofilecella", profileId: "imgprfneverregisteredaa" },
        },
      ]);

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const { chargeBudget, charges } = recordingCharge();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;

    // Charged for the ONE cell that could actually run.
    expect(charges).toEqual([1]);
    expect(calls()).toBe(1);
    const rows = await cellRows(runId);
    expect(rows.find((row) => row.cellKey === "zzz-unknown-fixture")).toMatchObject({
      status: "refused",
      resultJson: { failureCode: "fixture_unknown", outputImageId: null },
    });
    expect(rows.find((row) => row.cellKey === "zzz-unknown-profile")).toMatchObject({
      status: "refused",
      resultJson: { failureCode: "cell_conflict", outputImageId: null },
    });
  });

  it("settles a malformed cell terminally and free, and never asks a provider about it", async () => {
    const runId = await createdRunId({ label: "malformed cell run", strategies: ["canonical_only"] });
    const validSpec = await storedSpec(runId);
    await db()
      .insert(imageIdentityPackTrialCells)
      .values([
        { runId, cellKey: "zzz-garbage-spec", status: "planned", specJson: { nope: true } },
        // Parseable, but planned before anything could compile what it would
        // send: a different corruption, and a different code.
        { runId, cellKey: "zzz-precompile-spec", status: "planned", specJson: { ...validSpec, resolvedControls: null } },
      ]);

    const { renderer, calls } = countingRenderer();
    setTrialRendererForTesting(renderer);
    const { chargeBudget, charges } = recordingCharge();
    const result = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;

    // Charged for the ONE cell that could actually run. A malformed cell used to
    // be picked, charged for, and skipped — on every pass, forever.
    expect(charges).toEqual([1]);
    expect(calls()).toBe(1);
    const rows = await cellRows(runId);
    expect(rows.find((row) => row.cellKey === "zzz-garbage-spec")).toMatchObject({
      status: "refused",
      resultJson: { failureCode: "spec_invalid", outputImageId: null },
    });
    expect(rows.find((row) => row.cellKey === "zzz-precompile-spec")).toMatchObject({
      status: "refused",
      resultJson: { failureCode: "cell_conflict", outputImageId: null },
    });

    // Terminal exactly once: a second Execute finds nothing planned, charges
    // nothing, and leaves both settlements as they are.
    const again = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget });
    expect(again?.ok).toBe(true);
    if (!again?.ok) return;
    expect(again.executed).toEqual([]);
    expect(charges).toEqual([1]);
    expect((await cellRows(runId)).filter((row) => row.status === "refused")).toHaveLength(2);
  });
});

describe.skipIf(!ready)("blinded review, verdicts, and deletion", () => {
  let runId = "";
  let pairId = "";
  let leftIsA = false;
  /** Output image id per strategy, so left/right can be checked against the mapping. */
  let canonicalOutputId = "";
  let faceDetailOutputId = "";

  it("serves a stable blinded pair whose sides follow the derived mapping", async () => {
    runId = await createdRunId({ label: "review run" });
    setTrialRendererForTesting(countingRenderer().renderer);
    const executed = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge });
    expect(executed?.ok).toBe(true);

    const cells = await cellRows(runId);
    for (const cell of cells) {
      const spec = cell.specJson as { identityStrategy: string };
      if (spec.identityStrategy === "canonical_only") canonicalOutputId = cell.outputImageId ?? "";
      else faceDetailOutputId = cell.outputImageId ?? "";
    }
    expect(canonicalOutputId).not.toBe("");
    expect(faceDetailOutputId).not.toBe("");

    const first = await nextUnreviewedTrialPair(runId, ownerId);
    const again = await nextUnreviewedTrialPair(runId, ownerId);
    expect(first?.pair).not.toBeNull();
    expect(again).toEqual(first);
    if (!first?.pair) return;
    pairId = first.pair.pairId;
    expect(pairId).toBe(cells.map((cell) => cell.id).sort().join(":"));
    expect(first.pair.task).toBe("variant");
    expect(first.pair.promptFixtureId).toBe(WARDROBE_FIXTURE);

    // A is canonical_only (earlier in the strategy vocabulary); which SIDE it
    // shows on is the derived blind mapping, stable because it is a hash parity.
    leftIsA = trialPairLeftIsA(runId, pairId);
    expect(first.pair.leftImageId).toBe(leftIsA ? canonicalOutputId : faceDetailOutputId);
    expect(first.pair.rightImageId).toBe(leftIsA ? faceDetailOutputId : canonicalOutputId);
  });

  it("stores a submission unblinded into A/B space with the mapping persisted", async () => {
    const result = await submitTrialPairGrade({
      runId,
      ownerId,
      request: {
        pairId,
        grades: gradesFavoringLeft(),
        catastrophicLeft: ["extra limb"],
        catastrophicRight: [],
        notes: "left looked more like the reference",
      },
    });
    expect(result).toMatchObject({ ok: true, leftIsA });

    const [grade] = await db()
      .select()
      .from(imageIdentityPackTrialGrades)
      .where(eq(imageIdentityPackTrialGrades.runId, runId));
    expect(grade?.leftIsA).toBe(leftIsA);
    expect(grade?.reviewedByUserId).toBe(ownerId);
    // Favoring LEFT means favoring A exactly when the left image WAS A —
    // otherwise the sign flips and the catastrophic list crosses sides.
    expect(grade?.gradesJson).toMatchObject({
      grades: { overall_preference: leftIsA ? -2 : 2 },
      catastrophicA: leftIsA ? ["extra limb"] : [],
      catastrophicB: leftIsA ? [] : ["extra limb"],
    });

    expect((await nextUnreviewedTrialPair(runId, ownerId))?.pair).toBeNull();
  });

  it("refuses a duplicate grade with grade_conflict", async () => {
    const duplicate = await submitTrialPairGrade({
      runId,
      ownerId,
      request: {
        pairId,
        grades: gradesFavoringLeft(),
        catastrophicLeft: [],
        catastrophicRight: [],
        notes: null,
      },
    });
    expect(duplicate?.ok).toBe(false);
    if (!duplicate || duplicate.ok) return;
    expect(duplicate.refusal.code).toBe("grade_conflict");
  });

  it("summarizes in canonical A/B space", async () => {
    const summary = await identityPackTrialSummary(runId, ownerId);
    expect(summary?.comparisons).toHaveLength(1);
    // The verdict-slot list: every rendered (profile, strategy), whether or not
    // a pairwise comparison exists for it.
    // Each combo carries the pairwise evidence behind its verdict slot: one
    // pair, graded, on both sides of the single comparison.
    expect(summary?.renderedCombos).toEqual([
      {
        profileId: TRIAL_PROFILE_ID,
        identityStrategy: "canonical_only",
        renderedCells: 1,
        totalPairs: 1,
        gradedPairs: 1,
      },
      {
        profileId: TRIAL_PROFILE_ID,
        identityStrategy: "face_detail_only",
        renderedCells: 1,
        totalPairs: 1,
        gradedPairs: 1,
      },
    ]);
    const comparison = summary?.comparisons[0];
    expect(comparison).toMatchObject({
      profileId: TRIAL_PROFILE_ID,
      strategyA: "canonical_only",
      strategyB: "face_detail_only",
      variantKeyA: "current",
      variantKeyB: "current",
      totalPairs: 1,
      gradedPairs: 1,
      overall: leftIsA ? { winsA: 1, ties: 0, winsB: 0 } : { winsA: 0, ties: 0, winsB: 1 },
      catastrophic: leftIsA ? { a: 1, b: 0 } : { a: 0, b: 1 },
    });
    expect(comparison?.dimensions.overall_preference).toEqual({ mean: leftIsA ? -2 : 2, count: 1 });
    expect(comparison?.dimensions.hair).toEqual({ mean: 0, count: 1 });
    expect(summary?.verdicts).toEqual([]);
  });

  it("refuses a verdict naming a combo no cell of the run carries", async () => {
    const bogusProfile = await recordTrialVerdict({
      runId,
      ownerId,
      profileId: "imgprfneverinthisrunaaaa",
      identityStrategy: "canonical_only",
      verdict: "rejected",
      reason: "typo'd profile id",
    });
    expect(bogusProfile?.ok).toBe(false);
    if (!bogusProfile || bogusProfile.ok) return;
    expect(bogusProfile.refusal.code).toBe("verdict_unknown_combo");

    // A real profile under a strategy the run never planned is refused too.
    const bogusStrategy = await recordTrialVerdict({
      runId,
      ownerId,
      profileId: TRIAL_PROFILE_ID,
      identityStrategy: "canonical_then_face_detail",
      verdict: "rejected",
      reason: "strategy not in the run",
    });
    expect(bogusStrategy?.ok).toBe(false);
    if (!bogusStrategy || bogusStrategy.ok) return;
    expect(bogusStrategy.refusal.code).toBe("verdict_unknown_combo");
    expect((await identityPackTrialSummary(runId, ownerId))?.verdicts).toEqual([]);
  });

  // The run's one pair was graded two cases up, so the review-completeness gate
  // is satisfied here and these rulings exercise the accepted path.
  it("upserts verdicts and completes the run once every rendered combo is ruled", async () => {
    const first = await recordTrialVerdict({
      runId,
      ownerId,
      profileId: TRIAL_PROFILE_ID,
      identityStrategy: "canonical_only",
      verdict: "promoted",
      reason: "clear likeness win",
    });
    // face_detail_only is rendered but unruled, so the run stays in review.
    expect(first).toMatchObject({ ok: true, runStatus: "review" });

    const revised = await recordTrialVerdict({
      runId,
      ownerId,
      profileId: TRIAL_PROFILE_ID,
      identityStrategy: "canonical_only",
      verdict: "rejected",
      reason: "reversed after a second look",
    });
    expect(revised?.ok).toBe(true);
    if (!revised?.ok) return;
    expect(revised.verdicts).toHaveLength(1);
    expect(revised.verdicts[0]).toMatchObject({
      verdict: "rejected",
      decidedByUserId: ownerId,
      policyVersion: IDENTITY_PACK_POLICY_VERSION,
    });
    expect(typeof revised.verdicts[0]?.decidedAt).toBe("string");

    const last = await recordTrialVerdict({
      runId,
      ownerId,
      profileId: TRIAL_PROFILE_ID,
      identityStrategy: "face_detail_only",
      verdict: "retained_current",
      reason: "no consistent edge",
    });
    expect(last).toMatchObject({ ok: true, runStatus: "complete" });
    expect((await runRow(runId))?.status).toBe("complete");
    expect((await identityPackTrialSummary(runId, ownerId))?.verdicts).toHaveLength(2);
  });

  it("deletes the run with its cells, grades, output rows, and files", async () => {
    const outputs = await outputImageRows(runId);
    expect(outputs).toHaveLength(2);
    const filePaths = outputs.map((output) => absoluteImagePath(output));

    const result = await deleteIdentityPackTrialRun(runId, ownerId);
    expect(result).toEqual({ deleted: true, outputImagesRemoved: 2 });

    expect(await runRow(runId)).toBeUndefined();
    expect(await cellRows(runId)).toEqual([]);
    const grades = await db()
      .select({ id: imageIdentityPackTrialGrades.id })
      .from(imageIdentityPackTrialGrades)
      .where(eq(imageIdentityPackTrialGrades.runId, runId));
    expect(grades).toEqual([]);
    const rows = await db()
      .select({ id: images.id })
      .from(images)
      .where(inArray(images.id, outputs.map((output) => output.id)));
    expect(rows).toEqual([]);
    for (const filePath of filePaths) {
      await expect(fs.access(filePath)).rejects.toThrow();
    }
  });
});

describe.skipIf(!ready)("verdict gating and the normalized verdict ledger", () => {
  it("refuses a verdict while the run is still in draft", async () => {
    const runId = await createdRunId({ label: "draft verdict run" });
    const sink = new DiagnosticCollector();

    const refused = await recordTrialVerdict(verdictInput(runId, "canonical_only", { reason: "far too early", sink }));
    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) return;
    expect(refused.refusal.code).toBe("review_incomplete");
    // The message names what is outstanding: an operator must not have to guess
    // which of the three gates said no.
    expect(refused.refusal.message).toContain("2 planned");
    expect(sink.items.map((d) => d.code)).toContain("images.identity_pack.trial.review_incomplete");

    // Nothing was recorded — a refused ruling leaves no row behind.
    expect(await verdictRows(runId)).toEqual([]);
  });

  it("refuses a verdict while cells are still planned, and again while one is claimed", async () => {
    const runId = await createdRunId({ label: "mid-flight verdict run" });
    setTrialRendererForTesting(countingRenderer().renderer);
    const firstPass = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 1, chargeBudget: admitCharge });
    expect(firstPass?.ok).toBe(true);
    expect((await runRow(runId))?.status).toBe("running");

    const midFlight = await recordTrialVerdict(verdictInput(runId, "canonical_only"));
    expect(midFlight?.ok).toBe(false);
    if (!midFlight || midFlight.ok) return;
    expect(midFlight.refusal.code).toBe("review_incomplete");
    expect(midFlight.refusal.message).toContain("1 planned");

    // Finish the grid and its review, then simulate a claim that outlived its
    // pass. A `running` cell is a render that may ALREADY have been paid for —
    // its evidence is still coming, so it blocks a ruling exactly as a planned
    // cell does. This is the case the old `plannedRemaining` fact missed.
    const secondPass = await executeIdentityPackTrialCells({ runId, ownerId, maxRenders: 5, chargeBudget: admitCharge });
    expect(secondPass?.ok).toBe(true);
    expect(await gradeEveryPair(runId)).toBe(1);
    const [cell] = await cellRows(runId);
    await db()
      .update(imageIdentityPackTrialCells)
      .set({ status: "running", claimToken: "stale-claim", claimedAt: new Date() })
      .where(eq(imageIdentityPackTrialCells.id, cell?.id ?? ""));

    const claimed = await recordTrialVerdict(verdictInput(runId, "canonical_only"));
    expect(claimed?.ok).toBe(false);
    if (!claimed || claimed.ok) return;
    expect(claimed.refusal.code).toBe("review_incomplete");
    expect(claimed.refusal.message).toContain("1 running");
    expect(await verdictRows(runId)).toEqual([]);
  });

  it("refuses a verdict over an ungraded pair, and records the flag when the override is given", async () => {
    const runId = await reviewedRun("ungraded verdict run");

    const refused = await recordTrialVerdict(verdictInput(runId, "canonical_only", { verdict: "promoted" }));
    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) return;
    expect(refused.refusal.code).toBe("review_incomplete");
    expect(refused.refusal.message).toContain("reviewable pair");

    const overridden = await recordTrialVerdict(
      verdictInput(runId, "canonical_only", { verdict: "promoted", overrideIncompleteReview: true }),
    );
    expect(overridden?.ok).toBe(true);
    if (!overridden?.ok) return;
    // The override is honored AND recorded: a promotion made on unseen
    // comparisons must stay distinguishable from one made on all of them.
    expect(overridden.verdicts).toHaveLength(1);
    expect(overridden.verdicts[0]).toMatchObject({
      profileId: TRIAL_PROFILE_ID,
      identityStrategy: "canonical_only",
      verdict: "promoted",
      decidedByUserId: ownerId,
      policyVersion: IDENTITY_PACK_POLICY_VERSION,
      overrideIncompleteReview: true,
    });
    // Still in review: one slot ruled, the other not, and the pair ungraded.
    expect(overridden.runStatus).toBe("review");
    // The flag rides the summary wire the UI actually reads.
    const summary = await identityPackTrialSummary(runId, ownerId);
    expect(summary?.verdicts[0]?.overrideIncompleteReview).toBe(true);
  });

  it("keeps a fully ruled run in review until its pairs are graded", async () => {
    const runId = await reviewedRun("completion law run");

    // Full verdict coverage, every ruling an override — the run must NOT
    // complete on coverage alone. `complete` claims the blinded procedure ran.
    for (const strategy of ["canonical_only", "face_detail_only"] as const) {
      const ruled = await recordTrialVerdict(verdictInput(runId, strategy, { overrideIncompleteReview: true }));
      expect(ruled).toMatchObject({ ok: true, runStatus: "review" });
    }
    expect((await runRow(runId))?.status).toBe("review");
    expect(await verdictRows(runId)).toHaveLength(2);

    // Grading the last pair supplies the missing half — and CLOSES the run then
    // and there, because status is settled by writes and a grade is one of the
    // two writes that can complete a run.
    expect(await gradeEveryPair(runId)).toBe(1);
    expect((await runRow(runId))?.status).toBe("complete");

    // A ruling on a complete run is the revision path, and it keeps it complete.
    const revised = await recordTrialVerdict(verdictInput(runId, "canonical_only", { verdict: "promoted" }));
    expect(revised).toMatchObject({ ok: true, runStatus: "complete" });
    expect((await runRow(runId))?.status).toBe("complete");

    const rows = await verdictRows(runId);
    expect(rows).toHaveLength(2);
    // The revision was made on complete evidence, so its override flag clears;
    // the untouched ruling keeps the true it was recorded with.
    expect(rows.find((row) => row.identityStrategy === "canonical_only")).toMatchObject({
      verdict: "promoted",
      overrideIncompleteReview: false,
    });
    expect(rows.find((row) => row.identityStrategy === "face_detail_only")?.overrideIncompleteReview).toBe(true);
  });

  it("accepts verdicts on a fully graded run with no override and completes on the last slot", async () => {
    const runId = await reviewedRun("graded verdict run");
    expect(await gradeEveryPair(runId)).toBe(1);

    const first = await recordTrialVerdict(verdictInput(runId, "canonical_only", { verdict: "promoted" }));
    expect(first).toMatchObject({ ok: true, runStatus: "review" });
    if (!first?.ok) return;
    expect(first.verdicts[0]?.overrideIncompleteReview).toBe(false);

    const second = await recordTrialVerdict(verdictInput(runId, "face_detail_only", { verdict: "rejected" }));
    expect(second).toMatchObject({ ok: true, runStatus: "complete" });
    if (!second?.ok) return;
    expect(second.verdicts).toHaveLength(2);
    expect(second.verdicts.every((entry) => !entry.overrideIncompleteReview)).toBe(true);
  });

  it("completes the run on the LAST GRADE, not only on the next verdict write", async () => {
    // Status is derived at WRITE time, and grading is one of exactly two writes
    // that can complete a run. Before this, a run ruled entirely through
    // overrides sat in `review` after its final grade landed, and only an
    // unrelated later verdict noticed — so "complete" lagged the evidence.
    const runId = await reviewedRun("grade completes run");
    for (const strategy of ["canonical_only", "face_detail_only"] as const) {
      const ruled = await recordTrialVerdict(verdictInput(runId, strategy, { overrideIncompleteReview: true }));
      expect(ruled).toMatchObject({ ok: true, runStatus: "review" });
    }
    expect((await runRow(runId))?.status).toBe("review");

    const pair = (await nextUnreviewedTrialPair(runId, ownerId))?.pair;
    expect(pair).not.toBeNull();
    if (!pair) return;
    const graded = await submitTrialPairGrade({
      runId,
      ownerId,
      request: {
        pairId: pair.pairId,
        grades: gradesFavoringLeft(),
        catastrophicLeft: [],
        catastrophicRight: [],
        notes: null,
      },
    });
    // The grade itself reports the settled status, and the row agrees — with no
    // further verdict write anywhere.
    expect(graded).toMatchObject({ ok: true, runStatus: "complete" });
    expect((await runRow(runId))?.status).toBe("complete");
    expect(await verdictRows(runId)).toHaveLength(2);
  });

  it("refuses to complete or rule a run whose rendered evidence has gone missing", async () => {
    // "Every reviewable pair is graded" becomes vacuously TRUE exactly when the
    // pairs stop existing. A rendered cell whose output row vanished takes its
    // pairs with it, so completion has to count the hole rather than read past
    // it — `complete` is the claim that the blinded procedure ran over THIS
    // run's evidence.
    const runId = await reviewedRun("degraded evidence run");
    expect(await gradeEveryPair(runId)).toBe(1);
    expect((await identityPackTrialSummary(runId, ownerId))?.degradedCells).toBe(0);

    const [first] = await cellRows(runId);
    await db()
      .update(imageIdentityPackTrialCells)
      .set({ outputImageId: null })
      .where(eq(imageIdentityPackTrialCells.id, first?.id ?? ""));

    // The wire carries the hole, as the SAME number this gate refuses on. It has
    // to: losing the cell REMOVED its pair, so every count the client can still
    // see reads complete — which is exactly when the server refuses, and exactly
    // when the operator needs the override offered rather than a bare refusal.
    const degradedSummary = await identityPackTrialSummary(runId, ownerId);
    expect(degradedSummary?.degradedCells).toBe(1);
    expect(degradedSummary?.comparisons.every((entry) => entry.gradedPairs === entry.totalPairs)).toBe(true);
    expect(degradedSummary?.renderedCombos.every((entry) => entry.gradedPairs === entry.totalPairs)).toBe(true);

    const refused = await recordTrialVerdict(verdictInput(runId, "canonical_only"));
    expect(refused?.ok).toBe(false);
    if (!refused || refused.ok) return;
    expect(refused.refusal.code).toBe("review_incomplete");
    expect(refused.refusal.message).toContain("no longer carry reviewable evidence");

    // The override still carries it — and is RECORDED, because the evidence
    // genuinely was incomplete. That is the whole job of the flag.
    const overridden = await recordTrialVerdict(
      verdictInput(runId, "canonical_only", { overrideIncompleteReview: true }),
    );
    expect(overridden?.ok).toBe(true);
    if (!overridden?.ok) return;
    expect(overridden.verdicts[0]?.overrideIncompleteReview).toBe(true);
    // And even fully ruled, the run does not claim completion over a hole.
    const last = await recordTrialVerdict(
      verdictInput(runId, "face_detail_only", { overrideIncompleteReview: true }),
    );
    expect(last).toMatchObject({ ok: true, runStatus: "review" });
    expect((await runRow(runId))?.status).toBe("review");
  });

  it("refuses to complete a run whose rendered cell's spec can no longer be read", async () => {
    // A rendered row nothing can parse is not one fewer combo — it is a combo of
    // UNKNOWN identity, and reading it as absent would silently delete a verdict
    // slot the run was supposed to be ruled on.
    const runId = await reviewedRun("corrupt spec run");
    expect(await gradeEveryPair(runId)).toBe(1);
    const [first] = await cellRows(runId);
    await db()
      .update(imageIdentityPackTrialCells)
      .set({ specJson: { nope: true } })
      .where(eq(imageIdentityPackTrialCells.id, first?.id ?? ""));

    const sink = new DiagnosticCollector();
    // The surviving slot is still nameable and still rulable…
    const ruled = await recordTrialVerdict(
      verdictInput(runId, "face_detail_only", { overrideIncompleteReview: true, sink }),
    );
    expect(ruled).toMatchObject({ ok: true, runStatus: "review" });
    // …but the unreadable one keeps the run out of `complete`, loudly.
    expect((await runRow(runId))?.status).toBe("review");
    expect(sink.items.map((entry) => entry.code)).toContain("images.identity_pack.trial.cell_degraded");
    // And it is not offered as a verdict slot either — a slot nobody can name is
    // a slot nobody can act on.
    const summary = await identityPackTrialSummary(runId, ownerId);
    expect(summary?.renderedCombos.map((combo) => combo.identityStrategy)).toEqual(["face_detail_only"]);
  });

  it("records concurrent rulings on different combos and keeps one row per combo under a same-combo race", async () => {
    const runId = await reviewedRun("concurrent verdict run");
    expect(await gradeEveryPair(runId)).toBe(1);

    // The lost-update case the jsonb array could not survive: two rulings on two
    // DIFFERENT slots, submitted at once. Both read the ledger, both wrote it
    // back, and the second erased the first.
    const [canonical, faceDetail] = await Promise.all([
      recordTrialVerdict(verdictInput(runId, "canonical_only", { verdict: "promoted", reason: "concurrent A" })),
      recordTrialVerdict(verdictInput(runId, "face_detail_only", { verdict: "rejected", reason: "concurrent B" })),
    ]);
    expect(canonical?.ok).toBe(true);
    expect(faceDetail?.ok).toBe(true);
    expect((await verdictRows(runId)).map((row) => row.identityStrategy)).toEqual([
      "canonical_only",
      "face_detail_only",
    ]);

    // Two rulings on the SAME slot at once: the unique key makes it exactly one
    // row (whichever landed last wins), and the other slot is untouched.
    const [raceOne, raceTwo] = await Promise.all([
      recordTrialVerdict(verdictInput(runId, "canonical_only", { verdict: "retained_current", reason: "race one" })),
      recordTrialVerdict(
        verdictInput(runId, "canonical_only", { verdict: "experimental_admin_only", reason: "race two" }),
      ),
    ]);
    expect(raceOne?.ok).toBe(true);
    expect(raceTwo?.ok).toBe(true);

    const settled = await verdictRows(runId);
    expect(settled).toHaveLength(2);
    const ruled = settled.find((row) => row.identityStrategy === "canonical_only");
    expect(["retained_current", "experimental_admin_only"]).toContain(ruled?.verdict);
    expect(settled.find((row) => row.identityStrategy === "face_detail_only")).toMatchObject({
      verdict: "rejected",
      reason: "concurrent B",
    });
  });
});
