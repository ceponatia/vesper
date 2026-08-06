import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  images,
} from "@/server/db";
import { isUniqueViolation } from "@/server/api";
import {
  canonicalImageRow,
  endTestPool,
  probeIntegrationDb,
  purgeOwnerRows,
  seedTestUser,
} from "@/server/test-support";

/**
 * The identity-pack trial tables' constraints against a migrated database
 * (image-identity-packs.spec.trial.md). These are the guarantees the trial
 * service is allowed to ASSUME rather than re-check, so nothing short of a real
 * Postgres can prove them:
 *
 * 1. a cell key is used once per run (the plan expansion's idempotency anchor —
 *    a re-created plan collides instead of duplicating a cell);
 * 2. a pair is graded once per run — a double submission fails loudly
 *    (`grade_conflict`) instead of silently averaging two opinions;
 * 3. deleting a run takes its cells and grades with it, so the delete sweep
 *    only has output images and files left to clean;
 * 4. deleting an output image NULLs the cell's pointer instead of blocking or
 *    cascading — the cell survives as the record of a render whose evidence is
 *    gone, mirroring the pack's own image pointers.
 */

const ready = await probeIntegrationDb("identity pack trial schema.int.test", "image_identity_pack_trial_runs");

let ownerId = "";

async function insertRun(
  over: Partial<typeof imageIdentityPackTrialRuns.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(imageIdentityPackTrialRuns)
    .values({ ownerId, label: "trial", configJson: {}, ...over })
    .returning({ id: imageIdentityPackTrialRuns.id });
  if (!row) throw new Error("[identity-pack-trial-schema] inserting a run returned no row");
  return row.id;
}

async function insertCell(
  runId: string,
  cellKey: string,
  over: Partial<typeof imageIdentityPackTrialCells.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(imageIdentityPackTrialCells)
    .values({ runId, cellKey, specJson: {}, ...over })
    .returning({ id: imageIdentityPackTrialCells.id });
  if (!row) throw new Error("[identity-pack-trial-schema] inserting a cell returned no row");
  return row.id;
}

async function insertGrade(
  runId: string,
  pairId: string,
  cellAId: string,
  cellBId: string,
  over: Partial<typeof imageIdentityPackTrialGrades.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(imageIdentityPackTrialGrades)
    .values({ runId, pairId, cellAId, cellBId, leftIsA: true, gradesJson: {}, reviewedByUserId: ownerId, ...over })
    .returning({ id: imageIdentityPackTrialGrades.id });
  if (!row) throw new Error("[identity-pack-trial-schema] inserting a grade returned no row");
  return row.id;
}

/** Only the id the cell's FK points at matters here — no file is written. */
async function seedImage(): Promise<string> {
  const [row] = await db()
    .insert(images)
    .values(canonicalImageRow({ ownerId, kind: "identity_trial_output" as const, status: "ready" as const }))
    .returning({ id: images.id });
  if (!row) throw new Error("[identity-pack-trial-schema] seeding image inserted no row");
  return row.id;
}

async function cellIds(runId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityPackTrialCells.id })
    .from(imageIdentityPackTrialCells)
    .where(eq(imageIdentityPackTrialCells.runId, runId));
  return rows.map((row) => row.id);
}

async function gradeIds(runId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityPackTrialGrades.id })
    .from(imageIdentityPackTrialGrades)
    .where(eq(imageIdentityPackTrialGrades.runId, runId));
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  if (!ready) return;
  ownerId = (await seedTestUser("identity-pack-trial-schema")).id;
});

afterAll(async () => {
  await purgeOwnerRows([ownerId]);
  await endTestPool();
});

describe.skipIf(!ready)("identity pack trial table constraints", () => {
  it("uses a cell key once per run", async () => {
    const runId = await insertRun();
    await insertCell(runId, "char:profile:full_pack:fixture");

    await expect(insertCell(runId, "char:profile:full_pack:fixture")).rejects.toSatisfy(
      isUniqueViolation,
      "a repeated cell key within a run must fail with a unique violation",
    );

    // The same key under a different run is not a collision — the unique is
    // scoped per run, which is what lets two runs share one plan grid.
    const otherRunId = await insertRun({ label: "trial-other" });
    await insertCell(otherRunId, "char:profile:full_pack:fixture");
    expect(await cellIds(otherRunId)).toHaveLength(1);
  });

  it("grades a pair once per run", async () => {
    const runId = await insertRun();
    const cellAId = await insertCell(runId, "cell-a");
    const cellBId = await insertCell(runId, "cell-b");
    const pairId = [cellAId, cellBId].sort().join(":");
    await insertGrade(runId, pairId, cellAId, cellBId);

    await expect(insertGrade(runId, pairId, cellAId, cellBId, { leftIsA: false })).rejects.toSatisfy(
      isUniqueViolation,
      "a second grade for the same pair must fail with a unique violation",
    );

    // Scoped per run: another run may grade a pair under the same id.
    const otherRunId = await insertRun({ label: "trial-other-grade" });
    const otherAId = await insertCell(otherRunId, "cell-a");
    const otherBId = await insertCell(otherRunId, "cell-b");
    await insertGrade(otherRunId, pairId, otherAId, otherBId);
    expect(await gradeIds(otherRunId)).toHaveLength(1);
  });

  it("deletes a run's cells and grades with the run", async () => {
    const runId = await insertRun();
    const cellAId = await insertCell(runId, "cascade-a");
    const cellBId = await insertCell(runId, "cascade-b");
    await insertGrade(runId, [cellAId, cellBId].sort().join(":"), cellAId, cellBId);

    await db().delete(imageIdentityPackTrialRuns).where(eq(imageIdentityPackTrialRuns.id, runId));

    expect(await cellIds(runId)).toEqual([]);
    expect(await gradeIds(runId)).toEqual([]);
  });

  it("nulls the output pointer when its image is deleted", async () => {
    const runId = await insertRun();
    const outputImageId = await seedImage();
    const cellId = await insertCell(runId, "set-null", { status: "rendered", outputImageId });

    await db().delete(images).where(eq(images.id, outputImageId));

    // The cell SURVIVES its output: it stays as the record of a render whose
    // evidence is gone, rather than vanishing with the bytes.
    const [after] = await db()
      .select({ outputImageId: imageIdentityPackTrialCells.outputImageId })
      .from(imageIdentityPackTrialCells)
      .where(eq(imageIdentityPackTrialCells.id, cellId));
    expect(after?.outputImageId).toBeNull();
  });
});
