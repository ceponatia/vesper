import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ImageIdentityPackTrialReviewPairWire,
  type ImageIdentityPackTrialRunDetail,
  type ImageIdentityPackTrialRunSummary,
  type ImageIdentityPackTrialSummaryWire,
  perTrialGradeDimension,
  type TrialCellCounts,
  type TrialRunStatus,
  type TrialVerdict,
} from "@vesper/image-core";
import { characters, db, imageModelProfiles, imageModels } from "@/server/db";

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Trial Routes Int", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { createImageAsset, saveOwnedImageBuffer, setTrialRendererForTesting } from "@/server/images";
import {
  apiRequest,
  bindAuthUser,
  endTestPool,
  expectJson,
  probeIntegrationDb,
  purgeOwnerRows,
  routeCtx,
  seedTestUser,
  testPngBuffer,
  withAuthUser,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { GET as trialList, POST as trialCreate } from "./route";
import { DELETE as trialDelete, GET as trialDetail } from "./[runId]/route";
import { POST as trialExecute } from "./[runId]/execute/route";
import { GET as trialNextPair, POST as trialGrade } from "./[runId]/review/route";
import { GET as trialSummary } from "./[runId]/summary/route";
import { POST as trialVerdict } from "./[runId]/verdict/route";

/**
 * The trial admin routes end to end against DATABASE_URL and a sandboxed
 * DATA_ROOT (design doc Wave 3), with the renderer seam always injected —
 * Replicate is never called. The service's own int suite proves the machinery;
 * what only THIS suite can prove is the route layer: the owner-admin gate that
 * 404s a non-admin, the wire shapes and refusal envelopes, the render-budget
 * charge threading `withOwnerAdmin`'s user into `imageRenderRejection`, and the
 * blinded pair crossing the wire with nothing strategy-shaped on it.
 *
 * Self-skips when the database is unreachable, except under strict integration
 * mode (`pnpm test:int:strict`), where it fails.
 */

const ready = await probeIntegrationDb("trial-routes.int.test", "image_identity_pack_trial_runs");

const MODEL_ID = "imgmdltrialroutesaaaaaa";
const PROFILE_ID = "imgprftrialroutesaaaaaa";
/** An offered GENERATE profile — the only shape the no-pack baseline plans on
 * (an edit profile with zero references has nothing to edit). */
const GENERATE_PROFILE_ID = "imgprftrialroutesgenaaa";
const PROFILE_IDS = [PROFILE_ID, GENERATE_PROFILE_ID];

let temp: TempDataRoot | undefined;
let ownerId = "";
/** A character with a ready 384×512 portrait — heuristic-pack eligible. */
let subjectId = "";

const trialPath = (suffix = "") => `/api/admin/self/identity-packs/trial${suffix}`;
const runCtx = (runId: string) => routeCtx({ runId });

beforeAll(async () => {
  if (!ready) return;
  temp = await withTempDataRoot("vesper-trial-routes-int");
  const user = await seedTestUser("trial-routes-int", { name: "Trial Routes Int", role: "admin" });
  bindAuthUser(authState, user);
  ownerId = user.id;

  // Registry rows are global (outside purgeOwnerRows), so plant delete-first
  // with this suite's own ids, exactly like the service's int suite.
  await db().delete(imageModelProfiles).where(inArray(imageModelProfiles.id, PROFILE_IDS));
  await db().delete(imageModels).where(inArray(imageModels.id, [MODEL_ID]));
  await db()
    .insert(imageModels)
    .values({
      id: MODEL_ID,
      slug: "vesper-test/trial-routes",
      label: "Trial Routes Fixture",
      canGenerate: true,
      canEdit: true,
      // `for_variant` defaults to FALSE, and planning now asks the same
      // `imageProfileOffered` question production selection asks — so a fixture
      // model the operator never enabled for the variant surface plans nothing
      // (`profile_ineligible`, reason `legacy_surface_excluded`).
      forVariant: true,
      maxReferences: 4,
      // A controlled trial refuses to plan a cell whose provider version cannot
      // be pinned (`version_unpinned`), so an unprobed fixture would plan nothing.
      probedVersionId: "trialroutesversionaaaaaa",
    });
  await db()
    .insert(imageModelProfiles)
    .values([
      {
        id: PROFILE_ID,
        imageModelId: MODEL_ID,
        key: "trial-routes",
        label: "Trial Routes",
        task: "variant",
        operation: "edit",
        promptStrategy: "instruction_edit",
        isDefault: false,
        sort: 960,
      },
      {
        id: GENERATE_PROFILE_ID,
        imageModelId: MODEL_ID,
        key: "trial-routes-generate",
        label: "Trial Routes Generate",
        task: "variant",
        operation: "generate",
        promptStrategy: "text_to_image_description",
        isDefault: false,
        sort: 961,
      },
    ]);

  const [character] = await db()
    .insert(characters)
    .values({ ownerId, name: "Trial Routes Subject", profile: {} })
    .returning({ id: characters.id });
  if (!character) throw new Error("failed to insert the trial subject");
  subjectId = character.id;
  const asset = await createImageAsset({
    ownerId,
    kind: "avatar",
    entityKind: "character",
    entityId: subjectId,
    prompt: "trial routes portrait",
  });
  const saved = await saveOwnedImageBuffer(asset.id, ownerId, await testPngBuffer(384, 512));
  if (saved?.status !== "ready") throw new Error("failed to store the trial subject's portrait");
  await db()
    .update(characters)
    .set({ avatarImageId: saved.id, acceptedAvatarImageId: saved.id, acceptedAt: new Date() })
    .where(eq(characters.id, subjectId));
});

afterEach(() => {
  setTrialRendererForTesting(null);
});

afterAll(async () => {
  if (ready) {
    await db().delete(imageModelProfiles).where(inArray(imageModelProfiles.id, PROFILE_IDS));
    await db().delete(imageModels).where(inArray(imageModels.id, [MODEL_ID]));
  }
  await temp?.cleanup();
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

/** Two strategies over one fixture ⇒ two cells and exactly one reviewable pair. */
function createBody() {
  return {
    label: "route trial",
    characterIds: [subjectId],
    profileIds: [PROFILE_ID],
    strategies: ["canonical_only", "face_detail_only"],
    promptFixtureIds: ["variant_wardrobe_v1"],
  };
}

async function createdRunId(): Promise<string> {
  const res = await trialCreate(apiRequest(trialPath(), { body: createBody() }), routeCtx());
  const body = await expectJson<{ runId: string; counts: TrialCellCounts }>(res, 200);
  expect(body.counts.planned).toBe(2);
  return body.runId;
}

/** Execute the whole run through the injected renderer seam. */
async function executeRun(runId: string) {
  setTrialRendererForTesting(async () => ({ ok: true, image: await testPngBuffer(96, 128) }));
  const res = await trialExecute(apiRequest(trialPath(`/${runId}/execute`), { body: { maxRenders: 20 } }), runCtx(runId));
  return expectJson<{
    executed: { cellId: string; cellKey: string; status: string }[];
    remainingPlanned: number;
    runStatus: TrialRunStatus;
  }>(res, 200);
}

async function nextPairOf(runId: string): Promise<ImageIdentityPackTrialReviewPairWire | null> {
  const res = await trialNextPair(apiRequest(trialPath(`/${runId}/review`)), runCtx(runId));
  return (await expectJson<{ pair: ImageIdentityPackTrialReviewPairWire | null }>(res, 200)).pair;
}

/** Every dimension tied except a strong preference for the left image. */
function gradeBody(pairId: string) {
  return {
    pairId,
    grades: { ...perTrialGradeDimension(() => 0), overall_preference: -2 },
    catastrophicLeft: [],
    catastrophicRight: ["extra limb"],
    notes: "route round-trip",
  };
}

describe.skipIf(!ready)("trial admin routes", () => {
  it("hides the whole surface from a non-admin behind the same 404 a wrong URL gets", async () => {
    await withAuthUser(authState, { role: "user" }, async () => {
      const res = await trialList(apiRequest(trialPath()), routeCtx());
      expect(res.status).toBe(404);
      expect((await expectJson<{ error: { code: string } }>(res)).error.code).toBe("not_found");
    });
  });

  it("answers an unknown run id with a hidden 404 on every run-scoped handler", async () => {
    const missing = "trialrunthatdoesnotexist";
    const detail = await trialDetail(apiRequest(trialPath(`/${missing}`)), runCtx(missing));
    expect(detail.status).toBe(404);
    const execute = await trialExecute(
      apiRequest(trialPath(`/${missing}/execute`), { body: {} }),
      runCtx(missing),
    );
    expect(execute.status).toBe(404);
  });

  it("plans a run, lists it, and reads its planned cells back with full specs", async () => {
    const runId = await createdRunId();

    const listBody = await expectJson<{ runs: ImageIdentityPackTrialRunSummary[] }>(
      await trialList(apiRequest(trialPath()), routeCtx()),
      200,
    );
    expect(listBody.runs.map((run) => run.id)).toContain(runId);

    const detail = await expectJson<ImageIdentityPackTrialRunDetail>(
      await trialDetail(apiRequest(trialPath(`/${runId}`)), runCtx(runId)),
      200,
    );
    expect(detail.run.status).toBe("draft");
    expect(detail.cells).toHaveLength(2);
    for (const cell of detail.cells) {
      expect(cell.status).toBe("planned");
      expect(cell.spec?.profileId).toBe(PROFILE_ID);
      expect(cell.spec?.promptFixtureId).toBe("variant_wardrobe_v1");
    }
  });

  it("refuses an unplannable configuration as a 400 carrying the stable code", async () => {
    const res = await trialCreate(
      apiRequest(trialPath(), { body: { ...createBody(), promptFixtureIds: ["no_such_fixture_v1"] } }),
      routeCtx(),
    );
    expect((await expectJson<{ error: { code: string } }>(res, 400)).error.code).toBe("fixture_unknown");
  });

  it("refuses the whole run when a revision selector names a character outside it, recording nothing", async () => {
    const label = "stranded revision arm";
    const res = await trialCreate(
      apiRequest(trialPath(), {
        body: {
          ...createBody(),
          label,
          packVariants: [
            { source: "current" },
            { source: "revision", characterId: "chrnotinthisrunaaaaaaaaa", revision: 2 },
          ],
        },
      }),
      routeCtx(),
    );
    // A revision selector is character-scoped, so one naming a character the run
    // does not include would generate no cells at all — a configuration error the
    // planner refuses whole rather than dropping in silence.
    expect((await expectJson<{ error: { code: string } }>(res, 400)).error.code).toBe("pack_revision_unavailable");

    const listBody = await expectJson<{ runs: ImageIdentityPackTrialRunSummary[] }>(
      await trialList(apiRequest(trialPath()), routeCtx()),
      200,
    );
    expect(listBody.runs.some((run) => run.label === label)).toBe(false);
  });

  it("plans the no-pack baseline beside a pack arm and reads it back with a null strategy", async () => {
    const created = await expectJson<{ runId: string; counts: TrialCellCounts }>(
      await trialCreate(
        apiRequest(trialPath(), {
          body: {
            ...createBody(),
            label: "baseline arm",
            // Generate-operation profile: an edit profile with zero references has
            // nothing to edit, and its baseline cell would record refused instead.
            profileIds: [GENERATE_PROFILE_ID],
            strategies: ["canonical_only"],
            packVariants: [{ source: "current" }, { source: "none" }],
          },
        }),
        routeCtx(),
      ),
      200,
    );
    expect(created.counts.planned).toBe(2);

    const detail = await expectJson<ImageIdentityPackTrialRunDetail>(
      await trialDetail(apiRequest(trialPath(`/${created.runId}`)), runCtx(created.runId)),
      200,
    );
    const baseline = detail.cells.find((cell) => cell.spec?.packVariantKey === "none");
    // The baseline crosses the wire as the control arm it is: no strategy, no
    // pack identity, no references — not as a cell whose spec failed to load.
    expect(baseline?.spec).toMatchObject({
      identityStrategy: null,
      referenceSource: "none",
      packId: null,
      packRevision: null,
      orderedReferenceRoles: [],
    });
    expect(detail.cells.find((cell) => cell.spec?.packVariantKey === "current")?.spec).toMatchObject({
      identityStrategy: "canonical_only",
      referenceSource: "pack",
    });
  });

  it("executes the planned cells through the renderer seam and settles the run into review", async () => {
    const runId = await createdRunId();
    const pass = await executeRun(runId);
    expect(pass.executed).toHaveLength(2);
    expect(pass.executed.every((cell) => cell.status === "rendered")).toBe(true);
    expect(pass.remainingPlanned).toBe(0);
    expect(pass.runStatus).toBe("review");

    const detail = await expectJson<ImageIdentityPackTrialRunDetail>(
      await trialDetail(apiRequest(trialPath(`/${runId}`)), runCtx(runId)),
      200,
    );
    expect(detail.run.counts).toEqual({ planned: 0, running: 0, rendered: 2, failed: 0, refused: 0 });
    for (const cell of detail.cells) expect(cell.outputImageId).not.toBeNull();
  });

  it("serves one blinded pair, records its grade once, refuses the duplicate, and completes on verdicts", async () => {
    const runId = await createdRunId();
    await executeRun(runId);

    const pair = await nextPairOf(runId);
    expect(pair).not.toBeNull();
    if (!pair) return;
    // The grade below is submitted BEFORE any verdict on purpose: the service's
    // review-completeness gate refuses a ruling over an ungraded pair, so this
    // flow only reaches the verdict handlers because its evidence is complete.
    // Blinded means blinded: image ids and the shared prompt context, and not
    // one strategy-, pack-, or crop-shaped field beside them.
    expect(Object.keys(pair).sort()).toEqual(["leftImageId", "pairId", "promptFixtureId", "rightImageId", "task"]);
    expect(pair.leftImageId).not.toBe(pair.rightImageId);

    const graded = await trialGrade(apiRequest(trialPath(`/${runId}/review`), { body: gradeBody(pair.pairId) }), runCtx(runId));
    expect((await expectJson<{ recorded: boolean }>(graded, 200)).recorded).toBe(true);

    const duplicate = await trialGrade(
      apiRequest(trialPath(`/${runId}/review`), { body: gradeBody(pair.pairId) }),
      runCtx(runId),
    );
    expect((await expectJson<{ error: { code: string } }>(duplicate, 400)).error.code).toBe("grade_conflict");

    expect(await nextPairOf(runId)).toBeNull();

    const summary = await expectJson<ImageIdentityPackTrialSummaryWire>(
      await trialSummary(apiRequest(trialPath(`/${runId}/summary`)), runCtx(runId)),
      200,
    );
    expect(summary.comparisons).toHaveLength(1);
    // The verdict-slot list rides the summary wire: one entry per rendered
    // (profile, strategy), independent of whether a comparison exists for it.
    expect(summary.renderedCombos).toEqual([
      { profileId: PROFILE_ID, identityStrategy: "canonical_only", renderedCells: 1, totalPairs: 1, gradedPairs: 1 },
      { profileId: PROFILE_ID, identityStrategy: "face_detail_only", renderedCells: 1, totalPairs: 1, gradedPairs: 1 },
    ]);
    // Intact evidence, so nothing on this wire asks for an override. The field
    // has to travel even at zero: the client decides whether to OFFER the
    // override from it, and an absent field would parse as an absent decision.
    expect(summary.degradedCells).toBe(0);
    const comparison = summary.comparisons[0];
    if (!comparison) return;
    expect(comparison.gradedPairs).toBe(1);
    expect(comparison.catastrophic.a + comparison.catastrophic.b).toBe(1);

    // A verdict naming a combo no cell of the run carries is a 400 with the
    // stable code, and records nothing.
    const unknownCombo = await trialVerdict(
      apiRequest(trialPath(`/${runId}/verdict`), {
        body: { profileId: "imgprfnotinthisrunaaaaa", identityStrategy: "canonical_only", verdict: "rejected", reason: "typo" },
      }),
      runCtx(runId),
    );
    expect((await expectJson<{ error: { code: string } }>(unknownCombo, 400)).error.code).toBe("verdict_unknown_combo");

    const first = await expectJson<{ runStatus: TrialRunStatus; verdicts: TrialVerdict[] }>(
      await trialVerdict(
        apiRequest(trialPath(`/${runId}/verdict`), {
          body: { profileId: PROFILE_ID, identityStrategy: "canonical_only", verdict: "retained_current", reason: "route test" },
        }),
        runCtx(runId),
      ),
      200,
    );
    expect(first.runStatus).toBe("review");

    const second = await expectJson<{ runStatus: TrialRunStatus; verdicts: TrialVerdict[] }>(
      await trialVerdict(
        apiRequest(trialPath(`/${runId}/verdict`), {
          body: { profileId: PROFILE_ID, identityStrategy: "face_detail_only", verdict: "promoted", reason: "route test" },
        }),
        runCtx(runId),
      ),
      200,
    );
    expect(second.runStatus).toBe("complete");
    expect(second.verdicts).toHaveLength(2);
  });

  it("refuses a verdict as review_incomplete while the run has not been executed", async () => {
    const runId = await createdRunId();

    const res = await trialVerdict(
      apiRequest(trialPath(`/${runId}/verdict`), {
        body: {
          profileId: PROFILE_ID,
          identityStrategy: "canonical_only",
          verdict: "promoted",
          reason: "ruling before any render",
        },
      }),
      runCtx(runId),
    );
    // The same 400 envelope every other trial refusal uses, carrying the stable
    // code — the client tells "not yet reviewable" from "unknown combo" by code.
    expect((await expectJson<{ error: { code: string } }>(res, 400)).error.code).toBe("review_incomplete");

    const summary = await expectJson<ImageIdentityPackTrialSummaryWire>(
      await trialSummary(apiRequest(trialPath(`/${runId}/summary`)), runCtx(runId)),
      200,
    );
    expect(summary.verdicts).toEqual([]);
  });

  it("refuses a verdict over an ungraded pair and accepts it with an explicit override", async () => {
    const runId = await createdRunId();
    await executeRun(runId);

    const body = {
      profileId: PROFILE_ID,
      identityStrategy: "canonical_only",
      verdict: "promoted",
      reason: "ruling before the pair is graded",
    };
    const refused = await trialVerdict(apiRequest(trialPath(`/${runId}/verdict`), { body }), runCtx(runId));
    expect((await expectJson<{ error: { code: string } }>(refused, 400)).error.code).toBe("review_incomplete");

    const overridden = await expectJson<{ runStatus: TrialRunStatus; verdicts: TrialVerdict[] }>(
      await trialVerdict(
        apiRequest(trialPath(`/${runId}/verdict`), { body: { ...body, overrideIncompleteReview: true } }),
        runCtx(runId),
      ),
      200,
    );
    // The override is echoed on the ruling the route hands straight back, so the
    // summary screen shows the decision was made on partial evidence.
    expect(overridden.verdicts).toHaveLength(1);
    expect(overridden.verdicts[0]?.overrideIncompleteReview).toBe(true);
    // One slot ruled, one pair ungraded: the run does not complete.
    expect(overridden.runStatus).toBe("review");

    // And it is PERSISTED, not just echoed: whether the evidence was complete at
    // decision time is unrecoverable once the missing grades arrive, so a later
    // read of the ledger has to carry the flag too.
    const summary = await expectJson<ImageIdentityPackTrialSummaryWire>(
      await trialSummary(apiRequest(trialPath(`/${runId}/summary`)), runCtx(runId)),
      200,
    );
    expect(summary.verdicts.map((verdict) => verdict.overrideIncompleteReview)).toEqual([true]);
  });

  it("answers 200 with the cells settled failed when the renderer throws mid-batch", async () => {
    const runId = await createdRunId();
    setTrialRendererForTesting(() => Promise.reject(new Error("provider exploded")));

    // The throw is contained per cell: no 500, both cells settle `failed`, and
    // nothing is left `planned` for a next pass to double-spend on.
    const res = await trialExecute(apiRequest(trialPath(`/${runId}/execute`), { body: { maxRenders: 20 } }), runCtx(runId));
    const pass = await expectJson<{ executed: { status: string }[]; remainingPlanned: number }>(res, 200);
    expect(pass.executed.map((cell) => cell.status)).toEqual(["failed", "failed"]);
    expect(pass.remainingPlanned).toBe(0);

    const detail = await expectJson<ImageIdentityPackTrialRunDetail>(
      await trialDetail(apiRequest(trialPath(`/${runId}`)), runCtx(runId)),
      200,
    );
    expect(detail.run.counts).toEqual({ planned: 0, running: 0, rendered: 0, failed: 2, refused: 0 });
    for (const cell of detail.cells) expect(cell.result?.failureCode).toBe("other");
  });

  it("deletes a run and reports the swept outputs, leaving nothing to read back", async () => {
    const runId = await createdRunId();
    await executeRun(runId);

    const removed = await expectJson<{ deleted: boolean; outputImagesRemoved: number }>(
      await trialDelete(apiRequest(trialPath(`/${runId}`), { method: "DELETE" }), runCtx(runId)),
      200,
    );
    expect(removed).toEqual({ deleted: true, outputImagesRemoved: 2 });

    const gone = await trialDetail(apiRequest(trialPath(`/${runId}`)), runCtx(runId));
    expect(gone.status).toBe(404);
  });
});
