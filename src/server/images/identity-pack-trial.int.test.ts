import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { diag, DiagnosticCollector } from "@/contracts/diagnostics";
import {
  perTrialGradeDimension,
  type ImageIdentityPackTrialCreateRequest,
  type TrialPairGrades,
} from "@/contracts";
import { IDENTITY_PACK_POLICY_VERSION } from "@/lib/images/identity-pack-policy";
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
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageModelProfiles,
  imageModels,
  images,
} from "../db";
import { absoluteImagePath, createImageAsset, GALLERY_IMAGE_KINDS, saveImageBuffer, type ImageRow } from "./assets";
import {
  createIdentityPackTrialRun,
  deleteIdentityPackTrialRun,
  executeIdentityPackTrialCells,
  getIdentityPackTrialRunDetail,
  identityPackTrialSummary,
  listIdentityPackTrialRuns,
  nextUnreviewedTrialPair,
  recordTrialVerdict,
  setTrialRendererForTesting,
  submitTrialPairGrade,
  trialPairLeftIsA,
  type IdentityPackTrialCellRow,
  type TrialCellRenderer,
} from "./identity-pack-trial";

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
const FIXTURE_MODEL_IDS = [TRIAL_MODEL_ID, TIGHT_MODEL_ID];
const FIXTURE_PROFILE_IDS = [TRIAL_PROFILE_ID, TIGHT_PROFILE_ID];

const WARDROBE_FIXTURE = "variant_wardrobe_v1";
const POSE_FIXTURE = "variant_pose_v1";

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
  await db().insert(imageModels).values([
    {
      id: TRIAL_MODEL_ID,
      slug: "vesper-test/identity-trial",
      label: "Identity Trial Fixture",
      canGenerate: true,
      canEdit: true,
      maxReferences: 4,
    },
    {
      id: TIGHT_MODEL_ID,
      slug: "vesper-test/identity-trial-tight",
      label: "Identity Trial Tight Fixture",
      canGenerate: true,
      canEdit: true,
      maxReferences: 1,
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
function gatedRenderer(): { renderer: TrialCellRenderer; entered: () => boolean; release: () => void } {
  let entered = false;
  let open!: () => void;
  const parked = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    renderer: async () => {
      entered = true;
      await parked;
      return { ok: true, image: await testPngBuffer(96, 128) };
    },
    entered: () => entered,
    release: () => {
      open();
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** All eleven dimensions tied except a strong preference for the LEFT image. */
function gradesFavoringLeft(): TrialPairGrades {
  return { ...perTrialGradeDimension(() => 0), overall_preference: -2 };
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
    expect(result.counts).toEqual({ planned: 2, rendered: 0, failed: 0, refused: 2 });
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
        modelVersion: "unprobed",
        profileKey: "trial-harness",
        packRevision: 1,
        cropMethod: "heuristic",
        derivationVersion: "derive_v1",
        requestedSeed: null,
      });
      expect(cell.spec?.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(cell.spec?.positivePromptHash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(result.counts).toEqual({ planned: 0, rendered: 0, failed: 0, refused: 1 });
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
    expect(result.counts).toEqual({ planned: 1, rendered: 0, failed: 0, refused: 1 });
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
    // Settled means settled: a fresh pass finds nothing planned to re-render.
    const again = await executeIdentityPackTrialCells({ runId, ownerId, chargeBudget: admitCharge });
    expect(again?.ok).toBe(true);
    if (!again?.ok) return;
    expect(again.executed).toEqual([]);
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
    expect(summary?.renderedCombos).toEqual([
      { profileId: TRIAL_PROFILE_ID, identityStrategy: "canonical_only", renderedCells: 1 },
      { profileId: TRIAL_PROFILE_ID, identityStrategy: "face_detail_only", renderedCells: 1 },
    ]);
    const comparison = summary?.comparisons[0];
    expect(comparison).toMatchObject({
      profileId: TRIAL_PROFILE_ID,
      strategyA: "canonical_only",
      strategyB: "face_detail_only",
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
