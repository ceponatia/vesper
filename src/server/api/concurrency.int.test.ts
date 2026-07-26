import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activeJobCount, claimJobSlot, JOB_SLOT_STALE_MS, MAX_CONCURRENT_JOBS_PER_USER } from "./concurrency";
import { db, jobs, users } from "@/server/db";
import { probeIntegrationDb } from "@/server/test-support";

// Integration suite for the per-user concurrency cap (rate-limits.plan.md slice
// 5). The cap is enforced by a conditional INSERT rather than a read-then-write,
// so the case that matters is parallel submits — which only a real database can
// exercise.

const ready = await probeIntegrationDb("concurrency.int.test", "jobs");

let ownerA: string;
let ownerB: string;

async function clearJobs(): Promise<void> {
  const owners = [ownerA, ownerB].filter(Boolean);
  if (owners.length > 0) await db().delete(jobs).where(inArray(jobs.ownerId, owners));
}

afterAll(async () => {
  if (ready) {
    await clearJobs();
    const owners = [ownerA, ownerB].filter(Boolean);
    if (owners.length > 0) await db().delete(users).where(inArray(users.id, owners));
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("per-user job concurrency cap", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    const [a] = await db().insert(users).values({ email: `conc-a-${stamp}@test.local`, name: "Conc A" }).returning({ id: users.id });
    const [b] = await db().insert(users).values({ email: `conc-b-${stamp}@test.local`, name: "Conc B" }).returning({ id: users.id });
    if (!a || !b) throw new Error("user insert failed");
    ownerA = a.id;
    ownerB = b.id;
  });

  beforeEach(clearJobs);

  const claim = (ownerId: string) => claimJobSlot({ ownerId, type: "entity_image", payload: { probe: true } });

  it("admits work up to the cap", async () => {
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_USER; i++) {
      expect((await claim(ownerA)).ok).toBe(true);
    }
    expect(await activeJobCount(ownerA)).toBe(MAX_CONCURRENT_JOBS_PER_USER);
  });

  it("refuses the next claim, reporting the active count and the cap", async () => {
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_USER; i++) await claim(ownerA);
    const refused = await claim(ownerA);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.active).toBe(MAX_CONCURRENT_JOBS_PER_USER);
      expect(refused.limit).toBe(MAX_CONCURRENT_JOBS_PER_USER);
    }
  });

  it("writes no row when a claim is refused", async () => {
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_USER + 5; i++) await claim(ownerA);
    expect(await activeJobCount(ownerA)).toBe(MAX_CONCURRENT_JOBS_PER_USER);
  });

  it("isolates owners — one account saturating the queue does not block another", async () => {
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_USER; i++) await claim(ownerA);
    expect((await claim(ownerA)).ok).toBe(false);
    expect((await claim(ownerB)).ok).toBe(true);
  });

  it("holds the cap under parallel submits — the race a read-then-write would lose", async () => {
    const attempts = MAX_CONCURRENT_JOBS_PER_USER * 5;
    const results = await Promise.all(Array.from({ length: attempts }, () => claim(ownerA)));
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_CONCURRENT_JOBS_PER_USER);
    expect(await activeJobCount(ownerA)).toBe(MAX_CONCURRENT_JOBS_PER_USER);
  });

  it("frees a slot when work finishes", async () => {
    const first = await claim(ownerA);
    for (let i = 1; i < MAX_CONCURRENT_JOBS_PER_USER; i++) await claim(ownerA);
    expect((await claim(ownerA)).ok).toBe(false);

    if (first.ok) {
      await db().update(jobs).set({ status: "done", finishedAt: new Date() }).where(eq(jobs.id, first.jobId));
    }
    expect((await claim(ownerA)).ok).toBe(true);
  });

  it("does not count a job orphaned by a crash forever", async () => {
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_USER; i++) await claim(ownerA);
    expect((await claim(ownerA)).ok).toBe(false);

    // Age every row past the staleness window, as a crashed runner would leave them.
    await db()
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - JOB_SLOT_STALE_MS - 60_000) })
      .where(eq(jobs.ownerId, ownerA));

    expect(await activeJobCount(ownerA)).toBe(0);
    expect((await claim(ownerA)).ok).toBe(true);
  });

  it("stores the owner and payload it was given", async () => {
    const claimed = await claim(ownerA);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const [row] = await db().select().from(jobs).where(eq(jobs.id, claimed.jobId));
    expect(row?.ownerId).toBe(ownerA);
    expect(row?.status).toBe("running");
    expect(row?.type).toBe("entity_image");
    expect(row?.payload).toEqual({ probe: true });
  });

  it("leaves ownerless system jobs uncapped", async () => {
    // Engine/system work carries no owner and must not be throttled by, or
    // count against, any account's cap.
    await db().insert(jobs).values(
      Array.from({ length: MAX_CONCURRENT_JOBS_PER_USER + 3 }, () => ({
        type: "image_sweep" as const,
        status: "running" as const,
        payload: {},
      })),
    );
    expect((await claim(ownerA)).ok).toBe(true);
    await db().delete(jobs).where(sql`"jobs"."owner_id" is null and "jobs"."type" = 'image_sweep'`);
  });
});
