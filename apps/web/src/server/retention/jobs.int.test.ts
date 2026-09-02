import fs from "node:fs/promises";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, jobs } from "@/server/db";
import { deleteChat } from "@/server/engine";
import {
  emptyChatFixture,
  endTestPool,
  newChat,
  probeIntegrationDb,
  purgeOwnerRows,
  seedChatFixture,
  type ChatFixture,
} from "@/server/test-support";
import { JOB_RETENTION_DAYS, jobsExpired } from "./jobs";
import { RETENTION_BATCH_SIZE } from "./pass";

/**
 * The job row's LIFECYCLE, all three parts of which are database behavior no
 * pure test can prove (issue #196).
 *
 * 1. The migration's backfill runs here as the migration's own text, not as a
 *    paraphrase. The defect it kills is a backfill that scopes a job by whatever
 *    its payload claims: `jobs.chat_id` carries a foreign key, so a payload
 *    naming a chat that was deleted years ago would abort the whole migration —
 *    a deploy that fails on production history and succeeds on every fresh
 *    database anyone tests it against.
 * 2. The cascade is the point of the column. A job scoped to a chat must vanish
 *    with it, and only Postgres enforces that.
 * 3. The retention boundary, including the half that must NOT happen: a
 *    `queued`/`running` row is never deleted at any age. Deleting one would erase
 *    an orphan before `reclaimOrphanedJobs` could record what happened to it, and
 *    would miscount the per-user concurrency cap in the meantime.
 */

const ready = await probeIntegrationDb("retention jobs.int.test", "jobs");

const MIGRATION = path.join(process.cwd(), "drizzle", "0123_chat-scoped-jobs-events.sql");
const DAY_MS = 24 * 60 * 60_000;

let fixture: ChatFixture = emptyChatFixture();

/**
 * The migration's real backfill: the last statement of `0123`, taken as text so
 * this suite can never drift from what actually ran against the database.
 */
async function backfillStatement(): Promise<string> {
  const sqlText = await fs.readFile(MIGRATION, "utf8");
  const statements = sqlText.split("--> statement-breakpoint");
  const last = statements.at(-1)?.trim() ?? "";
  expect(last).toContain('UPDATE "jobs"');
  return last;
}

interface JobSeed {
  status: "queued" | "running" | "done" | "failed";
  /** How long ago the row was created; terminal rows also settle at that age. */
  ageMs: number;
  /** Written to the first-class column (and so subject to the foreign key). */
  chatId?: string;
  /** Written into the payload only — what the backfill has to read. */
  payloadChatId?: string;
}

async function seedJob(seed: JobSeed): Promise<string> {
  const at = new Date(Date.now() - seed.ageMs);
  const terminal = seed.status === "done" || seed.status === "failed";
  const [row] = await db()
    .insert(jobs)
    .values({
      type: "chat_summary",
      status: seed.status,
      ownerId: fixture.userId,
      payload: seed.payloadChatId === undefined ? {} : { chatId: seed.payloadChatId },
      attempts: 1,
      createdAt: at,
      startedAt: at,
      finishedAt: terminal ? at : null,
      chatId: seed.chatId ?? null,
    })
    .returning({ id: jobs.id });
  if (!row) throw new Error("failed to seed a job row");
  return row.id;
}

async function jobExists(id: string): Promise<boolean> {
  const rows = await db().select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).limit(1);
  return rows.length > 0;
}

/**
 * Run the pass until it stops filling a batch. The pass is deliberately bounded
 * per run, and a shared development database may already hold an unrelated
 * backlog of old terminal rows, so draining is what makes the assertions about
 * THIS suite's rows independent of whatever else is in the table.
 */
async function drainExpiredJobs(): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) {
    if ((await jobsExpired.run(new Date())) < RETENTION_BATCH_SIZE) return;
  }
}

afterAll(async () => {
  if (ready) await purgeOwnerRows([fixture.userId]);
  await endTestPool();
});

describe.skipIf(!ready)("chat-scoped jobs and terminal-job retention", () => {
  beforeAll(async () => {
    fixture = await seedChatFixture({ slug: "jobs-retention" });
  });

  beforeEach(async () => {
    await db().delete(jobs).where(inArray(jobs.ownerId, [fixture.userId]));
  });

  it("backfills only the payload chat ids that still name a live chat", async () => {
    const seat = await newChat(fixture);
    const live = await seedJob({ status: "done", ageMs: 60_000, payloadChatId: seat.chatId });
    const orphaned = await seedJob({ status: "done", ageMs: 60_000, payloadChatId: "chat-deleted-long-ago" });

    await db().execute(sql.raw(await backfillStatement()));

    const rows = await db()
      .select({ id: jobs.id, chatId: jobs.chatId })
      .from(jobs)
      .where(inArray(jobs.id, [live, orphaned]));
    expect(rows.find((row) => row.id === live)?.chatId).toBe(seat.chatId);
    expect(rows.find((row) => row.id === orphaned)?.chatId).toBeNull();
  });

  it("takes a chat's scoped jobs down with the chat", async () => {
    const seat = await newChat(fixture);
    const scoped = await seedJob({ status: "running", ageMs: 1_000, chatId: seat.chatId });
    const unscoped = await seedJob({ status: "running", ageMs: 1_000 });

    await deleteChat(seat.chatId, fixture.userId);

    expect(await jobExists(scoped)).toBe(false);
    expect(await jobExists(unscoped)).toBe(true);
  });

  it("expires terminal jobs past seven days and keeps everything else", async () => {
    const old = (JOB_RETENTION_DAYS + 1) * DAY_MS;
    const recent = (JOB_RETENTION_DAYS - 1) * DAY_MS;
    const oldDone = await seedJob({ status: "done", ageMs: old });
    const oldFailed = await seedJob({ status: "failed", ageMs: old });
    const recentDone = await seedJob({ status: "done", ageMs: recent });
    const oldQueued = await seedJob({ status: "queued", ageMs: old });
    const oldRunning = await seedJob({ status: "running", ageMs: old });

    await drainExpiredJobs();

    expect(await jobExists(oldDone)).toBe(false);
    expect(await jobExists(oldFailed)).toBe(false);
    expect(await jobExists(recentDone)).toBe(true);
    expect(await jobExists(oldQueued)).toBe(true);
    expect(await jobExists(oldRunning)).toBe(true);
  });
});
