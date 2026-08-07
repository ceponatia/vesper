import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentityReferenceStrategy } from "@/contracts";
import { newId } from "@/lib/ids";
import {
  db,
  imageIdentityPackTrialCells,
  imageIdentityPackTrialGrades,
  imageIdentityPackTrialRuns,
  imageIdentityPackTrialVerdicts,
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
 * 3. a (profile, strategy) is ruled once per run — the unique key that turns
 *    verdict recording into a single-row upsert, which is what makes two admins
 *    ruling on two different slots at once safe;
 * 4. deleting a run takes its cells, grades and verdicts with it, so the delete
 *    sweep only has output images and files left to clean;
 * 5. deleting an output image NULLs the cell's pointer instead of blocking or
 *    cascading — the cell survives as the record of a render whose evidence is
 *    gone, mirroring the pack's own image pointers;
 * 6. a cell can hold the durable execution claim (`running` plus its token and
 *    stamp), and those columns stay null on a cell no pass has taken.
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

/** The id is supplied by the caller: the verdict table has no `$defaultFn`,
 * because the service's upsert must name the id its insert half would use. */
async function insertVerdict(
  runId: string,
  profileId: string,
  identityStrategy: IdentityReferenceStrategy,
  over: Partial<typeof imageIdentityPackTrialVerdicts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db()
    .insert(imageIdentityPackTrialVerdicts)
    .values({
      id: newId(),
      runId,
      profileId,
      identityStrategy,
      verdict: "promoted",
      reason: "schema fixture",
      policyVersion: "policy_v1",
      decidedByUserId: ownerId,
      decidedAt: new Date(),
      ...over,
    })
    .returning({ id: imageIdentityPackTrialVerdicts.id });
  if (!row) throw new Error("[identity-pack-trial-schema] inserting a verdict returned no row");
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

async function verdictIds(runId: string): Promise<string[]> {
  const rows = await db()
    .select({ id: imageIdentityPackTrialVerdicts.id })
    .from(imageIdentityPackTrialVerdicts)
    .where(eq(imageIdentityPackTrialVerdicts.runId, runId));
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

  it("rules a (profile, strategy) once per run", async () => {
    const runId = await insertRun();
    const profileId = "imgprfschemaverdictaaaa";
    await insertVerdict(runId, profileId, "canonical_only");

    // The item-9 constraint: a second row for the same slot cannot exist, which
    // is what lets the service upsert instead of read-modify-write a whole
    // verdict array (and lose a concurrent ruling doing it).
    await expect(insertVerdict(runId, profileId, "canonical_only", { verdict: "rejected" })).rejects.toSatisfy(
      isUniqueViolation,
      "a second verdict for the same (run, profile, strategy) must fail with a unique violation",
    );

    // A different STRATEGY under the same profile is a different slot and
    // inserts cleanly — the two rulings are independent facts.
    await insertVerdict(runId, profileId, "face_detail_only");
    expect(await verdictIds(runId)).toHaveLength(2);

    // Scoped per run, like the cell and grade uniques: another run may rule the
    // same slot without colliding.
    const otherRunId = await insertRun({ label: "trial-other-verdict" });
    await insertVerdict(otherRunId, profileId, "canonical_only");
    expect(await verdictIds(otherRunId)).toHaveLength(1);
  });

  it("deletes a run's cells, grades and verdicts with the run", async () => {
    const runId = await insertRun();
    const cellAId = await insertCell(runId, "cascade-a");
    const cellBId = await insertCell(runId, "cascade-b");
    await insertGrade(runId, [cellAId, cellBId].sort().join(":"), cellAId, cellBId);
    await insertVerdict(runId, "imgprfschemacascadeaaaa", "canonical_only");

    await db().delete(imageIdentityPackTrialRuns).where(eq(imageIdentityPackTrialRuns.id, runId));

    expect(await cellIds(runId)).toEqual([]);
    expect(await gradeIds(runId)).toEqual([]);
    // The verdict ledger cannot outlive its trial: it cascaded for free while it
    // lived in the run row's jsonb, and only the FK keeps that true now.
    expect(await verdictIds(runId)).toEqual([]);
  });

  it("stores the durable execution claim on a running cell and leaves it null on a planned one", async () => {
    const runId = await insertRun();
    const claimedAt = new Date();
    await insertCell(runId, "claimed", { status: "running", claimToken: "claim-token-1", claimedAt });
    await insertCell(runId, "unclaimed");

    const rows = await db()
      .select()
      .from(imageIdentityPackTrialCells)
      .where(eq(imageIdentityPackTrialCells.runId, runId));
    const claimed = rows.find((row) => row.cellKey === "claimed");
    const unclaimed = rows.find((row) => row.cellKey === "unclaimed");

    // `running` is a real, persisted cell status — the claim is visible to every
    // process, not only to the pass that took it.
    expect(claimed?.status).toBe("running");
    expect(claimed?.claimToken).toBe("claim-token-1");
    expect(claimed?.claimedAt?.getTime()).toBe(claimedAt.getTime());

    // Nullable by design: a cell nobody has claimed carries no token and no
    // stamp, so "claimed" is never inferred from a default.
    expect(unclaimed?.status).toBe("planned");
    expect(unclaimed?.claimToken).toBeNull();
    expect(unclaimed?.claimedAt).toBeNull();
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
