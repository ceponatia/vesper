import { and, eq, or, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  materialBranchSeedSchema,
  transferItemCommandSchema,
  type MaterialBranchSeed,
  type TransferItemCommand,
} from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import { escalateToTimeJob, runDueTimeJobs, runSkipWithEscalation } from "@/server/engine";
import { db, simTimeJobs, simWorlds } from "@/server/db";
import { seedDurableMaterialBranch } from "./material-store";
import { scheduleDurableTrigger } from "./scheduler-store";
import { seedDurableSpaceTopology } from "./space-store";
import {
  claimDueTimeJob,
  enqueueTimeJob,
  hasActiveTimeJob,
  readTimeJobForChat,
  runClaimedTimeJob,
} from "./time-job-store";

/**
 * Concurrency validation for the durable time-job store (drain-hardening A5 slice 4). These are
 * the tests that had to run against a real Postgres — the whole point of building this slice with
 * a DB up: the partial unique index (one active job per branch), the lease/fence (a stale worker
 * can't overwrite live work), reclaim-after-expiry, and the drain-to-completion outcome.
 */

const SEED_STORY_SECOND = 57_600;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_time_jobs limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") throw error;
    process.stderr.write(
      `[time-job-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const seededWorldIds: string[] = [];

interface CaseIds {
  worldId: string;
  branchId: string;
  chatId: string;
  actorId: string;
  locationId: string;
  zoneId: string;
  sourceId: string;
  destinationId: string;
  itemIds: string[];
}

function makeIds(itemCount = 1): CaseIds {
  const worldId = newId();
  const branchId = newId();
  return {
    worldId,
    branchId,
    chatId: newId(),
    actorId: newId(),
    locationId: `${worldId}-loc-cafe`,
    zoneId: `${branchId}-zone-hall`,
    sourceId: newId(),
    destinationId: newId(),
    itemIds: Array.from({ length: itemCount }, () => newId()),
  };
}

function branchSeed(ids: CaseIds): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "time-job-test-world",
    worldSeed: "0011223344556677",
    branchId: ids.branchId,
    rulesetVersion: "time-job-test-v1",
    originStorySecond: SEED_STORY_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    items: [
      {
        id: ids.sourceId,
        name: "Mara's bag",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      {
        id: ids.destinationId,
        name: "the cafe table",
        container: { capacityCount: 8, access: { kind: "holder_only" } },
        locus: { kind: "held", actorId: ids.actorId },
      },
      ...ids.itemIds.map((id, index) => ({
        id,
        name: index === 0 ? "gold ring" : `test item ${index + 1}`,
        locus: { kind: "container" as const, containerItemId: ids.sourceId },
      })),
    ],
  });
}

function topologySeed(ids: CaseIds) {
  return {
    branchId: ids.branchId,
    locations: [{ id: ids.locationId, worldId: ids.worldId, kind: "cafe", defaultAccessPolicy: "public" as const }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "hall", privacyPolicy: "public" as const }],
    links: [],
    loci: [{ kind: "at" as const, actorId: ids.actorId, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_STORY_SECOND }],
  };
}

function command(ids: CaseIds, itemId: string): TransferItemCommand {
  return transferItemCommandSchema.parse({
    id: newId(),
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: newId(),
    principal: { kind: "system", principalId: newId(), controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-23T16:00:00.000Z",
    type: "transfer_item",
    schemaVersion: 2,
    correlationId: newId(),
    payload: {
      actorId: ids.actorId,
      itemId,
      fromLocus: { kind: "container", containerItemId: ids.sourceId },
      toLocus: { kind: "container", containerItemId: ids.destinationId },
    },
  });
}

async function seedCase(ids: CaseIds): Promise<void> {
  if (!seededWorldIds.includes(ids.worldId)) seededWorldIds.push(ids.worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology(topologySeed(ids));
}

function scheduleAt(ids: CaseIds, dueStorySecond: number, uniquenessKey: string, itemId: string) {
  return scheduleDurableTrigger({
    worldId: ids.worldId,
    branchId: ids.branchId,
    kind: "scheduled_transfer_item",
    schemaVersion: 1,
    dueStorySecond,
    uniquenessKey,
    payload: { command: command(ids, itemId) },
  });
}

function enqueueFor(ids: CaseIds, targetStorySecond: number, reachedStorySecond = SEED_STORY_SECOND) {
  return enqueueTimeJob({ worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond, reachedStorySecond });
}

async function activeJobCount(branchId: string): Promise<number> {
  const rows = await db()
    .select({ id: simTimeJobs.id })
    .from(simTimeJobs)
    .where(and(eq(simTimeJobs.branchId, branchId), or(eq(simTimeJobs.state, "pending"), eq(simTimeJobs.state, "processing"))));
  return rows.length;
}

afterEach(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  for (const worldId of seededWorldIds.splice(0)) {
    await db().delete(simWorlds).where(eq(simWorlds.id, worldId));
  }
});

afterAll(async () => {
  await globalThis.__vesperPool?.end();
});

describe.skipIf(!ready)("durable time jobs", () => {
  it("enqueues one job per branch — a repeat enqueue returns the same job, bumping the target", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const first = await enqueueFor(ids, SEED_STORY_SECOND + 600);
    expect(first.created).toBe(true);

    // A repeat for the SAME branch keeps the existing job (never a second active row).
    const again = await enqueueFor(ids, SEED_STORY_SECOND + 1200);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);
    expect(await activeJobCount(ids.branchId)).toBe(1);

    // The target advanced to the further second.
    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, first.id));
    expect(row?.targetStorySecond).toBe(SEED_STORY_SECOND + 1200);
  });

  it("keeps exactly one active job under a concurrent enqueue race (the partial unique index)", async () => {
    const ids = makeIds();
    await seedCase(ids);

    const results = await Promise.all([
      enqueueFor(ids, SEED_STORY_SECOND + 600),
      enqueueFor(ids, SEED_STORY_SECOND + 600),
      enqueueFor(ids, SEED_STORY_SECOND + 600),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await activeJobCount(ids.branchId)).toBe(1);
  });

  it("claims a due job with a lease and drains it to completion, stamping progress", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "t200", ids.itemIds[1]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    expect(job).not.toBeNull();
    expect(job?.state).toBe("processing");
    expect(job?.attempts).toBe(1);

    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(result.terminalFailures).toBe(0);

    const [row] = await db().select().from(simTimeJobs).where(eq(simTimeJobs.id, job!.id));
    expect(row?.state).toBe("completed");
    expect(row?.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(row?.leaseOwner).toBeNull();
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);
  });

  it("a fenced write cannot land after another worker takes the job over (lease_lost)", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    expect(job).not.toBeNull();
    // Simulate worker B stealing the job (e.g. after worker_a's lease expired and B reclaimed):
    // the row's lease_owner is now B, so worker_a's fenced writes must all fail.
    await db()
      .update(simTimeJobs)
      .set({ leaseOwner: "worker_b", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(simTimeJobs.id, job!.id));

    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("lease_lost");
    // Worker B still owns it; worker_a never completed it.
    const [row] = await db().select({ state: simTimeJobs.state, leaseOwner: simTimeJobs.leaseOwner }).from(simTimeJobs).where(eq(simTimeJobs.id, job!.id));
    expect(row?.state).toBe("processing");
    expect(row?.leaseOwner).toBe("worker_b");
  });

  it("reclaims a job whose lease has expired, incrementing attempts", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const enq = await enqueueFor(ids, SEED_STORY_SECOND + 300);
    // A crashed worker left the job processing with an expired lease.
    await db()
      .update(simTimeJobs)
      .set({ state: "processing", attempts: 1, leaseOwner: "dead_worker", leaseExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(simTimeJobs.id, enq.id));

    const reclaimed = await claimDueTimeJob("worker_b");
    expect(reclaimed?.id).toBe(enq.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("does not claim a job whose lease is still valid", async () => {
    const ids = makeIds();
    await seedCase(ids);
    const enq = await enqueueFor(ids, SEED_STORY_SECOND + 300);
    await db()
      .update(simTimeJobs)
      .set({ state: "processing", leaseOwner: "worker_a", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(simTimeJobs.id, enq.id));

    expect(await claimDueTimeJob("worker_b")).toBeNull();
  });

  it("completes past a poison trigger and surfaces it as a terminal failure", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    // A poison trigger (missing item → rejected → failed) at +100, a healthy one at +200.
    await scheduleDurableTrigger({
      worldId: ids.worldId,
      branchId: ids.branchId,
      kind: "scheduled_transfer_item",
      schemaVersion: 1,
      dueStorySecond: SEED_STORY_SECOND + 100,
      uniquenessKey: "poison",
      payload: { command: command(ids, newId()) },
    });
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "healthy", ids.itemIds[0]!);
    await enqueueFor(ids, SEED_STORY_SECOND + 300);

    const job = await claimDueTimeJob("worker_a");
    const result = await runClaimedTimeJob(job!, "worker_a");
    expect(result.outcome).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(result.terminalFailures).toBe(1);
  });

  it("reports a chat's job status for the catch-up UI", async () => {
    const ids = makeIds();
    await seedCase(ids);
    await enqueueFor(ids, SEED_STORY_SECOND + 900, SEED_STORY_SECOND + 100);
    const status = await readTimeJobForChat(ids.chatId);
    expect(status).toMatchObject({ state: "pending", targetStorySecond: SEED_STORY_SECOND + 900, reachedStorySecond: SEED_STORY_SECOND + 100 });
  });

  it("runSkipWithEscalation finishes a short skip in-request (no job left behind)", async () => {
    const ids = makeIds(1);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);

    const result = await runSkipWithEscalation(
      { worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond: SEED_STORY_SECOND + 300 },
      { kick: false },
    );
    expect(result.status).toBe("completed");
    expect(result.reachedStorySecond).toBe(SEED_STORY_SECOND + 300);
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);
  });

  it("escalateToTimeJob + the sweep drain a job to completion offline (server owns completion)", async () => {
    const ids = makeIds(2);
    await seedCase(ids);
    await scheduleAt(ids, SEED_STORY_SECOND + 100, "t100", ids.itemIds[0]!);
    await scheduleAt(ids, SEED_STORY_SECOND + 200, "t200", ids.itemIds[1]!);

    await escalateToTimeJob(
      { worldId: ids.worldId, branchId: ids.branchId, chatId: ids.chatId, targetStorySecond: SEED_STORY_SECOND + 300, reachedStorySecond: SEED_STORY_SECOND },
      { kick: false },
    );
    expect(await hasActiveTimeJob(ids.branchId)).toBe(true);

    const processed = await runDueTimeJobs("sweep_worker");
    expect(processed).toBe(1);
    expect(await hasActiveTimeJob(ids.branchId)).toBe(false);

    const status = await readTimeJobForChat(ids.chatId);
    expect(status).toMatchObject({ state: "completed", reachedStorySecond: SEED_STORY_SECOND + 300 });
  });
});
