import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasLiveChatJob, JOB_STALE_MS } from "./job-liveness";
import { db, jobs } from "@/server/db";
import { queueDepth } from "../api/backpressure";
import { endTestPool, probeIntegrationDb, purgeOwnerRows, seedTestUser } from "@/server/test-support";

// Integration suite for the one-live-per-chat dedupe. The behavior that matters
// is the STALENESS bound (owner report 2026-08-02): a Fly deploy killed a
// `chat_scene_image` job mid-render, its row stayed `running` forever, and the
// unbounded dedupe refused every later render in that chat — a spinner that
// could never finish. Only a real database exercises the age predicate.

const ready = await probeIntegrationDb("job-liveness.int.test", "jobs");

let owner = "";
const CHAT = "job-liveness-chat";

async function clearJobs(): Promise<void> {
  if (owner) await db().delete(jobs).where(inArray(jobs.ownerId, [owner]));
}

/** Insert a `running` job whose last heartbeat was `ageMs` ago. */
async function insertRunning(ageMs: number, createdAgeMs = ageMs): Promise<void> {
  await db()
    .insert(jobs)
    .values({
      type: "chat_scene_image",
      status: "running",
      ownerId: owner,
      payload: { chatId: CHAT },
      attempts: 1,
      createdAt: new Date(Date.now() - createdAgeMs),
      startedAt: new Date(Date.now() - createdAgeMs),
      heartbeatAt: new Date(Date.now() - ageMs),
    });
}

afterAll(async () => {
  if (ready) await purgeOwnerRows([owner]);
  await endTestPool();
});

describe.skipIf(!ready)("hasLiveChatJob", () => {
  beforeAll(async () => {
    owner = (await seedTestUser("job-liveness")).id;
  });

  beforeEach(clearJobs);

  it("reports no live job when the chat has none", async () => {
    expect(await hasLiveChatJob("chat_scene_image", CHAT)).toBe(false);
  });

  it("sees a fresh running job", async () => {
    await insertRunning(1_000);
    expect(await hasLiveChatJob("chat_scene_image", CHAT)).toBe(true);
  });

  it("ignores a job orphaned past the staleness bound", async () => {
    await insertRunning(JOB_STALE_MS + 60_000);
    expect(await hasLiveChatJob("chat_scene_image", CHAT)).toBe(false);
  });

  it("keeps an old job live while its heartbeat remains fresh", async () => {
    const before = await queueDepth();
    await insertRunning(1_000, JOB_STALE_MS + 60_000);
    expect(await hasLiveChatJob("chat_scene_image", CHAT)).toBe(true);
    expect(await queueDepth()).toBe(before + 1);
  });

  it("drops a recent-created job from queue depth after its heartbeat expires", async () => {
    const before = await queueDepth();
    await insertRunning(JOB_STALE_MS + 60_000, 1_000);
    expect(await queueDepth()).toBe(before);
  });

  it("is scoped by type and by chat", async () => {
    await insertRunning(1_000);
    expect(await hasLiveChatJob("chat_summary", CHAT)).toBe(false);
    expect(await hasLiveChatJob("chat_scene_image", "another-chat")).toBe(false);
  });

  it("ignores a settled job", async () => {
    await db()
      .insert(jobs)
      .values({
        type: "chat_scene_image",
        status: "done",
        ownerId: owner,
        payload: { chatId: CHAT },
        attempts: 1,
        finishedAt: new Date(),
      });
    expect(await hasLiveChatJob("chat_scene_image", CHAT)).toBe(false);
  });
});
