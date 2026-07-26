import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkStorageQuota, consumeDailyBudget, dailyBudget, readDailyUsage, utcDayKey } from "./quota";
import { db, images, usageCounters, users } from "@/server/db";
import { newId } from "@/lib/ids";
import { probeIntegrationDb } from "@/server/test-support";

// Integration suite for the durable half of rate-limits.plan.md: the counter
// upsert's atomicity and conditional increment, the UTC-day reset boundary, and
// the derived per-owner storage quota. Self-skips when the database is
// unreachable, except under strict mode (`pnpm test:int:strict`).

const ready = await probeIntegrationDb("quota.int.test", "usage_counters");

let ownerA: string;
let ownerB: string;

afterAll(async () => {
  if (ready) {
    const owners = [ownerA, ownerB].filter(Boolean);
    if (owners.length > 0) {
      await db().delete(images).where(inArray(images.ownerId, owners));
      await db().delete(usageCounters).where(inArray(usageCounters.ownerId, owners));
      await db().delete(users).where(inArray(users.id, owners));
    }
  }
  await globalThis.__vesperPool?.end();
  globalThis.__vesperPool = undefined;
});

describe.skipIf(!ready)("durable usage counters", () => {
  beforeAll(async () => {
    const stamp = Date.now();
    const [a] = await db().insert(users).values({ email: `quota-a-${stamp}@test.local`, name: "Quota A" }).returning({ id: users.id });
    const [b] = await db().insert(users).values({ email: `quota-b-${stamp}@test.local`, name: "Quota B" }).returning({ id: users.id });
    if (!a || !b) throw new Error("user insert failed");
    ownerA = a.id;
    ownerB = b.id;
  });

  it("accumulates across calls within one UTC day", async () => {
    await consumeDailyBudget(ownerA, "provider_text_day", 3);
    await consumeDailyBudget(ownerA, "provider_text_day", 4);
    const usage = await readDailyUsage(ownerA, "provider_text_day");
    expect(usage.used).toBe(7);
    expect(usage.remaining).toBe(dailyBudget("provider_text_day") - 7);
  });

  it("isolates owners", async () => {
    await consumeDailyBudget(ownerB, "provider_text_day", 2);
    expect((await readDailyUsage(ownerA, "provider_text_day")).used).toBe(7);
    expect((await readDailyUsage(ownerB, "provider_text_day")).used).toBe(2);
  });

  it("isolates counter kinds", async () => {
    expect((await readDailyUsage(ownerA, "provider_image_day")).used).toBe(0);
  });

  it("denies once the ceiling is reached, and does not increment on denial", async () => {
    const limit = dailyBudget("provider_image_day");
    const allowed = await consumeDailyBudget(ownerA, "provider_image_day", limit);
    expect(allowed.allowed).toBe(true);
    expect(allowed.used).toBe(limit);

    const denied = await consumeDailyBudget(ownerA, "provider_image_day", 1);
    expect(denied.allowed).toBe(false);
    expect(denied.used).toBe(limit);
    expect(denied.remaining).toBe(0);

    // The refused unit must not have been banked — repeatedly hitting a closed
    // budget cannot push the counter past its ceiling.
    for (let i = 0; i < 5; i++) await consumeDailyBudget(ownerA, "provider_image_day", 1);
    expect((await readDailyUsage(ownerA, "provider_image_day")).used).toBe(limit);
  });

  it("refuses a single request larger than the whole budget without recording it", async () => {
    const limit = dailyBudget("upload_bytes_day");
    const denied = await consumeDailyBudget(ownerB, "upload_bytes_day", limit + 1);
    expect(denied.allowed).toBe(false);
    expect((await readDailyUsage(ownerB, "upload_bytes_day")).used).toBe(0);
  });

  it("loses no increments under concurrency", async () => {
    const parallel = 25;
    const results = await Promise.all(
      Array.from({ length: parallel }, () => consumeDailyBudget(ownerB, "provider_embed_day", 1)),
    );
    expect(results.every((r) => r.allowed)).toBe(true);
    // The whole point of the single-statement upsert: no lost updates.
    expect((await readDailyUsage(ownerB, "provider_embed_day")).used).toBe(parallel);
  });

  it("admits exactly the remaining budget when many callers race the ceiling", async () => {
    const limit = dailyBudget("provider_image_day");
    const results = await Promise.all(
      Array.from({ length: limit + 10 }, () => consumeDailyBudget(ownerB, "provider_image_day", 1)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    expect((await readDailyUsage(ownerB, "provider_image_day")).used).toBe(limit);
  });

  describe("reset boundary", () => {
    it("keys separate rows per UTC day, so a new day starts clean", async () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      await consumeDailyBudget(ownerA, "provider_embed_day", 5);
      expect((await readDailyUsage(ownerA, "provider_embed_day")).used).toBe(5);
      expect((await readDailyUsage(ownerA, "provider_embed_day", tomorrow)).used).toBe(0);

      const rows = await db()
        .select({ window: usageCounters.windowStart })
        .from(usageCounters)
        .where(eq(usageCounters.ownerId, ownerA));
      expect(rows.some((r) => r.window === utcDayKey())).toBe(true);
    });

    it("advertises the UTC-midnight reset on a denial", async () => {
      const limit = dailyBudget("provider_image_day");
      await consumeDailyBudget(ownerA, "provider_image_day", limit);
      const denied = await consumeDailyBudget(ownerA, "provider_image_day", 1);
      expect(denied.allowed).toBe(false);
      expect(new Date(denied.resetAt).toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
      expect(denied.resetAt).toBeGreaterThan(Date.now());
    });
  });
});

describe.skipIf(!ready)("storage quota", () => {
  it("reports zero for an owner with no images", async () => {
    const quota = await checkStorageQuota(ownerA);
    expect(quota.used).toBe(0);
    expect(quota.allowed).toBe(true);
    expect(quota.remaining).toBe(quota.limit);
  });

  it("sums stored bytes per owner and isolates owners", async () => {
    // `images_path_canonical` (the security-authz hardening CHECK) requires the
    // path to be exactly images/<owner>/<id>.webp, so fixtures build it.
    const row = (ownerId: string, bytes: number) => {
      const id = newId();
      return { id, ownerId, kind: "avatar" as const, path: `images/${ownerId}/${id}.webp`, bytes, status: "ready" as const };
    };
    await db().insert(images).values([row(ownerA, 1000), row(ownerA, 2500), row(ownerB, 700)]);
    expect((await checkStorageQuota(ownerA)).used).toBe(3500);
    expect((await checkStorageQuota(ownerB)).used).toBe(700);
  });

  it("refuses a write that would cross the ceiling", async () => {
    const { limit, used } = await checkStorageQuota(ownerA);
    expect((await checkStorageQuota(ownerA, limit - used)).allowed).toBe(true);
    expect((await checkStorageQuota(ownerA, limit - used + 1)).allowed).toBe(false);
  });

  it("reclaims quota when images are deleted — the sum cannot drift", async () => {
    const before = await checkStorageQuota(ownerA);
    await db().delete(images).where(eq(images.ownerId, ownerA));
    const after = await checkStorageQuota(ownerA);
    expect(before.used).toBe(3500);
    expect(after.used).toBe(0);
  });
});
